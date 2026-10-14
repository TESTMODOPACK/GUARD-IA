/**
 * Uso indebido, etapa 3, contra base real (pnpm test:db, migración 0011): cuenta restringida, propuesta y
 * aprobación de bloqueo (dos personas), bloqueo que rechaza alertas, revisión del vecino, anulación de faltas,
 * prueba repetida y reincidencia.
 */
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCitizenAccount } from '../src/accounts/account-read';
import { AccountsService } from '../src/accounts/accounts.service';
import { CitizenAccountService } from '../src/accounts/citizen-account.service';
import { capPriority } from '../src/ai/ai.processor';
import { AlertReadService } from '../src/alerts/alert-read.service';
import type { AlertsService } from '../src/alerts/alerts.service';
import { AuditService } from '../src/auth/audit.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { EventsService } from '../src/events/events.service';
import { IncidentsService } from '../src/incidents/incidents.service';
import type { RateLimitService } from '../src/infra/rate-limit.service';
import type { MediaService } from '../src/media/media.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { OpsService } from '../src/ops/ops.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const X = 74.5; // dentro de la caja del municipio de prueba (74 a 75 grados)
const box = JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[74, 74], [75, 74], [75, 75], [74, 75], [74, 74]]]] });
const EVIDENCE = 'El vecino admitió que era una broma para un amigo';

