import { Injectable } from '@nestjs/common';
import { verify as argonVerify } from '@node-rs/argon2';
import { and, asc, count, eq, isNotNull, isNull, ne } from 'drizzle-orm';
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
import { operator, shift, tenant } from '../db/schema';
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
      return rows.map((r) => toAccount(r, online.has(r.id), onShift.has(r.id)));
    });
  }

  async create(op: OperatorClaims, body: CreateOperator): Promise<TemporaryPassword> {
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    try {
      const row = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
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
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'OPERATOR_CREATED',
          targetId: r.id,
          payload: { email: r.email, name: r.name, role: r.role },
        });
        return r;
      });
      return { operator: toAccount(row, false, false), temporaryPassword: temp };
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
    const { row, deactivated } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
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

      const [r] = await tx
        .update(operator)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        })
        .where(eq(operator.id, id))
        .returning();

      const changes: Record<string, [unknown, unknown]> = {};
      for (const k of ['name', 'role', 'active'] as const) {
        if (body[k] !== undefined && body[k] !== before[k]) changes[k] = [before[k], body[k]];
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
      return { row: r, deactivated };
    });

    this.status.invalidate(id);
    if (deactivated) await this.dbs.asSystem((tx) => this.tokens.revokeAllFor(tx, 'OPERATOR', id));
    const online = await this.realtime.connectedOperatorIds(op.tenantId);
    return toAccount(row, online.has(id), false);
  }

  async resetPassword(op: OperatorClaims, id: string): Promise<TemporaryPassword> {
    if (id === op.sub) throw new AppError('FORBIDDEN', 'Para tu propia cuenta usa "Cambiar contraseña"');
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    const row = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [r] = await tx.update(operator).set({ passwordHash, mustChangePassword: true }).where(eq(operator.id, id)).returning();
      if (!r) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      await this.audit.record(tx, { tenantId: op.tenantId, actorId: op.sub, kind: 'PASSWORD_RESET', targetId: id, payload: { email: r.email } });
      return r;
    });
    this.status.invalidate(id);
    // Las sesiones abiertas con la contraseña anterior se cierran.
    await this.dbs.asSystem((tx) => this.tokens.revokeAllFor(tx, 'OPERATOR', id));
    return { operator: toAccount(row, false, false), temporaryPassword: temp };
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
      const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, op.tenantId)).limit(1);
      return {
        id: r.id,
        tenantId: r.tenantId,
        tenantName: t?.name ?? '',
        email: r.email,
        name: r.name,
        role: r.role,
        mustChangePassword: false,
      } satisfies OperatorPublic;
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

function toAccount(r: OperatorRow, online: boolean, onShift: boolean): OperatorAccount {
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
  };
}

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}
