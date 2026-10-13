/**
 * Uso indebido y resultado en terreno contra base real (pnpm test:db, migración 0008): solo el aviso
 * falso intencional es falta, las faltas se cuentan en todo el país y las ve cualquier central que reciba
 * una alerta del vecino, el vecino ve el motivo, y la unidad informa lo que encontró.
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RejectAlertSchema } from '@guardia/shared';
import { AlertReadService } from '../src/alerts/alert-read.service';
import type { AlertsService } from '../src/alerts/alerts.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { EventsService } from '../src/events/events.service';
import { IncidentsService } from '../src/incidents/incidents.service';
import type { MediaService } from '../src/media/media.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { OpsService } from '../src/ops/ops.service';
import { PrivacyService } from '../src/privacy/privacy.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const box = (x: number) =>
  JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[x, x], [x + 1, x], [x + 1, x + 1], [x, x + 1], [x, x]]]] });
const EVIDENCE = 'El vecino se rió y dijo que era una broma para su amigo';

d('uso indebido y resultado en terreno', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let ops: OpsService;
  let reads: AlertReadService;
  const tenants: string[] = [];
  const op: OperatorClaims[] = [];
  const units: string[] = [];
  const citizens: string[] = [];
  const notices: { title: string; body: string }[] = [];
  const suffix = Date.now().toString(36);

  /** SOS del vecino `c` en el municipio `t` (cajas en 70 y 72 grados). */
  async function sos(t: 0 | 1, c = 0) {
    const x = t === 0 ? 70.5 : 72.5;
    const [a] = await admin<{ id: string }[]>`
      INSERT INTO alert (citizen_id, type, source, lat, lng, user_text, category, priority)
      VALUES (${citizens[c]}, 'EMERGENCY_SOS', 'VOICE', ${x}, ${x}, 'vengan rápido', 'ROBO_ASALTO', 'HIGH') RETURNING id`;
    return a.id;
  }
  const trust = async (c = 0) => (await admin<{ t: number }[]>`SELECT trust_score AS t FROM citizen WHERE id = ${citizens[c]}`)[0].t;
  const citizenView = (alertId: string, c = 0) => dbs.asCitizen(citizens[c], (tx) => reads.citizenView(tx, alertId));

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    reads = new AlertReadService({ toPublic: async () => [] } as unknown as MediaService);
    const realtime = {
      alertUpdated: () => undefined,
      dispatchUpdated: () => undefined,
      unitUpdated: () => undefined,
      citizenAlertStatus: () => undefined,
    } as unknown as RealtimeService;
    const notifications = {
      notifyAlertStatus: async (_c: string, _t: string, _v: unknown, text: { title: string; body: string }) => {
        notices.push(text);
      },
    } as unknown as NotificationsService;
    ops = new OpsService(dbs, reads, new EventsService(), realtime, notifications, new IncidentsService(dbs), {
      enqueue: async () => true,
    } as unknown as AlertsService);

    for (const [i, x] of [70, 72].entries()) {
      const [t] = await admin<{ id: string }[]>`
        INSERT INTO tenant (name, slug, boundary)
        VALUES (${'Municipalidad Uso ' + i}, ${`uso-test-${i}-${suffix}`}, ST_GeomFromGeoJSON(${box(x)})::geography) RETURNING id`;
      tenants.push(t.id);
      const [o] = await admin<{ id: string }[]>`
        INSERT INTO operator (tenant_id, email, password_hash, name, role)
        VALUES (${t.id}, ${`uso-${i}-${suffix}@test.cl`}, 'x', ${'Operador ' + i}, 'SUPERVISOR') RETURNING id`;
      op.push({ kind: 'operator', sub: o.id, tenantId: t.id, role: 'SUPERVISOR' });
      const [u] = await admin<{ id: string }[]>`
        INSERT INTO unit (tenant_id, code, kind) VALUES (${t.id}, ${`U${i}-${suffix}`.toUpperCase()}, 'PATRULLA') RETURNING id`;
      units.push(u.id);
    }
    const digits = String(Date.now()).slice(-6);
    for (let i = 0; i < 2; i++) {
      const [c] = await admin<{ id: string }[]>`
        INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5695${digits}${i}`}, 'v1', now()) RETURNING id`;
      citizens.push(c.id);
    }
  });

  afterAll(async () => {
    if (tenants.length) {
      await admin`DELETE FROM citizen_review WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM citizen_block WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM citizen_strike WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM triage_label WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM alert_event WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM dispatch WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM alert WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM incident WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM unit WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM operator WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM tenant WHERE id IN ${admin(tenants)}`;
    }
    if (citizens.length) await admin`DELETE FROM citizen WHERE id IN ${admin(citizens)}`;
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('una falsa alarma exige la evidencia escrita', () => {
    expect(RejectAlertSchema.safeParse({ reason: 'FALSE_ALARM' }).success).toBe(false);
    expect(RejectAlertSchema.safeParse({ reason: 'FALSE_ALARM', notes: 'broma' }).success).toBe(false);
    expect(RejectAlertSchema.safeParse({ reason: 'FALSE_ALARM', notes: EVIDENCE }).success).toBe(true);
    expect(RejectAlertSchema.safeParse({ reason: 'ACCIDENTAL' }).success).toBe(true);
  });

  it('accidental y mal reportado no sancionan; el vecino ve un mensaje amable', async () => {
    const before = await trust();
    for (const reason of ['ACCIDENTAL', 'MISREPORTED'] as const) {
      const id = await sos(0);
      notices.length = 0;
      await ops.reject(op[0], id, { reason });
      expect((await citizenView(id)).closeReason).toBe(reason);
      expect(notices[0].title).not.toMatch(/advertencia/i);
    }
    expect(await trust()).toBe(before);
    const [{ n }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM citizen_strike WHERE citizen_id = ${citizens[0]}`;
    expect(n).toBe(0);
  });

  it('la falsa alarma intencional deja falta, baja la confianza y escala la advertencia', async () => {
    const before = await trust();
    const first = await sos(0);
    notices.length = 0;
    await ops.reject(op[0], first, { reason: 'FALSE_ALARM', notes: EVIDENCE });
    expect(notices[0].title).toBe('Advertencia por aviso falso');
    expect(await citizenView(first)).toMatchObject({ closeReason: 'FALSE_ALARM', strikeCount: 1 });
    expect(await trust()).toBe(Math.max(0, before - 25));

    // La segunda, en otro municipio: la cuenta es una sola para todo el país.
    const second = await sos(1);
    notices.length = 0;
    await ops.reject(op[1], second, { reason: 'FALSE_ALARM', notes: EVIDENCE });
    expect(notices[0].title).toBe('Segunda advertencia: cuenta restringida');

    const next = await sos(0);
    const detail = await ops.detail(op[0], next);
    expect(detail.citizenStrikes).toBe(2);
    const standing = await ops.citizenStanding(op[0], next);
    expect(standing.activeStrikes).toBe(2);
    expect(standing.strikesByTenant.map((t) => t.tenantName).sort()).toEqual(['Municipalidad Uso 0', 'Municipalidad Uso 1']);
    expect(standing.recentRejections.map((r) => r.reason)).toEqual(expect.arrayContaining(['FALSE_ALARM', 'ACCIDENTAL']));
  });

  it('una central no ve las faltas de un vecino que no tiene alertas en su municipio', async () => {
    const other = await sos(0, 1);
    await ops.reject(op[0], other, { reason: 'FALSE_ALARM', notes: EVIDENCE });
    const rows = await dbs.asOperator(op[1].tenantId, op[1].sub, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from citizen_strike where citizen_id = ${citizens[1]}::uuid`),
    );
    expect([...rows][0].n).toBe(0);
  });

  it('la exportación de Mis datos incluye las faltas', async () => {
    const privacy = new PrivacyService(dbs, {} as MediaService);
    const exp = await privacy.export(citizens[0]);
    expect(exp.strikes.length).toBe(2);
    expect(exp.strikes[0]).toMatchObject({ annulled: false, note: EVIDENCE });
  });

  it('resultado en terreno: atendido cierra el despacho y libera la unidad', async () => {
    const id = await sos(0);
    const disp = await ops.dispatch(op[0], id, { unitId: units[0] });
    const r = await ops.recordOutcome(op[0], disp.id, { outcome: 'RESOLVED_ON_SITE', notes: 'Se calmó la situación' });
    expect(r).toMatchObject({ status: 'CLOSED', outcome: 'RESOLVED_ON_SITE', outcomeNote: 'Se calmó la situación' });
    const [u] = await admin<{ status: string }[]>`SELECT status FROM unit WHERE id = ${units[0]}`;
    expect(u.status).toBe('AVAILABLE');
    const detail = await ops.detail(op[0], id);
    expect(detail.events.at(-1)).toMatchObject({ kind: 'FIELD_REPORT' });
  });

  it('pide apoyo deja el despacho abierto; era otra situación corrige la categoría como dato de terreno', async () => {
    const id = await sos(0);
    const disp = await ops.dispatch(op[0], id, { unitId: units[0] });
    const support = await ops.recordOutcome(op[0], disp.id, { outcome: 'NEEDS_SUPPORT', notes: 'Piden SAMU' });
    expect(support.status).toBe('ASSIGNED');

    await ops.recordOutcome(op[0], disp.id, {
      outcome: 'DIFFERENT_SITUATION',
      category: 'VIOLENCIA_AGRESION',
      subcategory: 'RINA',
      notes: 'No era asalto, era una pelea entre vecinos',
    });
    const [a] = await admin<{ category: string; subcategory: string }[]>`SELECT category, subcategory FROM alert WHERE id = ${id}`;
    expect(a).toEqual({ category: 'VIOLENCIA_AGRESION', subcategory: 'RINA' });
    const [l] = await admin<{ field_category: string; field_subcategory: string }[]>`
      SELECT field_category, field_subcategory FROM triage_label WHERE alert_id = ${id}`;
    expect(l).toEqual({ field_category: 'VIOLENCIA_AGRESION', field_subcategory: 'RINA' });
    await expect(ops.recordOutcome(op[0], disp.id, { outcome: 'DIFFERENT_SITUATION', category: 'BACHE' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await ops.recordOutcome(op[0], disp.id, { outcome: 'RESOLVED_ON_SITE' });
  });

  it('falsa alarma confirmada en terreno permite rechazar una alerta ya despachada', async () => {
    const id = await sos(0, 1);
    const disp = await ops.dispatch(op[0], id, { unitId: units[0] });
    await ops.recordOutcome(op[0], disp.id, { outcome: 'FALSE_ALARM_CONFIRMED', notes: 'No había nadie y el vecino admitió la broma' });
    const detail = await ops.reject(op[0], id, { reason: 'FALSE_ALARM', notes: 'Confirmado en terreno por la patrulla' });
    expect(detail.status).toBe('REJECTED');
    expect(detail.dispatches[0]).toMatchObject({ status: 'CLOSED', outcome: 'FALSE_ALARM_CONFIRMED' });
  });
});
