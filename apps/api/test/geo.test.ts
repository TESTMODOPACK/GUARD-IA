/**
 * Georreferencia y redirección contra base real (pnpm test:db, migración 0006): comuna del GPS,
 * comuna mencionada, municipios en el límite, traspaso automático del agente (solo con evidencia y
 * con alguien conectado en destino), traspaso manual y la regla 3 (tenant_id sin UPDATE directo).
 *
 * Coordenadas en el Pacífico (lng −100…−95, lat −40…−39) para no chocar con comunas reales cargadas.
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeClassification, type Triage } from '@guardia/shared';
import { AlertReadService } from '../src/alerts/alert-read.service';
import type { AlertsService } from '../src/alerts/alerts.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { EventsService } from '../src/events/events.service';
import { TransferService } from '../src/geo/transfer.service';
import { IncidentsService } from '../src/incidents/incidents.service';
import type { MediaService } from '../src/media/media.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { OpsService } from '../src/ops/ops.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const box = (x0: number) =>
  JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[x0, -40], [x0 + 1, -40], [x0 + 1, -39], [x0, -39], [x0, -40]]]] });
// A: lng −100…−99 · B: −99…−98 (vecinos) · C: −98…−97 (comuna sin Guard-IA) · D: −96…−95 (municipio sin comuna cargada)
const CUTS = { A: 99001, B: 99002, C: 99003 };
const LAT = -39.5;

d('georreferencia y redirección', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let ops: OpsService;
  let transfers: TransferService;
  const t: Record<'A' | 'B' | 'D', string> = { A: '', B: '', D: '' };
  const op: Record<'A' | 'B', OperatorClaims> = {} as never;
  const citizens: string[] = [];
  const online = new Set<string>();
  const calls: string[] = [];
  const suffix = Date.now().toString(36);

  async function sos(lng: number, accuracyM: number | null = 10) {
    const [a] = await admin<{ id: string }[]>`
      INSERT INTO alert (citizen_id, type, source, lat, lng, accuracy_m)
      VALUES (${citizens[0]}, 'EMERGENCY_SOS', 'VOICE', ${LAT}, ${lng}, ${accuracyM}) RETURNING id`;
    return a.id;
  }
  const triageSaying = (comuna: string | null, elsewhere: boolean): Triage =>
    normalizeClassification(
      'EMERGENCY_SOS',
      {
        category: 'INCENDIO',
        subcategory: null,
        priority: 'HIGH',
        agencies: [{ agency: 'BOMBEROS', reason: 'fuego' }],
        confidence: 0.9,
        summary: 'Incendio',
        operator_questions: [],
        location: { mentioned: null, comuna, elsewhere },
        flags: { possible_false_alarm: false, weapon_mentioned: false, people_injured: false, minor_involved: false, language_other_than_spanish: false },
      },
      { provider: 'test', model: null },
    );
  const tenantOf = async (id: string) => (await admin<{ tenant_id: string | null }[]>`SELECT tenant_id FROM alert WHERE id = ${id}`)[0].tenant_id;

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    const incidents = new IncidentsService(dbs);
    const reads = new AlertReadService({ toPublic: async () => [] } as unknown as MediaService);
    const realtime = {
      connectedOperatorIds: async (tenantId: string) => (online.has(tenantId) ? new Set(['op']) : new Set()),
      alertTransferred: (from: string) => calls.push(`transferred:${from}`),
      alertCreated: (to: string) => calls.push(`created:${to}`),
      alertUpdated: () => undefined,
      citizenAlertStatus: () => undefined,
    } as unknown as RealtimeService;
    const notifications = { notifyAlertStatus: async () => void calls.push('notify') } as unknown as NotificationsService;
    ops = new OpsService(dbs, reads, new EventsService(), realtime, notifications, incidents, { enqueue: async () => true } as unknown as AlertsService);
    transfers = new TransferService(dbs, reads, realtime, notifications, incidents);

    // Restos de una corrida interrumpida (afterAll no alcanzó a limpiar).
    const stale = await admin<{ id: string }[]>`SELECT id FROM tenant WHERE slug LIKE 'geo-test-%'`;
    for (const { id } of stale) {
      await admin`DELETE FROM audit_log WHERE tenant_id = ${id}`;
      await admin`DELETE FROM alert_event WHERE alert_id IN (SELECT id FROM alert WHERE tenant_id = ${id})`;
      await admin`DELETE FROM alert WHERE tenant_id = ${id}`;
      await admin`DELETE FROM incident WHERE tenant_id = ${id}`;
      await admin`DELETE FROM operator WHERE tenant_id = ${id}`;
      await admin`DELETE FROM tenant WHERE id = ${id}`;
    }
    for (const [k, x0] of [['A', -100], ['B', -99], ['C', -98]] as const) {
      await admin`
        INSERT INTO comuna (cut, name, name_key, region_cut, region_name, boundary)
        VALUES (${CUTS[k]}, ${`Comuna ${k} Test`}, ${`comuna ${k.toLowerCase()} test`}, 16, 'Región de prueba', ST_GeomFromGeoJSON(${box(x0)})::geography)
        ON CONFLICT (cut) DO NOTHING`;
    }
    // El ruteo usa los trozos (migración 0007), como los deja load-comunas.
    await admin`DELETE FROM comuna_part WHERE cut IN ${admin(Object.values(CUTS))}`;
    await admin`
      INSERT INTO comuna_part (cut, part)
      SELECT cut, ST_Subdivide(boundary::geometry, 256)::geography FROM comuna WHERE cut IN ${admin(Object.values(CUTS))}`;
    for (const [k, x0, cut] of [['A', -100, CUTS.A], ['B', -99, CUTS.B], ['D', -96, null]] as const) {
      const [row] = await admin<{ id: string }[]>`
        INSERT INTO tenant (name, slug, boundary, comuna_cut)
        VALUES (${`Municipalidad de Geo ${k} Test`}, ${`geo-test-${k.toLowerCase()}-${suffix}`}, ST_GeomFromGeoJSON(${box(x0)})::geography, ${cut})
        RETURNING id`;
      t[k] = row.id;
      if (k !== 'D') {
        const [o] = await admin<{ id: string }[]>`
          INSERT INTO operator (tenant_id, email, password_hash, name, role)
          VALUES (${row.id}, ${`geo-${k.toLowerCase()}-${suffix}@test.cl`}, 'x', ${'Op ' + k}, 'OPERATOR') RETURNING id`;
        op[k] = { kind: 'operator', sub: o.id, tenantId: row.id, role: 'OPERATOR' };
      }
    }
    const [c] = await admin<{ id: string }[]>`
      INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5696${String(Date.now()).slice(-7)}`}, 'v1', now()) RETURNING id`;
    citizens.push(c.id);
  });

  afterAll(async () => {
    const ids = Object.values(t).filter(Boolean);
    if (ids.length) {
      await admin`DELETE FROM audit_log WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM alert_event WHERE alert_id IN (SELECT id FROM alert WHERE citizen_id = ${citizens[0]})`;
      await admin`DELETE FROM alert WHERE citizen_id = ${citizens[0]}`;
      await admin`DELETE FROM incident WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM operator WHERE tenant_id IN ${admin(ids)}`;
      await admin`DELETE FROM tenant WHERE id IN ${admin(ids)}`;
    }
    await admin`DELETE FROM comuna WHERE cut IN ${admin(Object.values(CUTS))}`;
    if (citizens.length) await admin`DELETE FROM citizen WHERE id IN ${admin(citizens)}`;
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('el trigger fija municipio y comuna del GPS; fuera de cobertura conserva la comuna', async () => {
    const inA = await sos(-99.5);
    const outside = await sos(-97.5);
    const rows = await admin<{ id: string; tenant_id: string | null; comuna_cut: number | null; status: string }[]>`
      SELECT id, tenant_id, comuna_cut, status FROM alert WHERE id IN (${inA}, ${outside})`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[inA]).toMatchObject({ tenant_id: t.A, comuna_cut: CUTS.A, status: 'PENDING' });
    expect(byId[outside]).toMatchObject({ tenant_id: null, comuna_cut: CUTS.C, status: 'UNROUTED' });
    const view = await dbs.asSystem((tx) => new AlertReadService({} as MediaService).citizenView(tx, outside));
    expect(view.comunaName).toBe('Comuna C Test');
  });

  it('la ficha muestra la comuna mencionada y el municipio vecino en el límite', async () => {
    const id = await sos(-99.001, 300); // ~86 m del límite con B
    await admin`UPDATE alert SET ai_triage = ${admin.json(triageSaying('Comuna B Test', false) as never)} WHERE id = ${id}`;
    const detail = await ops.detail(op.A, id);
    expect(detail.geo.comuna).toEqual({ cut: CUTS.A, name: 'Comuna A Test' });
    expect(detail.geo.mentioned).toMatchObject({ name: 'Comuna B Test', tenantId: t.B, tenantName: 'Municipalidad de Geo B Test' });
    expect(detail.geo.nearby.map((n) => n.tenantId)).toContain(t.B);
  });

  it('traspaso automático: el vecino nombra otra comuna, el hecho está lejos y destino tiene operadores', async () => {
    online.add(t.B);
    calls.length = 0;
    const id = await sos(-99.5);
    expect(await transfers.maybeAutoTransfer(id, triageSaying('comuna b test', true))).toBe(true);
    expect(await tenantOf(id)).toBe(t.B);
    expect(calls).toEqual(expect.arrayContaining([`transferred:${t.A}`, `created:${t.B}`, 'notify']));

    await expect(ops.detail(op.A, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const inB = await ops.detail(op.B, id);
    expect(inB.events.at(-1)).toMatchObject({ kind: 'TRANSFERRED', actorType: 'AI' });
    expect(inB.events.at(-1)?.payload).toMatchObject({ from: t.A, to: t.B, auto: true });
    const [audit] = await admin<{ kind: string }[]>`SELECT kind FROM audit_log WHERE tenant_id = ${t.A} AND target_id = ${id}`;
    expect(audit.kind).toBe('ALERT_TRANSFERRED');
  });

  it('no traspasa sin evidencia, si destino no tiene a nadie o si la central ya la tomó', async () => {
    online.add(t.B);
    const far = await sos(-99.5); // a ~43 km de B y sin "lejos de mí"
    expect(await transfers.maybeAutoTransfer(far, triageSaying('Comuna B Test', false))).toBe(false);

    const onEdge = await sos(-99.001); // en el límite: basta con que la nombre
    expect(await transfers.maybeAutoTransfer(onEdge, triageSaying('Comuna B Test', false))).toBe(true);

    const acked = await sos(-99.5);
    await ops.acknowledge(op.A, acked);
    expect(await transfers.maybeAutoTransfer(acked, triageSaying('Comuna B Test', true))).toBe(false);

    online.delete(t.B);
    const nobody = await sos(-99.5);
    expect(await transfers.maybeAutoTransfer(nobody, triageSaying('Comuna B Test', true))).toBe(false);
    expect(await tenantOf(nobody)).toBe(t.A);

    // Comuna sin Guard-IA (C): no hay a quién traspasar.
    expect(await transfers.maybeAutoTransfer(nobody, triageSaying('Comuna C Test', true))).toBe(false);
  });

  it('sin tabla de comunas para ese nombre, reconoce el municipio por su nombre', async () => {
    online.add(t.D);
    const id = await sos(-99.5);
    expect(await transfers.maybeAutoTransfer(id, triageSaying('Geo D Test', true))).toBe(true);
    expect(await tenantOf(id)).toBe(t.D);
  });

  it('traspaso manual: solo desde el municipio dueño, a un destino válido y sin despacho', async () => {
    const id = await sos(-99.5);
    const r = await transfers.transferByOperator(op.A, id, { tenantId: t.B, reason: 'Ocurre al otro lado del límite' });
    expect(r).toMatchObject({ fromTenantId: t.A, toTenantId: t.B });
    await expect(transfers.transferByOperator(op.A, id, { tenantId: t.A, reason: 'devolver' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(transfers.transferByOperator(op.B, id, { tenantId: t.B, reason: 'mismo municipio' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    await ops.resolve(op.B, id, 'atendida');
    await expect(transfers.transferByOperator(op.B, id, { tenantId: t.A, reason: 'ya resuelta' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await transfers.tenantOptions(op.A)).map((o) => o.id)).toEqual(expect.arrayContaining([t.B, t.D]));
  });

  it('regla 3: la app no puede cambiar tenant_id directamente', async () => {
    const id = await sos(-99.5);
    await expect(dbs.asSystem((tx) => tx.execute(sql`UPDATE alert SET tenant_id = ${t.B}::uuid WHERE id = ${id}::uuid`))).rejects.toThrow();
    await expect(dbs.asSystem((tx) => tx.execute(sql`UPDATE alert SET comuna_cut = ${CUTS.B} WHERE id = ${id}::uuid`))).rejects.toThrow();
  });
});
