import { Injectable } from '@nestjs/common';
import { verify as argonVerify } from '@node-rs/argon2';
import { and, asc, count, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type {
  ChangePassword,
  CreateOperator,
  OperatorAccount,
  OperatorPublic,
  TemporaryPassword,
  UpdateOperator,
} from '@guardia/shared';
import { AuditService } from '../auth/audit.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { OperatorStatusService } from '../auth/operator-status.service';
import { TokenService } from '../auth/token.service';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { area, operator, operatorArea, shift, tenant } from '../db/schema';
import { loadOperatorScope } from '../areas/area-scope';
import { RateLimitService } from '../infra/rate-limit.service';
import { RealtimeService } from '../realtime/realtime.service';
import { hashPassword, temporaryPassword } from './passwords';

type OperatorRow = typeof operator.$inferSelect;

/**
 * Cuentas de la central del municipio. Las escrituras corren en contexto operator (RLS: solo su
 * tenant); el rol lo exige el controlador. Cerrar sesiones toca refresh_token, que solo existe en
 * contexto system: va después del commit, y aunque fallara, el guard y el refresh ya rechazan una
 * cuenta desactivada.
 */
@Injectable()
export class OperatorsService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly status: OperatorStatusService,
    private readonly tokens: TokenService,
    private readonly rate: RateLimitService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(op: OperatorClaims): Promise<OperatorAccount[]> {
    const online = await this.realtime.connectedOperatorIds(op.tenantId);
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const rows = await tx.select().from(operator).where(eq(operator.tenantId, op.tenantId)).orderBy(asc(operator.name));
      const onShift = await openShiftOperatorIds(tx, op.tenantId);
      const areas = await areaIdsByOperator(tx, op.tenantId);
      return rows.map((r) => toAccount(r, online.has(r.id), onShift.has(r.id), areas.get(r.id) ?? []));
    });
  }

  async create(op: OperatorClaims, body: CreateOperator): Promise<TemporaryPassword> {
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    try {
      const row = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
        // Municipio suspendido (RF-3.5): el SOS y la central siguen; lo no crítico, como cuentas nuevas, no.
        const [t] = await tx.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, op.tenantId)).limit(1);
        if (t?.status === 'SUSPENDED') {
          throw new AppError('FORBIDDEN', 'El municipio está suspendido: no se pueden crear cuentas nuevas. Contacta a Guard-IA');
        }
        const [r] = await tx
          .insert(operator)
          .values({
            tenantId: op.tenantId,
            email: body.email,
            name: body.name,
            role: body.role,
            passwordHash,
            mustChangePassword: true,
            createdBy: op.sub,
          })
          .returning();
        const areaIds = await setOperatorAreas(tx, op.tenantId, r.id, body.areaIds ?? []);
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'OPERATOR_CREATED',
          targetId: r.id,
          payload: { email: r.email, name: r.name, role: r.role, areaIds },
        });
        return { ...r, areaIds };
      });
      return { operator: toAccount(row, false, false, row.areaIds), temporaryPassword: temp };
    } catch (e) {
      // El email es único en todo el sistema (un operador pertenece a un solo municipio).
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Ya existe una cuenta con ese correo');
      throw e;
    }
  }

  async update(op: OperatorClaims, id: string, body: UpdateOperator): Promise<OperatorAccount> {
    if (id === op.sub && (body.role !== undefined || body.active === false)) {
      throw new AppError('FORBIDDEN', 'No puedes cambiar tu propio rol ni desactivar tu cuenta');
    }
    const { row, deactivated, scopeChanged, areaIds } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [before] = await tx.select().from(operator).where(eq(operator.id, id)).limit(1);
      if (!before) throw new AppError('NOT_FOUND', 'Usuario no encontrado');

      const losesAdmin = before.role === 'ADMIN' && before.active && ((body.role && body.role !== 'ADMIN') || body.active === false);
      if (losesAdmin) {
        const [{ n }] = await tx
          .select({ n: count() })
          .from(operator)
          .where(and(eq(operator.role, 'ADMIN'), eq(operator.active, true), ne(operator.id, id)));
        if (n === 0) throw new AppError('CONFLICT', 'El municipio debe tener al menos un administrador activo');
      }

      const set = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      };
      // Solo áreas: no hay columnas que tocar en operator.
      const [r] = Object.keys(set).length ? await tx.update(operator).set(set).where(eq(operator.id, id)).returning() : [before];

      const changes: Record<string, [unknown, unknown]> = {};
      for (const k of ['name', 'role', 'active'] as const) {
        if (body[k] !== undefined && body[k] !== before[k]) changes[k] = [before[k], body[k]];
      }
      // Áreas (0013): se reemplazan completas; quedan en la bitácora con el antes y el después.
      const beforeAreas = (await areaIdsByOperator(tx, op.tenantId, [id])).get(id) ?? [];
      let areaIds = beforeAreas;
      if (body.areaIds !== undefined) {
        areaIds = await setOperatorAreas(tx, op.tenantId, id, body.areaIds);
        if ([...beforeAreas].sort().join() !== [...areaIds].sort().join()) changes.areaIds = [beforeAreas, areaIds];
      }
      const deactivated = before.active && body.active === false;
      if (deactivated) {
        // Un turno abierto no puede quedar colgado de una cuenta que ya no entra.
        await tx
          .update(shift)
          .set({ endedAt: new Date(), handoverNote: 'Turno cerrado al desactivar la cuenta.' })
          .where(and(eq(shift.operatorId, id), isNotNull(shift.startedAt), isNull(shift.endedAt)));
      }
      if (Object.keys(changes).length) {
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'OPERATOR_UPDATED',
          targetId: id,
          payload: { email: r.email, changes },
        });
      }
      return { row: r, deactivated, scopeChanged: !!changes.areaIds || !!changes.role, areaIds };
    });

    this.status.invalidate(id);
    // Cambió lo que ve: su socket vuelve a conectarse y entra a las rooms nuevas (y su central relee /ops/me).
    if (scopeChanged) await this.realtime.reconnectOperators(op.tenantId, [id]);
    if (deactivated) await this.dbs.asSystem((tx) => this.tokens.revokeAllFor(tx, 'OPERATOR', id));
    const online = await this.realtime.connectedOperatorIds(op.tenantId);
    return toAccount(row, online.has(id), false, areaIds);
  }

  async resetPassword(op: OperatorClaims, id: string): Promise<TemporaryPassword> {
    if (id === op.sub) throw new AppError('FORBIDDEN', 'Para tu propia cuenta usa "Cambiar contraseña"');
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    const row = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [r] = await tx.update(operator).set({ passwordHash, mustChangePassword: true }).where(eq(operator.id, id)).returning();
      if (!r) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      await this.audit.record(tx, { tenantId: op.tenantId, actorId: op.sub, kind: 'PASSWORD_RESET', targetId: id, payload: { email: r.email } });
      return { ...r, areaIds: (await areaIdsByOperator(tx, op.tenantId, [id])).get(id) ?? [] };
    });
    this.status.invalidate(id);
    // Las sesiones abiertas con la contraseña anterior se cierran.
    await this.dbs.asSystem((tx) => this.tokens.revokeAllFor(tx, 'OPERATOR', id));
    return { operator: toAccount(row, false, false, row.areaIds), temporaryPassword: temp };
  }

  /** La cuenta propia con sus áreas (0013): la central la relee al abrir y al reconectar. */
  me(op: OperatorClaims): Promise<OperatorPublic> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [r] = await tx.select().from(operator).where(eq(operator.id, op.sub)).limit(1);
      if (!r) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      return toPublic(tx, r);
    });
  }

  /** El propio operador cambia su contraseña (obligatorio si es temporal). Mantiene la sesión actual. */
  async changeOwnPassword(op: OperatorClaims, body: ChangePassword): Promise<OperatorPublic> {
    await this.rate.hit(`pwd:${op.sub}`, 5, 300, 'Demasiados intentos; espera unos minutos');
    const me = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [r] = await tx.select().from(operator).where(eq(operator.id, op.sub)).limit(1);
      return r ?? null;
    });
    if (!me) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
    if (!(await argonVerify(me.passwordHash, body.currentPassword))) {
      throw new AppError('UNAUTHORIZED', 'La contraseña actual no es correcta');
    }
    if (body.newPassword.toLowerCase().includes(me.email.split('@')[0].toLowerCase())) {
      throw new AppError('VALIDATION_ERROR', 'La contraseña no puede contener tu correo');
    }
    const passwordHash = await hashPassword(body.newPassword);
    const out = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [r] = await tx
        .update(operator)
        .set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date() })
        .where(eq(operator.id, op.sub))
        .returning();
      await this.audit.record(tx, { tenantId: op.tenantId, actorId: op.sub, kind: 'PASSWORD_CHANGED', targetId: op.sub });
      return toPublic(tx, r);
    });
    this.status.invalidate(op.sub);
    return out;
  }
}

