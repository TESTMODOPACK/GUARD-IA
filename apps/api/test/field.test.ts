/**
 * Terreno (fase PT, migración 0012) contra base real (pnpm test:db): contexto RLS `field` (solo su turno, su unidad y
 * el caso al que la despacharon; nunca vecinos ni otros casos), en camino / llegué con aviso al vecino, posición
 * solo con despacho abierto, informe con propuesta de categoría, apoyo, pánico, plazos y fin de turno.
 */
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FieldAlarm } from '@guardia/shared';
import { AlertReadService } from '../src/alerts/alert-read.service';
import type { AlertsService } from '../src/alerts/alerts.service';
import { AuditService } from '../src/auth/audit.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { EventsService } from '../src/events/events.service';
import { FieldAlarmsService } from '../src/field/field-alarms.service';
import { FieldWatchCron } from '../src/field/field-watch.cron';
import { FieldService } from '../src/field/field.service';
import { IncidentsService } from '../src/incidents/incidents.service';
import type { RateLimitService } from '../src/infra/rate-limit.service';
import { MediaService } from '../src/media/media.service';
import type { Storage } from '../src/media/storage';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { OpsService } from '../src/ops/ops.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const X = 76.5; // dentro de la caja del municipio de prueba (76 a 77 grados)
const box = JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[76, 76], [77, 76], [77, 77], [76, 77], [76, 76]]]] });
const TRIAGE = {
  version: 'test',
  category: 'ROBO_ASALTO',
  subcategory: null,
  agencies: [{ agency: 'CARABINEROS', reason: 'Asalto' }],
  summary: 'Vecino informa un asalto en la esquina',
  questions: ['¿Cuántas personas?', '¿Hay heridos?'],
  location: { mentioned: 'Plaza de Armas con Estado', comuna: null, elsewhere: false },
};
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