d('uso indebido: restricción, bloqueo y revisión', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let ops: OpsService;
  let accounts: AccountsService;
  let mine: CitizenAccountService;
  let tenantId: string;
  let operator: OperatorClaims;
  let supervisor: OperatorClaims;
  let administrator: OperatorClaims;
  const citizens: string[] = [];
  const pushed: { kind: 'alert' | 'account'; title: string }[] = [];
  const suffix = Date.now().toString(36);

  /** Como lo inserta POST /alerts: en contexto del vecino, sin prioridad (la RLS lo exige) y por la geocerca. */
  async function sos(c = 0, type: 'EMERGENCY_SOS' | 'CIVIC_REPORT' = 'EMERGENCY_SOS') {
    try {
      return await dbs.asCitizen(citizens[c], async (tx) => {
        const rows = await tx.execute<{ id: string; priority: string | null; citizen_restricted: boolean }>(sql`
          INSERT INTO alert (citizen_id, type, source, lat, lng, user_text, category)
          VALUES (${citizens[c]}::uuid, ${type}::alert_type, ${type === 'CIVIC_REPORT' ? 'FORM' : 'BUTTON'}::alert_source,
                  ${X}, ${X}, 'vengan', ${type === 'CIVIC_REPORT' ? 'BACHE' : null}::alert_category)
          RETURNING id, priority, citizen_restricted`);
        return rows[0];
      });
    } catch (e) {
      // Drizzle envuelve el error de Postgres; se expone su SQLSTATE (GIA10/GIA11) como en alerts.service.
      throw (e as { cause?: unknown }).cause ?? e;
    }
  }
  const falseAlarm = async (by: OperatorClaims, c = 0) => {
    const a = await sos(c);
    await ops.reject(by, a.id, { reason: 'FALSE_ALARM', notes: EVIDENCE });
    return a.id;
  };
  const account = (c = 0) => dbs.asCitizen(citizens[c], (tx) => loadCitizenAccount(tx, citizens[c]));

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    const reads = new AlertReadService({ toPublic: async () => [] } as unknown as MediaService);
    const realtime = {
      alertUpdated: () => undefined,
      fieldRefresh: () => undefined,
      dispatchUpdated: () => undefined,
      unitUpdated: () => undefined,
      citizenAlertStatus: () => undefined,
    } as unknown as RealtimeService;
    const notifications = {
      notifyAlertStatus: async (_c: string, _t: string, _v: unknown, text: { title: string }) => {
        pushed.push({ kind: 'alert', title: text.title });
      },
      notifyAccount: async (_c: string, _l: string, text: { title: string }) => {
        pushed.push({ kind: 'account', title: text.title });
      },
    } as unknown as NotificationsService;
    ops = new OpsService(dbs, reads, new EventsService(), realtime, notifications, new IncidentsService(dbs), {
      enqueue: async () => true,
    } as unknown as AlertsService);
    accounts = new AccountsService(dbs, new AuditService(), notifications);
    mine = new CitizenAccountService(dbs, { hit: async () => undefined } as unknown as RateLimitService);

    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary)
      VALUES ('Municipalidad Cuentas', ${'cuentas-test-' + suffix}, ST_GeomFromGeoJSON(${box})::geography) RETURNING id`;
    tenantId = t.id;
    const roles = ['OPERATOR', 'SUPERVISOR', 'ADMIN'] as const;
    const claims: OperatorClaims[] = [];
    for (const role of roles) {
      const [o] = await admin<{ id: string }[]>`
        INSERT INTO operator (tenant_id, email, password_hash, name, role)
        VALUES (${tenantId}, ${`cuentas-${role.toLowerCase()}-${suffix}@test.cl`}, 'x', ${'Cuentas ' + role}, ${role}::operator_role)
        RETURNING id`;
      claims.push({ kind: 'operator', sub: o.id, tenantId, role });
    }
    [operator, supervisor, administrator] = claims;
    const digits = String(Date.now()).slice(-6);
    for (let i = 0; i < 2; i++) {
      const [c] = await admin<{ id: string }[]>`
        INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5694${digits}${i}`}, 'v1', now()) RETURNING id`;
      citizens.push(c.id);
    }
  });

  afterAll(async () => {
    if (tenantId) {
      await admin`DELETE FROM citizen_review WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM citizen_block WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM citizen_strike WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM triage_label WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM alert_event WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM dispatch WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM alert WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM incident WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM operator WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM tenant WHERE id = ${tenantId}`;
    }
    if (citizens.length) await admin`DELETE FROM citizen WHERE id IN ${admin(citizens)}`;
    await admin?.end({ timeout: 5 });
    await dbs?.onModuleDestroy();
  });

  it('una frase de riesgo vital nunca deja en media el SOS de una cuenta restringida', () => {
    const base = { type: 'EMERGENCY_SOS' as const, trustScore: 100, restricted: true };
    expect(capPriority('HIGH', { ...base, text: 'vengan rápido' })).toBe('MEDIUM');
    expect(capPriority('HIGH', { ...base, text: 'le dispararon a mi hermano, está sangrando' })).toBe('HIGH');
    expect(capPriority('HIGH', { ...base, restricted: false, text: 'vengan rápido' })).toBe('HIGH');
    expect(capPriority('HIGH', { ...base, restricted: false, trustScore: 10, text: 'vengan rápido' })).toBe('MEDIUM');
  });

  it('dos faltas restringen la cuenta: el SOS entra con la marca y el reporte urbano se rechaza', async () => {
    await falseAlarm(operator);
    expect((await account()).level).toBe('WARNED');
    await falseAlarm(operator);
    const acc = await account();
    expect(acc).toMatchObject({ level: 'RESTRICTED', activeStrikes: 2, block: null });
    expect(acc.restrictedUntil).not.toBeNull();

    const s = await sos();
    expect(s).toMatchObject({ priority: null, citizen_restricted: true });
    await expect(sos(0, 'CIVIC_REPORT')).rejects.toMatchObject({ code: 'GIA11' });
    const detail = await ops.detail(operator, s.id);
    expect(detail.citizenRestricted).toBe(true);
    // Se cierra para no dejarla abierta en la cola de prueba.
    await ops.reject(operator, s.id, { reason: 'DUPLICATE' });
  });

  it('la tercera falta propone el bloqueo; quien propone no decide; aprobado, la cuenta no envía alertas', async () => {
    const third = await falseAlarm(operator);
    const [b] = await admin<{ id: string; status: string; suggested_days: number; strikes: number; alert_id: string }[]>`
      SELECT id, status, suggested_days, strikes, alert_id FROM citizen_block WHERE citizen_id = ${citizens[0]}`;
    expect(b).toMatchObject({ status: 'PROPOSED', suggested_days: 30, strikes: 3, alert_id: third });
    expect(pushed.at(-1)?.title).toBe('Tu cuenta está en revisión');

    const next = await sos();
    expect((await ops.citizenStanding(operator, next.id)).openBlock).toBe('PROPOSED');
    await ops.reject(operator, next.id, { reason: 'DUPLICATE' });

    await expect(accounts.decideBlock(operator, b.id, { approve: true, days: 30, note: 'tres bromas' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(accounts.decideBlock(supervisor, b.id, { approve: true, days: null, note: 'sin plazo' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const overview = await accounts.decideBlock(supervisor, b.id, { approve: true, days: 30, note: 'Tres avisos falsos confirmados' });
    expect(overview.proposals).toHaveLength(0);
    expect(overview.activeBlocks[0]).toMatchObject({ id: b.id, days: 30, decidedBy: 'Cuentas SUPERVISOR' });
    expect(pushed.at(-1)).toEqual({ kind: 'account', title: 'Tu cuenta fue bloqueada' });

    await expect(sos()).rejects.toMatchObject({ code: 'GIA10' });
    const acc = await account();
    expect(acc).toMatchObject({ level: 'BLOCKED', block: { tenantName: 'Municipalidad Cuentas' } });
    expect(new Date(acc.block!.endsAt!).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const [log] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenantId} AND kind = 'CITIZEN_BLOCKED'`;
    expect(log.n).toBe(1);
  });

  it('el vecino pide revisión; el municipio la acoge, levanta el bloqueo y le responde', async () => {
    const before = await mine.detail(citizens[0]);
    expect(before.block).toMatchObject({ status: 'ACTIVE', reviewStatus: null });
    expect(before.strikes).toHaveLength(3);

    const after = await mine.createReview(citizens[0], { blockId: before.block!.id, text: 'Me prestaron el teléfono y no fui yo' });
    expect(after.block?.reviewStatus).toBe('PENDING');
    expect(after.reviews[0]).toMatchObject({ target: 'BLOCK', status: 'PENDING', tenantName: 'Municipalidad Cuentas' });
    await expect(
      mine.createReview(citizens[0], { blockId: before.block!.id, text: 'Lo vuelvo a pedir, no fui yo' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Otro vecino no puede pedir revisión de una falta ajena.
    await expect(mine.createReview(citizens[1], { strikeId: before.strikes[0].id, text: 'esta falta no es mía' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const pending = await accounts.overview(supervisor);
    expect(pending.reviews).toHaveLength(1);
    expect(pending.reviews[0].targetSummary).toMatch(/^Bloqueo hasta el /);
    await accounts.resolveReview(supervisor, pending.reviews[0].id, { grant: true, response: 'Revisamos el caso y levantamos el bloqueo' });
    expect(pushed.at(-1)).toEqual({ kind: 'account', title: 'Acogimos tu solicitud de revisión' });

    const resolved = await mine.detail(citizens[0]);
    expect(resolved.block).toBeNull();
    expect(resolved.reviews[0]).toMatchObject({ status: 'GRANTED', response: 'Revisamos el caso y levantamos el bloqueo' });
    // Sin bloqueo vuelve a poder pedir ayuda (sigue restringida: 3 faltas vigentes).
    const s = await sos();
    expect(s).toMatchObject({ priority: null, citizen_restricted: true });
    await ops.reject(operator, s.id, { reason: 'DUPLICATE' });
  });

  it('anular una falta devuelve la confianza, avisa y baja la cuenta de nivel', async () => {
    const [t0] = await admin<{ t: number }[]>`SELECT trust_score AS t FROM citizen WHERE id = ${citizens[0]}`;
    const list = await accounts.overview(supervisor);
    const strike = list.strikes.find((s) => !s.annulledAt)!;
    await accounts.annulStrike(supervisor, strike.id, { reason: 'Era otra persona con el teléfono' });
    expect(pushed.at(-1)).toEqual({ kind: 'account', title: 'Anulamos una advertencia' });
    const [t1] = await admin<{ t: number }[]>`SELECT trust_score AS t FROM citizen WHERE id = ${citizens[0]}`;
    expect(t1.t).toBe(Math.min(100, t0.t + 25));
    expect((await account()).activeStrikes).toBe(2);
    await expect(accounts.annulStrike(supervisor, strike.id, { reason: 'otra vez' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('una prueba repetida cuenta como falta; con un bloqueo cumplido el año pasado se sugieren 6 meses', async () => {
    const first = await sos(1);
    await ops.reject(operator, first.id, { reason: 'TEST' });
    expect((await account(1)).activeStrikes).toBe(0);
    const second = await sos(1);
    await ops.reject(operator, second.id, { reason: 'TEST' });
    const [st] = await admin<{ note: string }[]>`SELECT note FROM citizen_strike WHERE alert_id = ${second.id}`;
    expect(st.note).toMatch(/^Segunda alerta de prueba en 90 días/);
    expect(pushed.at(-1)?.title).toBe('Advertencia por aviso falso');

    // Un bloqueo ya cumplido hace 2 meses: la próxima propuesta es por 6 meses.
    await admin`
      INSERT INTO citizen_block (citizen_id, tenant_id, status, strikes, suggested_days, days, starts_at, ends_at,
                                 proposed_by, proposed_at, decided_by, decided_at)
      VALUES (${citizens[1]}, ${tenantId}, 'EXPIRED', 3, 30, 30, now() - interval '90 days', now() - interval '60 days',
              ${operator.sub}, now() - interval '90 days', ${supervisor.sub}, now() - interval '90 days')`;
    await falseAlarm(operator, 1);
    await falseAlarm(operator, 1);
    const [p] = await admin<{ suggested_days: number }[]>`
      SELECT suggested_days FROM citizen_block WHERE citizen_id = ${citizens[1]} AND status = 'PROPOSED'`;
    expect(p.suggested_days).toBe(180);
    // El administrador puede descartarla.
    const ov = await accounts.overview(administrator);
    const prop = ov.proposals.find((x) => x.citizen.id === citizens[1])!;
    await accounts.decideBlock(administrator, prop.id, { approve: false, note: 'Se conversó con el vecino' });
    expect((await accounts.overview(administrator)).proposals.find((x) => x.citizen.id === citizens[1])).toBeUndefined();
  });

  it('la supresión de la cuenta borra el texto de las revisiones', async () => {
    await dbs.asCitizen(citizens[0], (tx) => tx.execute(sql`SELECT erase_citizen(${citizens[0]}::uuid)`));
    const [r] = await admin<{ text: string }[]>`SELECT text FROM citizen_review WHERE citizen_id = ${citizens[0]}`;
    expect(r.text).toBe('[suprimido por el vecino]');
  });
});
