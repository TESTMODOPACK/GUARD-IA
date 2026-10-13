import { Inject, Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';
import type {
  PlatformChangePassword,
  PlatformLoginStep,
  PlatformSession,
  PlatformUserPublic,
} from '@guardia/shared';
import { AppError } from '../common/app-error';
import { ENV, type Env } from '../config/env';
import { DbService } from '../db/db.service';
import { platformUser, type PlatformUserRow } from '../db/schema';
import { RateLimitService } from '../infra/rate-limit.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformTokensService } from './platform-tokens.service';
import { PlatformUserStatusService } from './platform.guard';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp';

/** 5 fallos seguidos (contraseña o código) bloquean la cuenta 15 minutos. */
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

// Verificación en tiempo constante aunque el correo no exista.
const DUMMY_HASH = argonHash('guardia-platform-dummy-password');

export function toPlatformUserPublic(u: PlatformUserRow): PlatformUserPublic {
  return { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword };
}

/**
 * Ingreso a la consola en dos pasos: contraseña y código TOTP. El primer ingreso (o tras un
 * restablecimiento) enrola el segundo factor: la API propone un secreto, lo guarda cifrado como pendiente y
 * solo lo activa cuando llega un código válido. Los fallos se cuentan en su propia transacción antes de
 * responder 401 (regla 4).
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly dbs: DbService,
    private readonly tokens: PlatformTokensService,
    private readonly audit: PlatformAuditService,
    private readonly status: PlatformUserStatusService,
    private readonly rate: RateLimitService,
  ) {}

  async login(email: string, password: string, ip: string): Promise<PlatformLoginStep> {
    const { box } = this.tokens.requireEnabled();
    await this.rate.hit(`plogin:${ip}:${email}`, this.env.RATE_LOGIN_PER_MINUTE, 60, 'Demasiados intentos de inicio de sesión');
    await this.rate.hit(`plogin:${email}`, this.env.RATE_LOGIN_PER_MINUTE * 3, 60, 'Demasiados intentos de inicio de sesión');

    const user = await this.dbs.asSystem(async (tx) => {
      const [u] = await tx.select().from(platformUser).where(eq(platformUser.email, email)).limit(1);
      return u ?? null;
    });
    const ok = await argonVerify(user?.passwordHash ?? (await DUMMY_HASH), password);
    if (user?.active) this.assertNotLocked(user);
    if (!user || !user.active || !ok) {
      if (user?.active) await this.registerFailure(user.id, ip, 'password');
      throw new AppError('UNAUTHORIZED', 'Credenciales inválidas');
    }

    if (user.totpEnabledAt) return { step: 'totp', challengeToken: this.tokens.signChallenge(user.id, false) };

    const secret = newTotpSecret();
    await this.dbs.asSystem((tx) =>
      tx.update(platformUser).set({ totpPendingEnc: box.seal(secret) }).where(eq(platformUser.id, user.id)),
    );
    return {
      step: 'enroll',
      challengeToken: this.tokens.signChallenge(user.id, true),
      secret,
      otpauthUri: otpauthUri(this.env.PLATFORM_TOTP_ISSUER, user.email, secret),
    };
  }

  async verifyCode(challengeToken: string, code: string, ip: string): Promise<PlatformSession> {
    const { box } = this.tokens.requireEnabled();
    const ch = this.tokens.verifyChallenge(challengeToken);
    await this.rate.hit(`ptotp:${ch.sub}`, MAX_FAILURES * 2, 300, 'Demasiados intentos; espera unos minutos');

    const user = await this.dbs.asSystem(async (tx) => {
      const [u] = await tx.select().from(platformUser).where(eq(platformUser.id, ch.sub)).limit(1);
      return u ?? null;
    });
    if (!user || !user.active) throw new AppError('UNAUTHORIZED', 'La cuenta no está disponible');
    this.assertNotLocked(user);
    const sealed = ch.enroll ? user.totpPendingEnc : user.totpSecretEnc;
    if (!sealed || (ch.enroll && user.totpEnabledAt)) {
      throw new AppError('UNAUTHORIZED', 'El ingreso venció; vuelve a escribir tu contraseña');
    }
    const step = verifyTotp(box.open(sealed), code, user.totpLastStep);
    if (step === null) {
      await this.registerFailure(user.id, ip, 'totp');
      throw new AppError('UNAUTHORIZED', 'Código incorrecto');
    }

    const out = await this.dbs.asSystem(async (tx) => {
      const [u] = await tx
        .update(platformUser)
        .set({
          failedAttempts: 0,
          lockedUntil: null,
          totpLastStep: step,
          lastLoginAt: new Date(),
          ...(ch.enroll ? { totpSecretEnc: sealed, totpPendingEnc: null, totpEnabledAt: new Date() } : {}),
        })
        .where(eq(platformUser.id, user.id))
        .returning();
      if (ch.enroll) await this.audit.record(tx, { actorId: u.id, action: 'TOTP_ENROLLED', targetId: u.id, ip });
      await this.audit.record(tx, { actorId: u.id, action: 'LOGIN', targetId: u.id, ip });
      const pair = await this.tokens.issueSession(tx, u, ip);
      return { ...pair, user: toPlatformUserPublic(u) };
    });
    this.status.invalidate(user.id);
    return out;
  }

  refresh(raw: string, ip: string) {
    return this.tokens.rotate(raw, ip, async (tx, userId) => {
      const [u] = await tx.select().from(platformUser).where(eq(platformUser.id, userId)).limit(1);
      if (!u || !u.active || (u.lockedUntil && u.lockedUntil > new Date())) return null;
      return u;
    });
  }

  async logout(raw: string, ip: string): Promise<void> {
    const userId = await this.tokens.revoke(raw);
    if (userId) {
      await this.dbs.asSystem((tx) => this.audit.record(tx, { actorId: userId, action: 'LOGOUT', targetId: userId, ip }));
    }
  }

  me(userId: string): Promise<PlatformUserPublic> {
    return this.dbs.asPlatform(userId, async (tx) => {
      const [u] = await tx.select().from(platformUser).where(eq(platformUser.id, userId)).limit(1);
      if (!u) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      return toPlatformUserPublic(u);
    });
  }

  async changeOwnPassword(userId: string, body: PlatformChangePassword, ip: string): Promise<PlatformUserPublic> {
    await this.rate.hit(`ppwd:${userId}`, 5, 300, 'Demasiados intentos; espera unos minutos');
    const me = await this.dbs.asPlatform(userId, async (tx) => {
      const [u] = await tx.select().from(platformUser).where(eq(platformUser.id, userId)).limit(1);
      return u ?? null;
    });
    if (!me) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
    // 400 y no 401: la sesión es válida; un 401 haría que la consola renueve tokens sin motivo.
    if (!(await argonVerify(me.passwordHash, body.currentPassword))) {
      throw new AppError('VALIDATION_ERROR', 'La contraseña actual no es correcta');
    }
    if (body.newPassword.toLowerCase().includes(me.email.split('@')[0].toLowerCase())) {
      throw new AppError('VALIDATION_ERROR', 'La contraseña no puede contener tu correo');
    }
    const passwordHash = await argonHash(body.newPassword);
    const out = await this.dbs.asPlatform(userId, async (tx) => {
      const [u] = await tx
        .update(platformUser)
        .set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date() })
        .where(eq(platformUser.id, userId))
        .returning();
      await this.audit.record(tx, { actorId: userId, action: 'PASSWORD_CHANGED', targetId: userId, ip });
      return toPlatformUserPublic(u);
    });
    this.status.invalidate(userId);
    return out;
  }

  private assertNotLocked(u: PlatformUserRow): void {
    if (u.lockedUntil && u.lockedUntil > new Date()) {
      const min = Math.max(1, Math.ceil((u.lockedUntil.getTime() - Date.now()) / 60_000));
      throw new AppError('RATE_LIMITED', `Cuenta bloqueada por intentos fallidos; intenta en ${min} min`, {
        retryAfterSeconds: min * 60,
      });
    }
  }

  /** Contador atómico en su propia transacción, antes del 401 (regla 4). Al quinto fallo, bloqueo. */
  private async registerFailure(userId: string, ip: string, step: 'password' | 'totp'): Promise<void> {
    await this.dbs.asSystem(async (tx) => {
      const [r] = await tx
        .update(platformUser)
        .set({
          failedAttempts: sql`CASE WHEN ${platformUser.failedAttempts} + 1 >= ${MAX_FAILURES} THEN 0 ELSE ${platformUser.failedAttempts} + 1 END`,
          lockedUntil: sql`CASE WHEN ${platformUser.failedAttempts} + 1 >= ${MAX_FAILURES}
                                THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE ${platformUser.lockedUntil} END`,
        })
        .where(eq(platformUser.id, userId))
        .returning({ lockedUntil: platformUser.lockedUntil });
      await this.audit.record(tx, { actorId: null, action: 'LOGIN_FAILED', targetId: userId, ip, payload: { step } });
      if (r?.lockedUntil && r.lockedUntil > new Date()) {
        await this.audit.record(tx, { actorId: null, action: 'LOCKED', targetId: userId, ip, payload: { minutes: LOCK_MINUTES } });
      }
    });
    this.status.invalidate(userId);
  }
}
