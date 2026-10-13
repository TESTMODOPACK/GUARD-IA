import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PLATFORM_ROLES, UuidSchema, type PlatformRole } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { ENV, type Env } from '../config/env';
import { DbService, type Tx } from '../db/db.service';
import { platformSession } from '../db/schema';
import { SecretBox } from './totp';

const ISSUER = 'guard-ia-platform';

const PlatformClaimsSchema = z.object({
  kind: z.literal('platform'),
  sub: UuidSchema,
  role: z.enum(PLATFORM_ROLES),
});
export type PlatformClaims = z.infer<typeof PlatformClaimsSchema>;

/** Entre la contraseña y el código: 5 minutos, sirve solo para el paso del segundo factor. */
const ChallengeSchema = z.object({
  kind: z.literal('platform-mfa'),
  sub: UuidSchema,
  enroll: z.boolean(),
});
type Challenge = z.infer<typeof ChallengeSchema>;
const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Tokens de la consola, separados de los de vecinos y operadores: otro secreto (PLATFORM_JWT_SECRET), otro
 * emisor y otra tabla de sesiones. Un token de operador nunca abre la consola ni al revés.
 * La sesión rota el refresh en cada uso, vence a los 30 min sin uso y a las 8 h del ingreso pase lo que pase.
 */
