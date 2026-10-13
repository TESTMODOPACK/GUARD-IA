/**
 * Pruebas de aislamiento RLS y ruteo por geocerca contra una base real.
 * Se ejecutan con RUN_DB_TESTS=1 (pnpm test:db) y requieren DATABASE_URL y DATABASE_ADMIN_URL
 * apuntando a una base ya migrada (pnpm migrate).
 */
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { alert, alertEvent, citizen, operator, tenant, unit } from '../src/db/schema';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

// Dos municipios con polígonos disjuntos (lat/lng ficticios, lejos del seed demo).
const BOX_A = box(10, 10, 11, 11);
const BOX_B = box(20, 20, 21, 21);
const IN_A = { lat: 10.5, lng: 10.5 };
const IN_B = { lat: 20.5, lng: 20.5 };
const NOWHERE = { lat: 50, lng: 50 };

/** Drizzle envuelve el error de Postgres: el mensaje real viene en `cause`. */
async function rejectsWith(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const msg = `${err.message} ${err.cause?.message ?? ''}`;
    expect(msg).toMatch(re);
    return;
  }
  throw new Error(`se esperaba un error que calce con ${re}`);
}

function box(lng1: number, lat1: number, lng2: number, lat2: number) {
  return JSON.stringify({
    type: 'MultiPolygon',
    coordinates: [[[[lng1, lat1], [lng2, lat1], [lng2, lat2], [lng1, lat2], [lng1, lat1]]]],
  });
}

