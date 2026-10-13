import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import type {
  CreatePlatformUser,
  PlatformUserAccount,
  PlatformUserPassword,
  UpdatePlatformUser,
} from '@guardia/shared';
import { hashPassword, temporaryPassword } from '../admin/passwords';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { platformUser, type PlatformUserRow } from '../db/schema';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformTokensService, type PlatformClaims } from './platform-tokens.service';
import { PlatformUserStatusService } from './platform.guard';

export function toPlatformAccount(u: PlatformUserRow): PlatformUserAccount {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    totpEnabled: !!u.totpEnabledAt,
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === '23505';
}

/**
 * Equipo Guard-IA (RF-4.1). Solo el superadministrador administra cuentas. Alta y restablecimiento dan una
 * contraseña temporal y dejan el segundo factor por enrolar en el próximo ingreso. Siempre queda al menos un
 * superadministrador activo.
 */
@Injectable()
export class PlatformUsersService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: PlatformAuditService,
    private readonly status: PlatformUserStatusService,
    private readonly tokens: PlatformTokensService,
  ) {}

  list(user: PlatformClaims): Promise<PlatformUserAccount[]> {
    return this.dbs.asPlatform(user.sub, async (tx) =>
      (await tx.select().from(platformUser).orderBy(asc(platformUser.name))).map(toPlatformAccount),
    );
  }

  async create(user: PlatformClaims, body: CreatePlatformUser, ip: string): Promise<PlatformUserPassword> {
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    try {
      const row = await this.dbs.asPlatform(user.sub, async (tx) => {
        const [u] = await tx
          .insert(platformUser)
          .values({ email: body.email, name: body.name, role: body.role, passwordHash, mustChangePassword: true, createdBy: user.sub })
          .returning();
        await this.audit.record(tx, {
          actorId: user.sub,
          action: 'USER_CREATED',
          targetId: u.id,
          payload: { email: u.email, name: u.name, role: u.role },
          ip,
        });
        return u;
      });
      return { user: toPlatformAccount(row), temporaryPassword: temp };
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Ya existe una cuenta de plataforma con ese correo');
      throw e;
    }
  }

  async update(user: PlatformClaims, id: string, body: UpdatePlatformUser, ip: string): Promise<PlatformUserAccount> {
    if (id === user.sub && (body.role !== undefined || body.active === false)) {
      throw new AppError('FORBIDDEN', 'No puedes cambiar tu propio rol ni desactivar tu cuenta');
    }
    const { row, deactivated } = await this.dbs.asPlatform(user.sub, async (tx) => {
      const [before] = await tx.select().from(platformUser).where(eq(platformUser.id, id)).limit(1);
      if (!before) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      const losesSuper =
        before.role === 'SUPERADMIN' && before.active && ((body.role && body.role !== 'SUPERADMIN') || body.active === false);
      if (losesSuper && (await otherActiveSupers(tx, id)) === 0) {
        throw new AppError('CONFLICT', 'Debe quedar al menos un superadministrador activo');
      }
      const [r] = await tx
        .update(platformUser)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        })
        .where(eq(platformUser.id, id))
        .returning();
      const changes: Record<string, [unknown, unknown]> = {};
      for (const k of ['name', 'role', 'active'] as const) {
        if (body[k] !== undefined && body[k] !== before[k]) changes[k] = [before[k], body[k]];
      }
      if (Object.keys(changes).length) {
        await this.audit.record(tx, { actorId: user.sub, action: 'USER_UPDATED', targetId: id, payload: { email: r.email, changes }, ip });
      }
      return { row: r, deactivated: before.active && body.active === false };
    });
    this.status.invalidate(id);
    if (deactivated) await this.dbs.asSystem((tx) => this.tokens.revokeAllFor(tx, id));
    return toPlatformAccount(row);
  }

  /** Contraseña temporal nueva, segundo factor por enrolar de nuevo, desbloqueo y sesiones cerradas. */
  async reset(user: PlatformClaims, id: string, ip: string): Promise<PlatformUserPassword> {
    if (id === user.sub) throw new AppError('FORBIDDEN', 'Para tu propia cuenta usa "Cambiar contraseña"');
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    const row = await this.dbs.asPlatform(user.sub, async (tx) => {
      const [u] = await tx
        .update(platformUser)
        .set({
          passwordHash,
          mustChangePassword: true,
          totpSecretEnc: null,
          totpPendingEnc: null,
          totpEnabledAt: null,
          totpLastStep: null,
          failedAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(platformUser.id, id))
        .returning();
      if (!u) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      await this.audit.record(tx, { actorId: user.sub, action: 'USER_RESET', targetId: id, payload: { email: u.email }, ip });
      return u;
    });
    this.status.invalidate(id);
    await this.dbs.asSystem((tx) => this.tokens.revokeAllFor(tx, id));
    return { user: toPlatformAccount(row), temporaryPassword: temp };
  }
}

async function otherActiveSupers(tx: Tx, exceptId: string): Promise<number> {
  const [{ n }] = await tx
    .select({ n: count() })
    .from(platformUser)
    .where(and(eq(platformUser.role, 'SUPERADMIN'), eq(platformUser.active, true), ne(platformUser.id, exceptId)));
  return n;
}
