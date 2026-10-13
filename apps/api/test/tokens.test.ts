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
  // Desde 0009 el refresh token tiene FK a su dueño: el operador y el vecino existen de verdad.
  let tenantId = '';
  let operatorId = '';
  let citizenId = '';
  let operatorClaims: AccessClaims;
  let citizenClaims: AccessClaims;
  const suffix = randomUUID().slice(0, 8);
  const claimsFor = async (_tx: unknown, kind: 'CITIZEN' | 'OPERATOR') =>
    kind === 'OPERATOR' ? operatorClaims : citizenClaims;

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    tokens = new TokenService(env, new JwtService(), dbs);
    const box = JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[80, 80], [81, 80], [81, 81], [80, 81], [80, 80]]]] });
    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary) VALUES ('Tokens', ${'tok-test-' + suffix}, ST_GeomFromGeoJSON(${box})::geography) RETURNING id`;
    tenantId = t.id;
    const [o] = await admin<{ id: string }[]>`
      INSERT INTO operator (tenant_id, email, password_hash, name) VALUES (${tenantId}, ${'tok-' + suffix + '@test.cl'}, 'x', 'Tok') RETURNING id`;
    operatorId = o.id;
    const [c] = await admin<{ id: string }[]>`
      INSERT INTO citizen (phone) VALUES (${'+5694' + String(Date.now()).slice(-7)}) RETURNING id`;
    citizenId = c.id;
    operatorClaims = { kind: 'operator', sub: operatorId, tenantId, role: 'OPERATOR' };
    citizenClaims = { kind: 'citizen', sub: citizenId };
  });

  afterAll(async () => {
    await admin`DELETE FROM refresh_token WHERE subject_id IN (${operatorId}, ${citizenId})`;
    if (operatorId) await admin`DELETE FROM operator WHERE id = ${operatorId}`;
    if (citizenId) await admin`DELETE FROM citizen WHERE id = ${citizenId}`;
    if (tenantId) await admin`DELETE FROM tenant WHERE id = ${tenantId}`;
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