@Injectable()
export class PlatformTokensService {
  private readonly logger = new Logger(PlatformTokensService.name);
  readonly box: SecretBox | null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly dbs: DbService,
  ) {
    this.box = env.PLATFORM_ENCRYPTION_KEY ? new SecretBox(env.PLATFORM_ENCRYPTION_KEY) : null;
  }

  get enabled(): boolean {
    return Boolean(this.env.PLATFORM_JWT_SECRET && this.box);
  }

  /** Sin configuración la consola no existe (desarrollo): 404, no 500. */
  requireEnabled(): { secret: string; box: SecretBox } {
    if (!this.env.PLATFORM_JWT_SECRET || !this.box) throw new AppError('NOT_FOUND', 'Consola de plataforma no configurada');
    return { secret: this.env.PLATFORM_JWT_SECRET, box: this.box };
  }

  signAccess(sub: string, role: PlatformRole): { token: string; expiresIn: number } {
    const { secret } = this.requireEnabled();
    const expiresIn = this.env.PLATFORM_ACCESS_TTL_SECONDS;
    const claims: PlatformClaims = { kind: 'platform', sub, role };
    return { token: this.jwt.sign(claims, { secret, expiresIn, issuer: ISSUER, audience: 'platform' }), expiresIn };
  }

  verifyAccess(token: string): PlatformClaims {
    const { secret } = this.requireEnabled();
    let payload: unknown;
    try {
      payload = this.jwt.verify(token, { secret, issuer: ISSUER, audience: 'platform' });
    } catch {
      throw new AppError('UNAUTHORIZED', 'Token inválido o expirado');
    }
    const parsed = PlatformClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new AppError('UNAUTHORIZED', 'Token con claims inválidos');
    return parsed.data;
  }

  signChallenge(sub: string, enroll: boolean): string {
    const { secret } = this.requireEnabled();
    const c: Challenge = { kind: 'platform-mfa', sub, enroll };
    return this.jwt.sign(c, { secret, expiresIn: CHALLENGE_TTL_SECONDS, issuer: ISSUER, audience: 'platform-mfa' });
  }

  verifyChallenge(token: string): Challenge {
    const { secret } = this.requireEnabled();
    let payload: unknown;
    try {
      payload = this.jwt.verify(token, { secret, issuer: ISSUER, audience: 'platform-mfa' });
    } catch {
      throw new AppError('UNAUTHORIZED', 'El ingreso venció; vuelve a escribir tu contraseña');
    }
    const parsed = ChallengeSchema.safeParse(payload);
    if (!parsed.success) throw new AppError('UNAUTHORIZED', 'El ingreso venció; vuelve a escribir tu contraseña');
    return parsed.data;
  }

  /** Abre (o continúa, con `startedAt` heredado) una sesión dentro de la transacción dada. */
  async issueSession(
    tx: Tx,
    user: { id: string; role: PlatformRole },
    ip: string | null,
    cont?: { replaces: string; startedAt: Date },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const { token: accessToken, expiresIn } = this.signAccess(user.id, user.role);
    const raw = randomBytes(48).toString('base64url');
    const now = Date.now();
    const startedAt = cont?.startedAt ?? new Date(now);
    const hardEnd = startedAt.getTime() + this.env.PLATFORM_SESSION_MAX_SECONDS * 1000;
    const expiresAt = new Date(Math.min(now + this.env.PLATFORM_SESSION_IDLE_SECONDS * 1000, hardEnd));
    const [row] = await tx
      .insert(platformSession)
      .values({ userId: user.id, tokenHash: hash(raw), startedAt, expiresAt, ip })
      .returning({ id: platformSession.id });
    if (cont) {
      await tx
        .update(platformSession)
        .set({ revokedAt: new Date(), replacedBy: row.id })
        .where(eq(platformSession.id, cont.replaces));
    }
    return { accessToken, refreshToken: raw, expiresIn };
  }

  /**
   * Rotación. Reutilizar un refresh ya rotado cierra todas las sesiones del usuario (posible robo); esa
   * revocación se confirma en su propia transacción antes del error (regla 4).
   */
  async rotate(
    raw: string,
    ip: string | null,
    loadUser: (tx: Tx, userId: string) => Promise<{ id: string; role: PlatformRole } | null>,
  ) {
    this.requireEnabled();
    const tokenHash = hash(raw);
    const row = await this.dbs.asSystem(async (tx) => {
      const [r] = await tx.select().from(platformSession).where(eq(platformSession.tokenHash, tokenHash)).limit(1);
      return r ?? null;
    });
    if (!row) throw new AppError('UNAUTHORIZED', 'Sesión desconocida');
    if (row.revokedAt) {
      await this.dbs.asSystem((tx) => this.revokeAllFor(tx, row.userId));
      this.logger.warn(`refresh de plataforma reutilizado por ${row.userId}: sesiones cerradas`);
      throw new AppError('UNAUTHORIZED', 'Sesión reutilizada; se cerraron todas tus sesiones');
    }
    if (row.expiresAt.getTime() <= Date.now()) throw new AppError('UNAUTHORIZED', 'La sesión venció');

    return this.dbs.asSystem(async (tx) => {
      const [locked] = await tx
        .select({ revokedAt: platformSession.revokedAt })
        .from(platformSession)
        .where(eq(platformSession.id, row.id))
        .for('update')
        .limit(1);
      if (!locked || locked.revokedAt) throw new AppError('UNAUTHORIZED', 'Sesión ya renovada');
      const user = await loadUser(tx, row.userId);
      if (!user) throw new AppError('UNAUTHORIZED', 'Cuenta no disponible');
      return this.issueSession(tx, user, ip, { replaces: row.id, startedAt: row.startedAt });
    });
  }

  /** Cierre de sesión: idempotente y silencioso. Devuelve el usuario si había una sesión viva. */
  async revoke(raw: string): Promise<string | null> {
    if (!this.enabled) return null;
    const rows = await this.dbs.asSystem((tx) =>
      tx
        .update(platformSession)
        .set({ revokedAt: new Date() })
        .where(and(eq(platformSession.tokenHash, hash(raw)), isNull(platformSession.revokedAt)))
        .returning({ userId: platformSession.userId }),
    );
    return rows[0]?.userId ?? null;
  }

  /** Contexto system (la tabla de sesiones solo existe ahí). */
  async revokeAllFor(tx: Tx, userId: string): Promise<void> {
    await tx
      .update(platformSession)
      .set({ revokedAt: new Date() })
      .where(and(eq(platformSession.userId, userId), isNull(platformSession.revokedAt)));
  }
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
