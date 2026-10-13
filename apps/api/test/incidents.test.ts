/**
 * Incidentes contra base real (pnpm test:db, migración 0004): agrupar reportes de la misma
 * situación, contar vecinos distintos, recurrencia, ventana de los SOS y resolución en grupo.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertReadService } from '../src/alerts/alert-read.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { EventsService } from '../src/events/events.service';
import { IncidentsService, loadIncidentInfos } from '../src/incidents/incidents.service';
import type { MediaService } from '../src/media/media.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { OpsService } from '../src/ops/ops.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

// Municipio de prueba lejos de todo: lng/lat 50..51. 0.0002° de latitud ≈ 22 m.
const BOX = JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[50, 50], [51, 50], [51, 51], [50, 51], [50, 50]]]] });
const HERE = { lat: 50.5, lng: 50.5 };

d('incidentes', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let incidents: IncidentsService;
  let ops: OpsService;
  let tenantId: string;
  let operator: OperatorClaims;
  const citizens: string[] = [];
  const suffix = Date.now().toString(36);

  /** Inserta una alerta como lo haría la API (el trigger fija el municipio) y la agrupa. */
  async function report(o: {
    citizen: number;
    type?: 'CIVIC_REPORT' | 'EMERGENCY_SOS';
    category?: string | null;
    dLat?: number;
    minutesAgo?: number;
  }) {
    const type = o.type ?? 'CIVIC_REPORT';
    const category = o.category === undefined ? (type === 'CIVIC_REPORT' ? 'BACHE' : null) : o.category;
    const [a] = await admin<{ id: string }[]>`
      INSERT INTO alert (citizen_id, type, source, lat, lng, category, priority, created_at)
      VALUES (${citizens[o.citizen]}, ${type}, ${type === 'CIVIC_REPORT' ? 'FORM' : 'BUTTON'}, ${HERE.lat + (o.dLat ?? 0)}, ${HERE.lng},
              ${category}, ${type === 'CIVIC_REPORT' ? 'LOW' : null}, now() - make_interval(mins => ${o.minutesAgo ?? 0}))
      RETURNING id`;
    const r = await incidents.attach(a.id);
    return { id: a.id, incidentId: r!.incidentId, joined: r!.joined };
  }

  const info = async (incidentId: string) => (await dbs.asSystem((tx) => loadIncidentInfos(tx, [incidentId]))).get(incidentId)!;

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    incidents = new IncidentsService(dbs);
    const reads = new AlertReadService({ toPublic: async () => [] } as unknown as MediaService);
    const realtime = { alertUpdated: () => undefined, citizenAlertStatus: () => undefined } as unknown as RealtimeService;
    const notifications = { notifyAlertStatus: async () => undefined } as unknown as NotificationsService;
    ops = new OpsService(dbs, reads, new EventsService(), realtime, notifications, incidents);

    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary) VALUES ('Inc', ${'inc-test-' + suffix}, ST_GeomFromGeoJSON(${BOX})::geography) RETURNING id`;
    tenantId = t.id;
    const [o] = await admin<{ id: string }[]>`
      INSERT INTO operator (tenant_id, email, password_hash, name, role) VALUES (${tenantId}, ${'inc-' + suffix + '@test.cl'}, 'x', 'Op', 'OPERATOR') RETURNING id`;
    operator = { kind: 'operator', sub: o.id, tenantId, role: 'OPERATOR' };
    const digits = String(Date.now()).slice(-6);
    for (let i = 0; i < 4; i++) {
      const [c] = await admin<{ id: string }[]>`
        INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5698${digits}${i}`}, 'v1', now()) RETURNING id`;
      citizens.push(c.id);
    }
  });

  afterAll(async () => {
    if (tenantId) {
      await admin`DELETE FROM alert_event WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM dispatch WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM alert WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM incident WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM operator WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM tenant WHERE id = ${tenantId}`;
    }
    if (citizens.length) await admin`DELETE FROM citizen WHERE id IN ${admin(citizens)}`;
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('el mismo bache reportado por tres vecinos es un solo incidente de importancia media', async () => {
    const a = await report({ citizen: 0 });
    const b = await report({ citizen: 1, dLat: 0.0002 });
    const c = await report({ citizen: 2, dLat: -0.0002 });
    expect(a.joined).toBe(false);
    expect([b.joined, c.joined]).toEqual([true, true]);
    expect(new Set([a.incidentId, b.incidentId, c.incidentId]).size).toBe(1);

    const i = await info(a.incidentId);
    expect(i).toMatchObject({ alertCount: 3, citizenCount: 3, openCount: 3, level: 'MEDIA', primaryAlertId: a.id });
    expect(i.reasons).toContain('MANY_CITIZENS');

    // El mismo vecino insistiendo no sube la importancia.
    await report({ citizen: 2, dLat: 0.0001 });
    expect(await info(a.incidentId)).toMatchObject({ alertCount: 4, citizenCount: 3, importance: i.importance });
  });

  it('otra categoría en el mismo lugar o el mismo problema lejos son otros incidentes', async () => {
    const base = await report({ citizen: 0, dLat: 0.01 });
    const light = await report({ citizen: 1, dLat: 0.01, category: 'LUMINARIA' });
    const far = await report({ citizen: 1, dLat: 0.01 + 0.004 }); // ~440 m
    expect(light.incidentId).not.toBe(base.incidentId);
    expect(far.incidentId).not.toBe(base.incidentId);
  });

  it('una alerta cancelada deja de contar en su grupo', async () => {
    const a = await report({ citizen: 0, dLat: 0.02 });
    const b = await report({ citizen: 1, dLat: 0.02 });
    expect((await info(a.incidentId)).citizenCount).toBe(2);
    await admin`UPDATE alert SET status = 'CANCELLED' WHERE id = ${b.id}`;
    await incidents.attach(b.id);
    expect(await info(a.incidentId)).toMatchObject({ citizenCount: 1, openCount: 1 });
  });

  it('resolver con el grupo cierra todos los reportes; si el problema vuelve, es recurrente', async () => {
    const a = await report({ citizen: 0, dLat: 0.03 });
    const b = await report({ citizen: 1, dLat: 0.03 });
    await ops.resolve(operator, a.id, 'Bache tapado', true);
    const statuses = await admin<{ status: string }[]>`SELECT status FROM alert WHERE incident_id = ${a.incidentId}`;
    expect(statuses.map((s) => s.status)).toEqual(['RESOLVED', 'RESOLVED']);
    const [ev] = await admin<{ payload: { viaAlertId?: string } }[]>`
      SELECT payload FROM alert_event WHERE alert_id = ${b.id} AND kind = 'RESOLVED'`;
    expect(ev.payload.viaAlertId).toBe(a.id);

    // Reaparece en el mismo lugar: incidente nuevo marcado como recurrente.
    const again = await report({ citizen: 3, dLat: 0.03 });
    expect(again.incidentId).not.toBe(a.incidentId);
    const i = await info(again.incidentId);
    expect(i.recurrenceCount).toBe(1);
    expect(i.reasons).toContain('RECURRENT');
  });

  it('SOS: vecinos cerca en minutos se agrupan; media hora después es otro hecho', async () => {
    const first = await report({ citizen: 0, type: 'EMERGENCY_SOS', dLat: 0.05, minutesAgo: 2 });
    const near = await report({ citizen: 1, type: 'EMERGENCY_SOS', dLat: 0.05 + 0.0009 }); // ~100 m
    expect(near.incidentId).toBe(first.incidentId);
    expect(await info(first.incidentId)).toMatchObject({ citizenCount: 2, level: 'CRITICA' });

    const old = await report({ citizen: 2, type: 'EMERGENCY_SOS', dLat: 0.06, minutesAgo: 40 });
    const later = await report({ citizen: 3, type: 'EMERGENCY_SOS', dLat: 0.06 });
    expect(later.incidentId).not.toBe(old.incidentId);
  });

  it('separar del grupo deja la alerta sola y recalcula el grupo anterior', async () => {
    const a = await report({ citizen: 0, dLat: 0.07 });
    const b = await report({ citizen: 1, dLat: 0.07 });
    const detail = await ops.detach(operator, b.id);
    expect(detail.incident?.id).not.toBe(a.incidentId);
    expect(detail.incident?.alertCount).toBe(1);
    expect(await info(a.incidentId)).toMatchObject({ alertCount: 1, citizenCount: 1 });
  });
});