d('RLS y ruteo por geocerca', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let tenantA: string;
  let tenantB: string;
  let citizenA: string;
  let citizenB: string;
  let operatorA: string;
  let operatorB: string;
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    // Restos de corridas anteriores interrumpidas.
    await admin`DELETE FROM dispatch WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE 'test-%')`;
    await admin`DELETE FROM alert WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE 'test-%')`;
    await admin`DELETE FROM unit WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE 'test-%')`;
    for (const t of ['audit_log', 'shift', 'contact']) {
      await admin`DELETE FROM ${admin(t)} WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE 'test-%')`;
    }
    await admin`UPDATE operator SET created_by = NULL WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE 'test-%')`;
    await admin`DELETE FROM operator WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE 'test-%')`;
    await admin`DELETE FROM tenant WHERE slug LIKE 'test-%'`;

    const [a] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary) VALUES ('Test A', ${'test-a-' + suffix}, ST_GeomFromGeoJSON(${BOX_A})::geography) RETURNING id`;
    const [b] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary) VALUES ('Test B', ${'test-b-' + suffix}, ST_GeomFromGeoJSON(${BOX_B})::geography) RETURNING id`;
    tenantA = a.id;
    tenantB = b.id;

    const digits = String(Date.now()).slice(-7);
    const [ca] = await admin<{ id: string }[]>`INSERT INTO citizen (phone) VALUES (${'+5691' + digits + '1'}) RETURNING id`;
    const [cb] = await admin<{ id: string }[]>`INSERT INTO citizen (phone) VALUES (${'+5691' + digits + '2'}) RETURNING id`;
    citizenA = ca.id;
    citizenB = cb.id;

    const [oa] = await admin<{ id: string }[]>`
      INSERT INTO operator (tenant_id, email, password_hash, name, role) VALUES (${tenantA}, ${'a-' + suffix + '@test'}, 'x', 'A', 'ADMIN') RETURNING id`;
    const [ob] = await admin<{ id: string }[]>`
      INSERT INTO operator (tenant_id, email, password_hash, name, role) VALUES (${tenantB}, ${'b-' + suffix + '@test'}, 'x', 'B', 'ADMIN') RETURNING id`;
    operatorA = oa.id;
    operatorB = ob.id;
    await admin`INSERT INTO unit (tenant_id, code, kind) VALUES (${tenantA}, ${'U-' + suffix}, 'PATRULLA')`;
  });

  afterAll(async () => {
    if (!tenantA) return;
    await admin`DELETE FROM dispatch WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    await admin`DELETE FROM alert WHERE citizen_id IN (${citizenA}, ${citizenB})`;
    await admin`DELETE FROM citizen WHERE id IN (${citizenA}, ${citizenB})`;
    await admin`DELETE FROM unit WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    await admin`DELETE FROM operator WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    await admin`DELETE FROM tenant WHERE id IN (${tenantA}, ${tenantB})`;
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('el trigger asigna el tenant por geocerca y el ciudadano no puede elegirlo', async () => {
    const row = await dbs.asCitizen(citizenA, async (tx) => {
      const [r] = await tx
        .insert(alert)
        .values({
          citizenId: citizenA,
          tenantId: tenantB, // intento de elegir municipio: debe ser ignorado
          type: 'EMERGENCY_SOS',
          source: 'BUTTON',
          lat: IN_A.lat,
          lng: IN_A.lng,
        })
        .returning();
      return r;
    });
    expect(row.tenantId).toBe(tenantA);
    expect(row.status).toBe('PENDING');
    expect(row.aiStatus).toBe('QUEUED');
  });

  it('fuera de toda geocerca queda UNROUTED y sin IA', async () => {
    const row = await dbs.asCitizen(citizenA, async (tx) => {
      const [r] = await tx
        .insert(alert)
        .values({ citizenId: citizenA, type: 'EMERGENCY_SOS', source: 'BUTTON', lat: NOWHERE.lat, lng: NOWHERE.lng })
        .returning();
      return r;
    });
    expect(row.tenantId).toBeNull();
    expect(row.status).toBe('UNROUTED');
    expect(row.aiStatus).toBe('SKIPPED');
  });

  it('un ciudadano no ve ni puede crear alertas de otro', async () => {
    await dbs.asCitizen(citizenB, async (tx) => {
      const [r] = await tx
        .insert(alert)
        .values({ citizenId: citizenB, type: 'CIVIC_REPORT', source: 'FORM', lat: IN_B.lat, lng: IN_B.lng, category: 'BACHE' })
        .returning();
      expect(r.tenantId).toBe(tenantB);
    });
    const seenByA = await dbs.asCitizen(citizenA, (tx) => tx.select().from(alert));
    expect(seenByA.every((a) => a.citizenId === citizenA)).toBe(true);
    expect(seenByA.some((a) => a.citizenId === citizenB)).toBe(false);

    await rejectsWith(
      dbs.asCitizen(citizenA, (tx) =>
        tx.insert(alert).values({ citizenId: citizenB, type: 'EMERGENCY_SOS', source: 'BUTTON', lat: IN_A.lat, lng: IN_A.lng }),
      ),
      /row-level security/,
    );
  });

  it('un operador solo ve las alertas, unidades y operadores de su tenant', async () => {
    const a = await dbs.asOperator(tenantA, operatorA, async (tx) => ({
      alerts: await tx.select().from(alert),
      units: await tx.select().from(unit),
      ops: await tx.select().from(operator),
    }));
    expect(a.alerts.length).toBeGreaterThan(0);
    expect(a.alerts.every((x) => x.tenantId === tenantA)).toBe(true);
    expect(a.units.every((u) => u.tenantId === tenantA)).toBe(true);
    expect(a.ops.every((o) => o.tenantId === tenantA)).toBe(true);

    const b = await dbs.asOperator(tenantB, operatorB, (tx) => tx.select().from(alert));
    expect(b.every((x) => x.tenantId === tenantB)).toBe(true);
    expect(b.some((x) => x.tenantId === tenantA)).toBe(false);
  });

  it('un operador no puede mover una alerta a otro tenant', async () => {
    const [mine] = await dbs.asOperator(tenantA, operatorA, (tx) => tx.select().from(alert).limit(1));
    // tenant_id ya no es actualizable por columna; status sí, pero la fila ajena no existe para él.
    await rejectsWith(
      dbs.asOperator(tenantA, operatorA, (tx) =>
        tx.update(alert).set({ tenantId: tenantB }).where(eq(alert.id, mine.id)),
      ),
      /permission denied/,
    );
    const [foreign] = await dbs.asOperator(tenantB, operatorB, (tx) => tx.select().from(alert).limit(1));
    const touched = await dbs.asOperator(tenantA, operatorA, (tx) =>
      tx.update(alert).set({ status: 'ACKNOWLEDGED' }).where(eq(alert.id, foreign.id)).returning({ id: alert.id }),
    );
    expect(touched).toHaveLength(0);
  });

  it('el operador ve al vecino solo si tiene una alerta en su tenant', async () => {
    const seenByA = await dbs.asOperator(tenantA, operatorA, (tx) => tx.select().from(citizen));
    expect(seenByA.some((c) => c.id === citizenA)).toBe(true);
    expect(seenByA.some((c) => c.id === citizenB)).toBe(false);
  });

  it('guardia_app no puede editar ni borrar alert_event, ni escribir tenant', async () => {
    const [mine] = await dbs.asOperator(tenantA, operatorA, (tx) => tx.select().from(alert).limit(1));
    const ev = await dbs.asSystem(async (tx) => {
      const [e] = await tx
        .insert(alertEvent)
        .values({ alertId: mine.id, tenantId: tenantA, actorType: 'SYSTEM', kind: 'NOTE', payload: { t: 1 } })
        .returning();
      return e;
    });
    await rejectsWith(
      dbs.asSystem((tx) => tx.update(alertEvent).set({ payload: { t: 2 } }).where(eq(alertEvent.id, ev.id))),
      /permission denied/,
    );
    await rejectsWith(
      dbs.asSystem((tx) => tx.delete(alertEvent).where(eq(alertEvent.id, ev.id))),
      /permission denied/,
    );
    await rejectsWith(
      dbs.asSystem((tx) => tx.insert(tenant).values({ name: 'x', slug: 'x-' + suffix })),
      /permission denied/,
    );
  });

  it('ni el ciudadano ni system pueden cambiar tenant_id, ubicación o citizen_id de una alerta', async () => {
    const [mine] = await dbs.asCitizen(citizenA, (tx) => tx.select().from(alert).limit(1));
    await rejectsWith(
      dbs.asCitizen(citizenA, (tx) => tx.update(alert).set({ tenantId: tenantB }).where(eq(alert.id, mine.id))),
      /permission denied/,
    );
    await rejectsWith(
      dbs.asCitizen(citizenA, (tx) => tx.update(alert).set({ lat: 0, lng: 0 }).where(eq(alert.id, mine.id))),
      /permission denied/,
    );
    await rejectsWith(
      dbs.asSystem((tx) => tx.update(alert).set({ citizenId: citizenB }).where(eq(alert.id, mine.id))),
      /permission denied/,
    );
    // Lo que sí puede: cancelar (status) la suya.
    await dbs.asCitizen(citizenA, (tx) => tx.update(alert).set({ status: 'CANCELLED', aiStatus: 'SKIPPED' }).where(eq(alert.id, mine.id)));
  });

  it('el operador no puede cambiar el teléfono de un vecino (solo columnas permitidas)', async () => {
    await rejectsWith(
      dbs.asOperator(tenantA, operatorA, (tx) => tx.update(citizen).set({ phone: '+56900000000' }).where(eq(citizen.id, citizenA))),
      /permission denied/,
    );
    await dbs.asOperator(tenantA, operatorA, (tx) => tx.update(citizen).set({ trustScore: 75 }).where(eq(citizen.id, citizenA)));
  });

  it('withContext anidado se rechaza en vez de agotar el pool', async () => {
    await expect(
      dbs.asCitizen(citizenA, async () => dbs.asSystem(async (tx) => tx.select().from(alert))),
    ).rejects.toThrow(/anidado/);
  });

  it('una unidad no puede tener dos despachos abiertos (índice único parcial)', async () => {
    const [u] = await admin<{ id: string }[]>`SELECT id FROM unit WHERE tenant_id = ${tenantA} LIMIT 1`;
    const alerts = await admin<{ id: string }[]>`SELECT id FROM alert WHERE tenant_id = ${tenantA} ORDER BY created_at LIMIT 2`;
    if (alerts.length < 2) {
      await admin`INSERT INTO alert (citizen_id, type, source, lat, lng) VALUES (${citizenA}, 'EMERGENCY_SOS', 'BUTTON', ${IN_A.lat}, ${IN_A.lng})`;
    }
    const two = await admin<{ id: string }[]>`SELECT id FROM alert WHERE tenant_id = ${tenantA} ORDER BY created_at LIMIT 2`;
    await admin`INSERT INTO dispatch (alert_id, tenant_id, unit_id, operator_id) VALUES (${two[0].id}, ${tenantA}, ${u.id}, ${operatorA})`;
    await expect(
      admin`INSERT INTO dispatch (alert_id, tenant_id, unit_id, operator_id) VALUES (${two[1].id}, ${tenantA}, ${u.id}, ${operatorA})`,
    ).rejects.toThrow(/dispatch_unit_open_uidx/);
  });

  it('sin contexto (app.role vacío) no se ve nada', async () => {
    const rows = await dbs.db.transaction((tx) => tx.select().from(alert));
    expect(rows).toHaveLength(0);
  });
});
