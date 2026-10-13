/**
 * Administración de la central contra base real (pnpm test:db): usuarios, turnos, contactos y
 * bitácora (migración 0003). Dos municipios para probar que nada cruza de uno a otro.
 */
import { JwtService } from '@nestjs/jwt';
import { verify as argonVerify } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContactsService } from '../src/admin/contacts.service';
import { OperatorsService } from '../src/admin/operators.service';
import { ShiftsService } from '../src/admin/shifts.service';
import { StatsService } from '../src/admin/stats.service';
import { AuditService } from '../src/auth/audit.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { OperatorStatusService } from '../src/auth/operator-status.service';
import { TokenService } from '../src/auth/token.service';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import type { RateLimitService } from '../src/infra/rate-limit.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const box = (x: number) =>
  JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[x, x], [x + 1, x], [x + 1, x + 1], [x, x + 1], [x, x]]]] });

d('administración de la central', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let operators: OperatorsService;
  let shifts: ShiftsService;
  let contacts: ContactsService;
  let stats: StatsService;
  let status: OperatorStatusService;
  let tokens: TokenService;
  let tenantA: string;
  let tenantB: string;
  let adminA: OperatorClaims;
  let adminB: OperatorClaims;
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    const audit = new AuditService();
    status = new OperatorStatusService(dbs);
    tokens = new TokenService(env, new JwtService(), dbs);
    const realtime = { connectedOperatorIds: async () => new Set<string>() } as unknown as RealtimeService;
    const rate = { hit: async () => undefined } as unknown as RateLimitService;
    operators = new OperatorsService(dbs, audit, status, tokens, rate, realtime);
    shifts = new ShiftsService(dbs, audit);
    contacts = new ContactsService(dbs, audit);
    stats = new StatsService(dbs, realtime);

    const [a] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary) VALUES ('Adm A', ${'adm-test-a-' + suffix}, ST_GeomFromGeoJSON(${box(30)})::geography) RETURNING id`;
    const [b] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary) VALUES ('Adm B', ${'adm-test-b-' + suffix}, ST_GeomFromGeoJSON(${box(40)})::geography) RETURNING id`;
    tenantA = a.id;
    tenantB = b.id;
    const [oa] = await admin<{ id: string }[]>`
      INSERT INTO operator (tenant_id, email, password_hash, name, role) VALUES (${tenantA}, ${'adm-a-' + suffix + '@test.cl'}, 'x', 'Admin A', 'ADMIN') RETURNING id`;
    const [ob] = await admin<{ id: string }[]>`
      INSERT INTO operator (tenant_id, email, password_hash, name, role) VALUES (${tenantB}, ${'adm-b-' + suffix + '@test.cl'}, 'x', 'Admin B', 'ADMIN') RETURNING id`;
    adminA = { kind: 'operator', sub: oa.id, tenantId: tenantA, role: 'ADMIN' };
    adminB = { kind: 'operator', sub: ob.id, tenantId: tenantB, role: 'ADMIN' };
  });

  afterAll(async () => {
    if (tenantA) {
      const ids = [tenantA, tenantB];
      await admin`DELETE FROM audit_log WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM shift WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM contact WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM refresh_token WHERE subject_id IN (SELECT id FROM operator WHERE tenant_id IN ${admin(ids)})`;
      await admin`UPDATE operator SET created_by = NULL WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM operator WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM tenant WHERE id IN ${admin(ids)}`;
    }
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('crea un usuario con contraseña temporal obligatoria de cambiar y lo registra en la bitácora', async () => {
    const res = await operators.create(adminA, { email: `op-${suffix}@test.cl`, name: 'Operadora Uno', role: 'OPERATOR' });
    expect(res.temporaryPassword).toMatch(/^[A-Za-z2-9]{14}$/);
    expect(res.operator.mustChangePassword).toBe(true);
    const [row] = await admin<{ password_hash: string; tenant_id: string }[]>`SELECT password_hash, tenant_id FROM operator WHERE id = ${res.operator.id}`;
    expect(row.tenant_id).toBe(tenantA);
    expect(await argonVerify(row.password_hash, res.temporaryPassword)).toBe(true);
    const [log] = await admin<{ kind: string; actor_id: string }[]>`SELECT kind, actor_id FROM audit_log WHERE target_id = ${res.operator.id}`;
    expect(log).toEqual({ kind: 'OPERATOR_CREATED', actor_id: adminA.sub });

    await expect(operators.create(adminB, { email: `op-${suffix}@test.cl`, name: 'Otra', role: 'OPERATOR' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('el administrador de un municipio no ve ni toca usuarios de otro', async () => {
    const listB = await operators.list(adminB);
    expect(listB.map((o) => o.id)).toEqual([adminB.sub]);
    await expect(operators.update(adminB, adminA.sub, { name: 'Hackeado' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(operators.resetPassword(adminB, adminA.sub)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('protege al último administrador y no deja desactivarse a sí mismo', async () => {
    await expect(operators.update(adminA, adminA.sub, { active: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await operators.create(adminA, { email: `adm2-${suffix}@test.cl`, name: 'Admin Dos', role: 'ADMIN' });
    // Con dos admins, se puede bajar a uno; al quedar uno, ya no.
    await operators.update(adminA, other.operator.id, { role: 'SUPERVISOR' });
    const supA: OperatorClaims = { ...adminA, sub: other.operator.id, role: 'ADMIN' };
    await expect(operators.update(supA, adminA.sub, { role: 'OPERATOR' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('desactivar cierra sesiones, cierra su turno y el guard lo ve al instante', async () => {
    const u = await operators.create(adminA, { email: `op2-${suffix}@test.cl`, name: 'Operador Dos', role: 'OPERATOR' });
    const claims: OperatorClaims = { kind: 'operator', sub: u.operator.id, tenantId: tenantA, role: 'OPERATOR' };
    await dbs.asSystem((tx) => tokens.issuePair(tx, claims));
    await shifts.start(claims);
    expect((await status.get(u.operator.id))?.active).toBe(true);

    await operators.update(adminA, u.operator.id, { active: false });
    expect((await status.get(u.operator.id))?.active).toBe(false);
    const [{ open }] = await admin<{ open: number }[]>`
      SELECT count(*)::int AS open FROM refresh_token WHERE subject_id = ${u.operator.id} AND revoked_at IS NULL`;
    expect(open).toBe(0);
    const [s] = await admin<{ ended_at: Date | null }[]>`SELECT ended_at FROM shift WHERE operator_id = ${u.operator.id}`;
    expect(s.ended_at).not.toBeNull();
  });

  it('turnos: programar, iniciar el programado, entrega al terminar y un solo turno abierto', async () => {
    const u = await operators.create(adminA, { email: `op3-${suffix}@test.cl`, name: 'Operadora Tres', role: 'OPERATOR' });
    const claims: OperatorClaims = { kind: 'operator', sub: u.operator.id, tenantId: tenantA, role: 'OPERATOR' };
    const start = new Date(Date.now() + 30 * 60_000);
    const planned = await shifts.create(adminA, {
      operatorId: u.operator.id,
      plannedStart: start.toISOString(),
      plannedEnd: new Date(start.getTime() + 8 * 3600_000).toISOString(),
    });
    await expect(
      shifts.create(adminA, {
        operatorId: u.operator.id,
        plannedStart: start.toISOString(),
        plannedEnd: new Date(start.getTime() + 3600_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const started = await shifts.start(claims);
    expect(started.id).toBe(planned.id); // tomó el programado (empieza en 30 min)
    await expect(shifts.start(claims)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(shifts.remove(adminA, planned.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    await shifts.end(claims, { handoverNote: 'Patrulla 2 en taller. Revisar alerta de la plaza.' });
    const st = await shifts.status(adminA);
    expect(st.lastHandover?.operatorName).toBe('Operadora Tres');
    expect(st.lastHandover?.note).toContain('Patrulla 2');
    // Otro municipio no ve la entrega.
    expect((await shifts.status(adminB)).lastHandover).toBeNull();
  });

  it('contactos: exclusivos del municipio, se desactivan en vez de borrarse', async () => {
    const c = await contacts.create(adminA, {
      category: 'CARABINEROS',
      name: '1ª Comisaría Centro',
      organization: null,
      phone: '+56 2 2922 0000',
      phoneAlt: null,
      email: null,
      sector: null,
      notes: null,
      available24h: true,
      sortOrder: 1,
    });
    expect(c.email).toBeNull();
    expect((await contacts.list(adminA, false)).map((x) => x.id)).toContain(c.id);
    expect(await contacts.list(adminB, false)).toHaveLength(0);
    await expect(contacts.update(adminB, c.id, { name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await contacts.remove(adminA, c.id);
    expect((await contacts.list(adminA, false)).map((x) => x.id)).not.toContain(c.id);
    expect((await contacts.list(adminA, true)).find((x) => x.id === c.id)?.active).toBe(false);
    const kinds = await admin<{ kind: string }[]>`SELECT kind FROM audit_log WHERE target_id = ${c.id} ORDER BY created_at`;
    expect(kinds.map((k) => k.kind)).toEqual(['CONTACT_CREATED', 'CONTACT_REMOVED']);
  });

  it('la bitácora no se puede editar ni borrar desde la app', async () => {
    await expect(dbs.asOperator(tenantA, adminA.sub, (tx) => tx.execute(sql`UPDATE audit_log SET kind = 'LOGIN'`))).rejects.toThrow();
    await expect(dbs.asSystem((tx) => tx.execute(sql`DELETE FROM audit_log`))).rejects.toThrow();
  });

  it('panel y bitácora del sistema: solo lo del municipio, paginado', async () => {
    const o = await stats.overview(adminA, '7d');
    expect(o.series.length).toBeGreaterThanOrEqual(7);
    expect(o.operators.every((x) => x.name !== 'Admin B')).toBe(true);
    const first = await stats.activity(adminA, { source: 'system', limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await stats.activity(adminA, { source: 'system', limit: 3, cursor: first.nextCursor! });
    const ids = new Set(first.items.map((i) => i.id));
    expect(second.items.some((i) => ids.has(i.id))).toBe(false);
    const sysB = await stats.activity(adminB, { source: 'system', limit: 50 });
    expect(sysB.items).toHaveLength(0);
  });
});
