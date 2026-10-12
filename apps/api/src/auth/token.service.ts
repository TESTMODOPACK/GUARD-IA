import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { AccessClaimsSchema, type AccessClaims, type TokenPair } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { ENV, type Env } from '../config/env';
import { DbService, type Tx } from '../db/db.service';
import { refreshToken } from '../db/schema';

type TokenKind = 'CITIZEN' | 'OPERATOR';

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly dbs: DbService,
  ) {}

  private accessTtl(claims: AccessClaims): number {
    return claims.kind === 'operator'
      ? this.env.JWT_OPERATOR_ACCESS_TTL_SECONDS
      : this.env.JWT_ACCESS_TTL_SECONDS;
  }

  signAccess(claims: AccessClaims): { token: string; expiresIn: number } {
    const expiresIn = this.accessTtl(claims);
    const token = this.jwt.sign(claims, {
      secret: this.env.JWT_ACCESS_SECRET,
      expiresIn,
      issuer: 'guard-ia',
    });
    return { token, expiresIn };
  }

  verifyAccess(token: string): AccessClaims {
    let payload: unknown;
    try {
      payload = this.jwt.verify(token, { secret: this.env.JWT_ACCESS_SECRET, issuer: 'guard-ia' });
    } catch {
      throw new AppError('UNAUTHORIZED', 'Token inválido o expirado');
    }
    const parsed = AccessClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new AppError('UNAUTHORIZED', 'Token con claims inválidos');
    return parsed.data;
  }

  /** Emite access + refresh (refresh persistido por hash) dentro de la transacción dada. */
  async issuePair(tx: Tx, claims: AccessClaims, replaces?: string): Promise<TokenPair & { refreshId: string }> {
    const { token: accessToken, expiresIn } = this.signAccess(claims);
    const raw = randomBytes(48).toString('base64url');
    const [row] = await tx
      .insert(refreshToken)
      .values({
        kind: claims.kind === 'citizen' ? 'CITIZEN' : 'OPERATOR',
        subjectId: claims.sub,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + this.env.JWT_REFRESH_TTL_SECONDS * 1000),
      })
      .returning({ id: refreshToken.id });
    if (replaces) {
      await tx
        .update(refreshToken)
        .set({ revokedAt: new Date(), replacedBy: row.id })
        .where(eq(refreshToken.id, replaces));
    }
    return { accessToken, refreshToken: raw, expiresIn, refreshId: row.id };
  }

  /**
   * Rotación: valida el refresh, lo revoca y emite un par nuevo.
   * Reutilizar un refresh ya rotado revoca toda la familia del sujeto (posible robo).
   * La revocación se confirma en su propia transacción ANTES de lanzar el error:
   * un throw dentro de la transacción la revertiría y no revocaría nada.
   */
  async rotate(
    raw: string,
    buildClaims: (tx: Tx, kind: TokenKind, subjectId: string) => Promise<AccessClaims>,
  ): Promise<TokenPair> {
    const tokenHash = hash(raw);
    const row = await this.dbs.asSystem(async (tx) => {
      const [r] = await tx.select().from(refreshToken).where(eq(refreshToken.tokenHash, tokenHash)).limit(1);
      return r ?? null;
    });
    if (!row) throw new AppError('UNAUTHORIZED', 'Refresh token desconocido');

    if (row.revokedAt) {
      const revoked = await this.dbs.asSystem(async (tx) => {
        const rows = await tx
          .update(refreshToken)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshToken.subjectId, row.subjectId), isNull(refreshToken.revokedAt)))
          .returning({ id: refreshToken.id });
        return rows.length;
      });
      this.logger.warn(`refresh reutilizado para ${row.kind} ${row.subjectId}: ${revoked} sesiones revocadas`);
      throw new AppError('UNAUTHORIZED', 'Refresh token reutilizado; sesiones revocadas');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new AppError('UNAUTHORIZED', 'Refresh token expirado');
    }

    return this.dbs.asSystem(async (tx) => {
      // Re-chequeo bajo bloqueo: dos rotaciones simultáneas del mismo token → una gana.
      const [locked] = await tx
        .select({ revokedAt: refreshToken.revokedAt })
        .from(refreshToken)
        .where(eq(refreshToken.id, row.id))
        .for('update')
        .limit(1);
      if (!locked || locked.revokedAt) throw new AppError('UNAUTHORIZED', 'Refresh token ya rotado');
      const claims = await buildClaims(tx, row.kind, row.subjectId);
      const { refreshId: _id, ...pair } = await this.issuePair(tx, claims, row.id);
      return pair;
    });
  }
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
