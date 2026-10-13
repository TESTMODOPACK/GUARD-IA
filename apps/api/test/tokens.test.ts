/**
 * Refresh tokens contra base real (pnpm test:db): vencimiento por tipo de sesión y cierre de sesión.
 */
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessClaims } from '@guardia/shared';
import { TokenService } from '../src/auth/token.service';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const HOUR = 3600_000;

d('refresh tokens', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let tokens: TokenService;
  // Sujetos ficticios: refresh_token no tiene FK, basta un uuid propio para limpiar al final.
  const operatorId = randomUUID();
  const citizenId = randomUUID();
  const operatorClaims: AccessClaims = { kind: 'operator', sub: operatorId, tenantId: randomUUID(), role: 'OPERATOR' };
  const citizenClaims: AccessClaims = { kind: 'citizen', sub: citizenId };
  const claimsFor = async (_tx: unknown, kind: 'CITIZEN' | 'OPERATOR') =>
    kind === 'OPERATOR' ? operatorClaims : citizenClaims;

  beforeAll(() => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    tokens = new TokenService(env, new JwtService(), dbs);
  });

  afterAll(async () => {
    await admin`DELETE FROM refresh_token WHERE subject_id IN (${operatorId}, ${citizenId})`;
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  /** Horas que le quedan al último refresh vigente del sujeto. */
  const hoursLeft = async (subject: string) => {
    const rows = await admin<{ expires_at: Date }[]>`
      SELECT expires_at FROM refresh_token WHERE subject_id = ${subject} AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`;
    expect(rows).toHaveLength(1);
    return (rows[0].expires_at.getTime() - Date.now()) / HOUR;
  };

  it('el refresh del operador dura un turno (13 h) y el del vecino 30 días', async () => {
    await dbs.asSystem((tx) => tokens.issuePair(tx, operatorClaims));
    await dbs.asSystem((tx) => tokens.issuePair(tx, citizenClaims));
    expect(await hoursLeft(operatorId)).toBeCloseTo(13, 0);
    expect(await hoursLeft(citizenId)).toBeCloseTo(30 * 24, 0);
  });

  it('logout revoca el refresh: ya no rota; repetirlo o usar un token desconocido no falla', async () => {
    const pair = await dbs.asSystem((tx) => tokens.issuePair(tx, operatorClaims));
    // Devuelve de quién era (la bitácora registra el LOGOUT del operador).
    await expect(tokens.revoke(pair.refreshToken)).resolves.toEqual({ kind: 'OPERATOR', subjectId: operatorId });
    await expect(tokens.rotate(pair.refreshToken, claimsFor)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(tokens.revoke(pair.refreshToken)).resolves.toBeNull();
    await expect(tokens.revoke('x'.repeat(64))).resolves.toBeNull();
  });

  it('el logout de una sesión no corta otra sesión vigente del mismo vecino', async () => {
    const a = await dbs.asSystem((tx) => tokens.issuePair(tx, citizenClaims));
    const b = await dbs.asSystem((tx) => tokens.issuePair(tx, citizenClaims));
    await tokens.revoke(a.refreshToken);
    const next = await tokens.rotate(b.refreshToken, claimsFor);
    expect(next.refreshToken).not.toBe(b.refreshToken);
  });
});