export async function openShiftOperatorIds(tx: Tx, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ operatorId: shift.operatorId })
    .from(shift)
    .where(and(eq(shift.tenantId, tenantId), isNotNull(shift.startedAt), isNull(shift.endedAt)));
  return new Set(rows.map((r) => r.operatorId));
}

async function toPublic(tx: Tx, r: OperatorRow): Promise<OperatorPublic> {
  const [t] = await tx.select({ name: tenant.name, status: tenant.status }).from(tenant).where(eq(tenant.id, r.tenantId)).limit(1);
  const scope = await loadOperatorScope(tx, { id: r.id, tenantId: r.tenantId, role: r.role });
  return {
    id: r.id,
    tenantId: r.tenantId,
    tenantName: t?.name ?? '',
    email: r.email,
    name: r.name,
    role: r.role,
    mustChangePassword: r.mustChangePassword,
    tenantStatus: t?.status ?? 'ACTIVE',
    areas: scope.areas,
    seesAll: scope.seesAll,
  };
}

/** Áreas de cada cuenta del municipio (o de las indicadas). */
async function areaIdsByOperator(tx: Tx, tenantId: string, ids?: string[]): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ operatorId: operatorArea.operatorId, areaId: operatorArea.areaId })
    .from(operatorArea)
    .where(and(eq(operatorArea.tenantId, tenantId), ids ? inArray(operatorArea.operatorId, ids) : undefined));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.operatorId, [...(map.get(r.operatorId) ?? []), r.areaId]);
  return map;
}

/** Reemplaza las áreas de una cuenta; solo áreas activas del mismo municipio. */
async function setOperatorAreas(tx: Tx, tenantId: string, operatorId: string, areaIds: string[]): Promise<string[]> {
  const wanted = [...new Set(areaIds)];
  if (wanted.length) {
    const found = await tx
      .select({ id: area.id })
      .from(area)
      .where(and(eq(area.tenantId, tenantId), eq(area.active, true), inArray(area.id, wanted)));
    if (found.length !== wanted.length) throw new AppError('VALIDATION_ERROR', 'Alguna de las áreas no existe o está desactivada');
  }
  await tx.delete(operatorArea).where(eq(operatorArea.operatorId, operatorId));
  if (wanted.length) await tx.insert(operatorArea).values(wanted.map((areaId) => ({ operatorId, areaId, tenantId })));
  return wanted;
}

function toAccount(r: OperatorRow, online: boolean, onShift: boolean, areaIds: string[]): OperatorAccount {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    active: r.active,
    mustChangePassword: r.mustChangePassword,
    lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    online,
    onShift,
    areaIds,
  };
}

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}
