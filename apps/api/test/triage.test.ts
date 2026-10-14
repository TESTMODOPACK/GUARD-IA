/**
 * Agente de clasificación contra base real (pnpm test:db, migración 0005): el worker guarda el
 * triage con las reglas fijas, la central corrige y deriva, la IA no pisa al operador, RLS por
 * municipio y la supresión borra el triage.
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRIAGE_VERSION } from '@guardia/shared';
import { AiProcessor } from '../src/ai/ai.processor';
import type { ProcessAlertJob } from '../src/ai/ai.queue';
import { MockAiProvider } from '../src/ai/mock.provider';
import { AlertReadService } from '../src/alerts/alert-read.service';
import type { AlertsService } from '../src/alerts/alerts.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { EventsService } from '../src/events/events.service';
import type { TransferService } from '../src/geo/transfer.service';
import type { MetricsService } from '../src/infra/metrics.service';
import { IncidentsService } from '../src/incidents/incidents.service';
import type { MediaService } from '../src/media/media.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { OpsService } from '../src/ops/ops.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const box = (x: number) =>
  JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[x, x], [x + 1, x], [x + 1, x + 1], [x, x + 1], [x, x]]]] });

d('agente de clasificación', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let ops: OpsService;
  let worker: AiProcessor;
  const tenants: string[] = [];
  const citizens: string[] = [];
  let opA: OperatorClaims;
  let opB: OperatorClaims;
  const suffix = Date.now().toString(36);

  async function sos(text: string | null, citizen = 0) {
    const [a] = await admin<{ id: string }[]>`
      INSERT INTO alert (citizen_id, type, source, lat, lng, user_text)
      VALUES (${citizens[citizen]}, 'EMERGENCY_SOS', ${text ? 'VOICE' : 'BUTTON'}, 60.5, 60.5, ${text})
      RETURNING id`;
    return a.id;
  }
  const analyze = (alertId: string) =>
    worker.process({ data: { alertId }, attemptsMade: 0, opts: {}, id: `t-${alertId}` } as unknown as Job<ProcessAlertJob>);
  const row = async (id: string) =>
    (
      await admin<Record<string, unknown>[]>`
        SELECT category, subcategory, priority, suggested_agency, ai_triage FROM alert WHERE id = ${id}`
    )[0];

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    const incidents = new IncidentsService(dbs);
    const reads = new AlertReadService({ toPublic: async () => [] } as unknown as MediaService);
    const realtime = { alertUpdated: () => undefined, fieldRefresh: () => undefined, alertMoved: () => undefined, citizenAlertStatus: () => undefined } as unknown as RealtimeService;
    const notifications = { notifyAlertStatus: async () => undefined } as unknown as NotificationsService;
    const alertsSvc = { enqueue: async () => true } as unknown as AlertsService;
    const metrics = { aiProcessing: { observe: () => undefined } } as unknown as MetricsService;
    const events = new EventsService();
    ops = new OpsService(dbs, reads, events, realtime, notifications, incidents, alertsSvc);
    const transfers = { maybeAutoTransfer: async () => false } as unknown as TransferService;
    worker = new AiProcessor(env, new MockAiProvider(), dbs, {} as MediaService, events, reads, realtime, metrics, incidents, transfers);

    for (const [i, x] of [60, 62].entries()) {
      const [t] = await admin<{ id: string }[]>`
        INSERT INTO tenant (name, slug, boundary)
        VALUES (${'Tri ' + i}, ${`tri-test-${i}-${suffix}`}, ST_GeomFromGeoJSON(${box(x)})::geography) RETURNING id`;
      tenants.push(t.id);
      const [o] = await admin<{ id: string }[]>`
        INSERT INTO operator (tenant_id, email, password_hash, name, role)
        VALUES (${t.id}, ${`tri-${i}-${suffix}@test.cl`}, 'x', ${'Operadora ' + i}, 'OPERATOR') RETURNING id`;
      const claims: OperatorClaims = { kind: 'operator', sub: o.id, tenantId: t.id, role: 'OPERATOR' };
      if (i === 0) opA = claims;
      else opB = claims;
    }
    const digits = String(Date.now()).slice(-6);
    for (let i = 0; i < 2; i++) {
      const [c] = await admin<{ id: string }[]>`
        INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5697${digits}${i}`}, 'v1', now()) RETURNING id`;
      citizens.push(c.id);
    }
  });

  afterAll(async () => {
    if (tenants.length) {
      await admin`DELETE FROM triage_label WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM alert_event WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM alert WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM incident WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM operator WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM tenant WHERE id IN ${admin(tenants)}`;
    }
    if (citizens.length) await admin`DELETE FROM citizen WHERE id IN ${admin(citizens)}`;
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('el worker guarda el triage con las reglas fijas (violencia intrafamiliar)', async () => {
    const id = await sos('Necesito la fuerza pública porque mi señora me está golpeando');
    await analyze(id);
    const r = await row(id);
    expect(r).toMatchObject({
      category: 'VIOLENCIA_AGRESION',
      subcategory: 'VIOLENCIA_INTRAFAMILIAR',
      priority: 'HIGH',
      suggested_agency: 'CARABINEROS',
    });
    const t = r.ai_triage as { version: string; rules: string[]; questions: string[]; provider: string };
    expect(t.version).toBe(TRIAGE_VERSION);
    expect(t.provider).toBe('mock');
    expect(t.rules).toContain('VIF');
    expect(t.questions.length).toBeGreaterThan(0);

    const detail = await ops.detail(opA, id);
    expect(detail.subcategory).toBe('VIOLENCIA_INTRAFAMILIAR');
    expect(detail.triage?.agencies[0].agency).toBe('CARABINEROS');
    expect(detail.triageLabel).toBeNull();
  });

  it('corregir la clasificación: manda el operador, queda etiqueta y la IA no la pisa al reanalizar', async () => {
    const id = await sos('hay algo raro, vengan');
    await analyze(id);
    expect((await row(id)).category).toBe('OTRO_EMERGENCIA');

    const detail = await ops.reclassify(opA, id, { category: 'SALUD', subcategory: 'INCONSCIENTE' });
    expect(detail).toMatchObject({ category: 'SALUD', subcategory: 'INCONSCIENTE' });
    expect(detail.triageLabel).toMatchObject({ category: 'SALUD', classifiedBy: 'Operadora 0' });
    expect(detail.events.at(-1)?.kind).toBe('RECLASSIFIED');

    const [label] = await admin<{ ai_category: string; ai_version: string }[]>`
      SELECT ai_category, ai_version FROM triage_label WHERE alert_id = ${id}`;
    expect(label).toEqual({ ai_category: 'OTRO_EMERGENCIA', ai_version: TRIAGE_VERSION });

    await admin`UPDATE alert SET ai_status = 'QUEUED' WHERE id = ${id}`;
    await analyze(id);
    expect(await row(id)).toMatchObject({ category: 'SALUD', subcategory: 'INCONSCIENTE' });
  });

  it('rechaza una categoría de otro tipo y una subcategoría con formato inválido', async () => {
    const id = await sos(null);
    await expect(ops.reclassify(opA, id, { category: 'BACHE' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      admin`INSERT INTO triage_label (tenant_id, alert_id, category, subcategory, classified_at)
            VALUES (${opA.tenantId}, ${id}, 'SALUD', 'mal formato', now())`,
    ).rejects.toThrow();
  });

  it('derivado a: registra las instituciones y la segunda vez reemplaza la lista', async () => {
    const id = await sos('se cayó mi vecino y está sangrando');
    await analyze(id);
    let detail = await ops.refer(opA, id, { agencies: ['SAMU'] });
    expect(detail.triageLabel).toMatchObject({ agencies: ['SAMU'], referredBy: 'Operadora 0', category: null });
    detail = await ops.refer(opA, id, { agencies: ['SAMU', 'CARABINEROS'], notes: 'SAMU confirma móvil' });
    expect(detail.triageLabel?.agencies).toEqual(['SAMU', 'CARABINEROS']);
    expect(detail.events.filter((e) => e.kind === 'REFERRED')).toHaveLength(2);
  });

  it('un operador de otro municipio no puede corregir ni derivar', async () => {
    const id = await sos('me están asaltando');
    await expect(ops.reclassify(opB, id, { category: 'SALUD' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ops.refer(opB, id, { agencies: ['CARABINEROS'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rows = await dbs.asOperator(opB.tenantId, opB.sub, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from triage_label`),
    );
    expect([...rows][0].n).toBe(0);
  });

  it('si la IA falla del todo, igual se clasifica con las reglas fijas (no queda "sin clasificar")', async () => {
    const id = await sos('hay un incendio grande en la esquina, sale mucho humo');
    const job = { data: { alertId: id }, attemptsMade: 3, opts: { attempts: 3 }, id: `f-${id}` } as unknown as Job<ProcessAlertJob>;
    await worker.onFailed(job, new Error('429 cuota agotada'));
    const r = await row(id);
    expect(r).toMatchObject({ category: 'INCENDIO', priority: 'HIGH', suggested_agency: 'BOMBEROS' });
    const [a] = await admin<{ ai_status: string; ai_error: string }[]>`SELECT ai_status, ai_error FROM alert WHERE id = ${id}`;
    expect(a.ai_status).toBe('FAILED');
    expect(a.ai_error).toContain('reglas fijas');

    // Sin texto (SOS por botón) queda la falla segura de siempre.
    const button = await sos(null);
    await worker.onFailed({ ...job, data: { alertId: button } } as unknown as Job<ProcessAlertJob>, new Error('caída'));
    expect(await row(button)).toMatchObject({ category: 'OTRO_EMERGENCIA', priority: 'HIGH', ai_triage: null });
  });

  it('la supresión del vecino borra el triage y conserva la etiqueta', async () => {
    const id = await sos('mi pololo me amenaza con un cuchillo', 1);
    await analyze(id);
    const before = await row(id);
    expect(before.ai_triage).not.toBeNull();
    await ops.refer(opA, id, { agencies: ['CARABINEROS'] });
    await dbs.asCitizen(citizens[1], (tx) => tx.execute(sql`select erase_citizen(${citizens[1]}::uuid)`));
    const r = await row(id);
    expect(r.ai_triage).toBeNull();
    expect(r.category).toBe(before.category); // la clasificación es registro municipal y se conserva
    const [label] = await admin<{ agencies: string }[]>`SELECT agencies::text AS agencies FROM triage_label WHERE alert_id = ${id}`;
    expect(label.agencies).toBe('{CARABINEROS}');
  });
});