d('terreno: funcionario con su unidad', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let field: FieldService;
  let alarms: FieldAlarmsService;
  let cron: FieldWatchCron;
  let ops: OpsService;
  let tenantId: string;
  let central: OperatorClaims;
  let f1: OperatorClaims;
  let f2: OperatorClaims;
  let citizenId: string;
  const units: Record<'u1' | 'u2' | 'u3', string> = { u1: '', u2: '', u3: '' };
  const pushed: string[] = [];
  const emitted: FieldAlarm[] = [];
  const suffix = Date.now().toString(36);

  /** Como lo inserta POST /alerts: en contexto del vecino, por la geocerca. */
  async function newAlert(text = 'me asaltaron') {
    const id = await dbs.asCitizen(citizenId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO alert (citizen_id, type, source, lat, lng, user_text)
        VALUES (${citizenId}::uuid, 'EMERGENCY_SOS', 'BUTTON', ${X}, ${X}, ${text}) RETURNING id`);
      return rows[0].id;
    });
    await admin`UPDATE alert SET category = 'ROBO_ASALTO', priority = 'HIGH', ai_summary = ${TRIAGE.summary},
                     ai_triage = ${admin.json(TRIAGE)} WHERE id = ${id}`;
    return id;
  }
  const visibleAlerts = (who: OperatorClaims) =>
    dbs.asField(who.tenantId, who.sub, async (tx) => (await tx.execute<{ id: string }>(sql`SELECT id FROM alert`)).map((r) => r.id));
  const dispatchRow = async (id: string) =>
    (await admin<{ status: string; outcome: string | null; outcome_via: string | null; proposed_category: string | null }[]>`
      SELECT status, outcome, outcome_via, proposed_category FROM dispatch WHERE id = ${id}`)[0];
  const unitRow = async (id: string) =>
    (await admin<{ status: string; last_lat: number | null }[]>`SELECT status, last_lat FROM unit WHERE id = ${id}`)[0];
  /** Envejece un despacho sin pasar por el trigger de updated_at (simula que pasaron los minutos). */
  const age = (dispatchId: string, seconds: number) =>
    admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE dispatch SET created_at = now() - make_interval(secs => ${seconds}),
                                   updated_at = now() - make_interval(secs => ${seconds}) WHERE id = ${dispatchId}`;
    });

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    const storage: Storage = {
      put: async () => undefined,
      get: async () => Buffer.alloc(0),
      delete: async () => undefined,
      signedUrl: async (key) => ({ url: `http://test/${key}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      ping: async () => true,
    };
    const media = new MediaService(env, storage, dbs);
    const reads = new AlertReadService(media);
    const realtime = {
      alertUpdated: () => undefined,
      dispatchUpdated: () => undefined,
      unitUpdated: () => undefined,
      citizenAlertStatus: () => undefined,
      fieldRefresh: () => undefined,
      moveFieldOperator: async () => undefined,
      fieldAlarm: (_t: string, a: FieldAlarm) => emitted.push(a),
    } as unknown as RealtimeService;
    const notifications = {
      notifyAlertStatus: async (_c: string, _t: string, _v: unknown, text: { title: string }) => {
        pushed.push(text.title);
      },
    } as unknown as NotificationsService;
    const events = new EventsService();
    field = new FieldService(dbs, events, media, reads, realtime, notifications, new AuditService(), {
      hit: async () => undefined,
    } as unknown as RateLimitService);
    alarms = new FieldAlarmsService(dbs, events, realtime);
    cron = new FieldWatchCron(dbs, realtime);
    ops = new OpsService(dbs, reads, events, realtime, notifications, new IncidentsService(dbs), {
      enqueue: async () => true,
    } as unknown as AlertsService);

    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary)
      VALUES ('Municipalidad Terreno', ${'terreno-test-' + suffix}, ST_GeomFromGeoJSON(${box})::geography) RETURNING id`;
    tenantId = t.id;
    const people: OperatorClaims[] = [];
    for (const [i, role] of (['OPERATOR', 'FIELD', 'FIELD'] as const).entries()) {
      const [o] = await admin<{ id: string }[]>`
        INSERT INTO operator (tenant_id, email, password_hash, name, role)
        VALUES (${tenantId}, ${`terreno-${i}-${suffix}@test.cl`}, 'x', ${`Terreno ${i}`}, ${role}::operator_role) RETURNING id`;
      people.push({ kind: 'operator', sub: o.id, tenantId, role });
    }
    [central, f1, f2] = people;
    for (const [k, code] of [['u1', 'PAT-F1'], ['u2', 'PAT-F2'], ['u3', 'PAT-RADIO']] as const) {
      const [u] = await admin<{ id: string }[]>`
        INSERT INTO unit (tenant_id, code, kind, status) VALUES (${tenantId}, ${`${code}-${suffix}`.toUpperCase().slice(0, 20)}, 'PATRULLA',
                ${k === 'u3' ? 'AVAILABLE' : 'OFFLINE'}::unit_status) RETURNING id`;
      units[k] = u.id;
    }
    const [c] = await admin<{ id: string }[]>`
      INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5693${String(Date.now()).slice(-7)}`}, 'v1', now()) RETURNING id`;
    citizenId = c.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await admin`DELETE FROM field_alarm WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM media WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM triage_label WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM alert_event WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM dispatch WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM shift WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM alert WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM incident WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM unit WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM operator WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM tenant WHERE id = ${tenantId}`;
    }
    if (citizenId) await admin`DELETE FROM citizen WHERE id = ${citizenId}`;
    await admin?.end({ timeout: 5 });
    await dbs?.onModuleDestroy();
  });

  it('sin turno no ve casos ni vecinos; elige unidad y la unidad fuera de servicio queda disponible', async () => {
    await newAlert();
    expect(await visibleAlerts(f1)).toEqual([]);
    const citizens = await dbs.asField(tenantId, f1.sub, (tx) => tx.execute(sql`SELECT id FROM citizen`));
    expect(citizens).toHaveLength(0);

    const before = await field.state(f1);
    expect(before.shift).toBeNull();
    expect(before.units.map((u) => u.id)).toEqual(expect.arrayContaining([units.u1, units.u2]));

    const st = await field.startShift(f1, { unitId: units.u1 });
    expect(st.shift?.unit.id).toBe(units.u1);
    expect(st.units).toEqual([]);
    expect((await unitRow(units.u1)).status).toBe('AVAILABLE');
    await expect(field.startShift(f1, { unitId: units.u2 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await field.startShift(f2, { unitId: units.u2 });
  });

  let d1 = '';
  let a1 = '';
  it('recibe el despacho de su unidad y solo ve ese caso, sin datos del vecino', async () => {
    a1 = await newAlert();
    const other = await newAlert('otra cosa');
    d1 = (await ops.dispatch(central, a1, { unitId: units.u1 })).id;

    const st = await field.state(f1);
    expect(st.dispatch).toMatchObject({ id: d1, status: 'ASSIGNED' });
    expect(st.dispatch?.alert).toMatchObject({
      id: a1,
      summary: TRIAGE.summary,
      place: TRIAGE.location.mentioned,
      questions: TRIAGE.questions,
      location: { lat: X, lng: X },
    });
    expect(JSON.stringify(st.dispatch)).not.toMatch(/citizen|phone|transcription|userText/i);
    expect(await visibleAlerts(f1)).toEqual([a1]);
    expect(await visibleAlerts(f1)).not.toContain(other);
    expect(await visibleAlerts(f2)).toEqual([]);
    expect((await field.state(f2)).dispatch).toBeNull();
  });

  it('en camino y llegué: avisan al vecino, mueven la unidad y un doble toque no repite nada', async () => {
    await field.setStatus(f1, d1, { status: 'EN_ROUTE', location: { lat: X + 0.01, lng: X } });
    expect(pushed.at(-1)).toBe('Unidad en camino');
    expect((await unitRow(units.u1)).last_lat).toBeCloseTo(X + 0.01);
    const n = pushed.length;
    await field.setStatus(f1, d1, { status: 'EN_ROUTE' });
    expect(pushed).toHaveLength(n);
    await field.setStatus(f1, d1, { status: 'ON_SITE' });
    expect(pushed.at(-1)).toBe('Unidad en el lugar');
    await expect(field.setStatus(f1, d1, { status: 'EN_ROUTE' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const [ev] = await admin<{ payload: { via: string } }[]>`
      SELECT payload FROM alert_event WHERE alert_id = ${a1} AND kind = 'DISPATCH_STATUS' ORDER BY created_at DESC LIMIT 1`;
    expect(ev.payload.via).toBe('FIELD');
    await expect(field.setStatus(f2, d1, { status: 'ON_SITE' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('la posición solo se guarda con un despacho abierto', async () => {
    await field.location(f1, { lat: X + 0.02, lng: X });
    expect((await unitRow(units.u1)).last_lat).toBeCloseTo(X + 0.02);
    await expect(field.location(f2, { lat: X, lng: X })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('"era otra situación" queda como propuesta; la central la aplica; "atendido" cierra el despacho y deja el caso abierto', async () => {
    await field.report(f1, d1, { outcome: 'DIFFERENT_SITUATION', category: 'VIOLENCIA_AGRESION', notes: 'Era una riña' }, []);
    expect(await dispatchRow(d1)).toMatchObject({ status: 'ON_SITE', outcome: 'DIFFERENT_SITUATION', outcome_via: 'FIELD', proposed_category: 'VIOLENCIA_AGRESION' });
    const [before] = await admin<{ category: string }[]>`SELECT category FROM alert WHERE id = ${a1}`;
    expect(before.category).toBe('ROBO_ASALTO');

    await ops.recordOutcome(central, d1, { outcome: 'DIFFERENT_SITUATION', category: 'VIOLENCIA_AGRESION' });
    expect(await dispatchRow(d1)).toMatchObject({ outcome_via: 'CENTRAL', proposed_category: null });
    const [after] = await admin<{ category: string }[]>`SELECT category FROM alert WHERE id = ${a1}`;
    expect(after.category).toBe('VIOLENCIA_AGRESION');

    const st = await field.report(f1, d1, { outcome: 'RESOLVED_ON_SITE', notes: 'Se calmó' }, [
      { buffer: PNG, mimetype: 'image/png', size: PNG.length },
    ]);
    expect(st.dispatch).toBeNull();
    expect(await dispatchRow(d1)).toMatchObject({ status: 'CLOSED', outcome: 'RESOLVED_ON_SITE', outcome_via: 'FIELD' });
    expect((await unitRow(units.u1)).status).toBe('AVAILABLE');
    const [a] = await admin<{ status: string; photos: number }[]>`
      SELECT a.status, (SELECT count(*)::int FROM media m WHERE m.alert_id = a.id AND m.kind = 'PHOTO') AS photos
        FROM alert a WHERE a.id = ${a1}`;
    expect(a).toEqual({ status: 'DISPATCHED', photos: 1 });
    // Lo cerró en su turno: sigue viéndolo, pero ya no puede informar sobre él.
    expect(await visibleAlerts(f1)).toContain(a1);
    await expect(field.report(f1, d1, { outcome: 'NOT_FOUND' }, [])).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('pedir apoyo levanta un aviso sin duplicar y la central lo atiende', async () => {
    const a2 = await newAlert();
    const d2 = (await ops.dispatch(central, a2, { unitId: units.u1 })).id;
    await field.report(f1, d2, { outcome: 'NEEDS_SUPPORT', notes: 'Necesito SAMU' }, []);
    await field.report(f1, d2, { outcome: 'NEEDS_SUPPORT', notes: 'Sigo esperando SAMU' }, []);
    const open = (await alarms.open(central)).filter((x) => x.dispatchId === d2);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'SUPPORT', operatorId: f1.sub, note: 'Necesito SAMU' });
    const acked = await alarms.ack(central, open[0].id, { note: 'SAMU en camino' });
    expect(acked.closedAt).not.toBeNull();
    expect(acked.closedByName).toBe('Terreno 0');
    await field.report(f1, d2, { outcome: 'RESOLVED_ON_SITE' }, []);
  });

  it('el pánico llega con o sin despacho, apretar de nuevo no lo duplica y el funcionario ve cuándo lo atienden', async () => {
    const p1 = await field.panic(f2, { location: { lat: X, lng: X + 0.01 } });
    const p2 = await field.panic(f2, { location: { lat: X, lng: X + 0.02 } });
    expect(p2.id).toBe(p1.id);
    expect(p2).toMatchObject({ kind: 'PANIC', unitCode: expect.stringContaining('PAT-F2'), location: { lat: X, lng: X + 0.02 } });
    expect((await field.state(f2)).panic?.id).toBe(p1.id);
    expect(emitted.at(-1)?.id).toBe(p1.id);
    await alarms.ack(central, p1.id, {});
    expect((await field.state(f2)).panic).toBeNull();
    expect(emitted.at(-1)).toMatchObject({ id: p1.id, operatorId: f2.sub });
    expect(emitted.at(-1)?.closedAt).not.toBeNull();
  });

  it('plazos: sin "en camino" en 2 min avisa una vez, solo a unidades de terreno, y se cierra cuando la unidad responde', async () => {
    const a3 = await newAlert();
    const d3 = (await ops.dispatch(central, a3, { unitId: units.u2 })).id;
    const a4 = await newAlert();
    const radio = (await ops.dispatch(central, a4, { unitId: units.u3 })).id;
    await age(d3, 180);
    await age(radio, 180);
    await cron.check();
    const late = await admin<{ id: string; closed_at: Date | null }[]>`
      SELECT id, closed_at FROM field_alarm WHERE dispatch_id = ${d3} AND kind = 'LATE'`;
    expect(late).toHaveLength(1);
    expect(await admin`SELECT 1 FROM field_alarm WHERE dispatch_id = ${radio}`).toHaveLength(0);
    await cron.check();
    expect(await admin`SELECT 1 FROM field_alarm WHERE dispatch_id = ${d3}`).toHaveLength(1);

    await field.setStatus(f2, d3, { status: 'EN_ROUTE' });
    const [closed] = await admin<{ closed_at: Date | null; closed_by: string | null }[]>`
      SELECT closed_at, closed_by FROM field_alarm WHERE id = ${late[0].id}`;
    expect(closed.closed_at).not.toBeNull();
    expect(closed.closed_by).toBeNull();

    // Terminar turno con el despacho abierto no se puede; cerrado, sí (la unidad queda como está: decide la central).
    await expect(field.endShift(f2)).rejects.toMatchObject({ code: 'CONFLICT' });
    await field.report(f2, d3, { outcome: 'NOT_FOUND', notes: 'Nadie en el lugar' }, []);
    const st = await field.endShift(f2);
    expect(st.shift).toBeNull();
    expect((await unitRow(units.u2)).status).toBe('AVAILABLE');
    expect(await visibleAlerts(f2)).toEqual([]);
    await ops.resolve(central, a4);
  });
});
