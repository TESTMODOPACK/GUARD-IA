/**
 * Ley 21.719, etapa 1 contra base real (pnpm test:db, migración 0014): el aviso nombra al proveedor configurado, el
 * consentimiento exige la versión y el aviso vigentes y deja prueba, el vecino puede oponerse a la IA externa, el worker
 * no envía nada a un proveedor que el municipio no autorizó, contacto de privacidad, incidentes y RLS de las tablas
 * nuevas.
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSENT_VERSION, ConsentSchema, type AiClassification } from '@guardia/shared';
import { AiProcessor } from '../src/ai/ai.processor';
import type { AiProvider, ClassifyInput } from '../src/ai/ai.provider';
import type { ProcessAlertJob } from '../src/ai/ai.queue';
import { MockAiProvider } from '../src/ai/mock.provider';
import { AlertReadService } from '../src/alerts/alert-read.service';
import { AuditService } from '../src/auth/audit.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import type { SmsProvider } from '../src/auth/sms/sms.provider';
import type { TokenService } from '../src/auth/token.service';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv, type Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { EventsService } from '../src/events/events.service';
import type { TransferService } from '../src/geo/transfer.service';
import { IncidentsService } from '../src/incidents/incidents.service';
import type { MetricsService } from '../src/infra/metrics.service';
import type { RateLimitService } from '../src/infra/rate-limit.service';
import { activeAiKey, LegalService } from '../src/legal/legal.service';
import { TenantPrivacyService } from '../src/legal/tenant-privacy.service';
import type { MediaService } from '../src/media/media.service';
import { PlatformComplianceService } from '../src/platform/compliance.service';
import { PlatformAuditService } from '../src/platform/platform-audit.service';
import type { PlatformClaims } from '../src/platform/platform-tokens.service';
import { PrivacyService } from '../src/privacy/privacy.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const box = (x: number) =>
  JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[x, x], [x + 1, x], [x + 1, x + 1], [x, x + 1], [x, x]]]] });

/** Proveedor "externo" de prueba: cuenta cada llamada para saber si algo salió del servidor. */
class ExternalStub implements AiProvider {
  readonly name = 'openai' as const;
  readonly model = 'stub-externo';
  calls = 0;
  private readonly local = new MockAiProvider();
  async transcribe() {
    this.calls++;
    return { text: '' };
  }
  async classify(input: ClassifyInput): Promise<AiClassification> {
    this.calls++;
    return this.local.classify(input);
  }
}

d('Ley 21.719: poder demostrar (0014)', () => {
  let env: Env;
  let dbs: DbService;
  let admin: postgres.Sql;
  let legal: LegalService;
  let auth: AuthService;
  let worker: AiProcessor;
  let stub: ExternalStub;
  let compliance: PlatformComplianceService;
  let privacySvc: TenantPrivacyService;
  let reads: AlertReadService;
  const tenants: string[] = [];
  const citizens: string[] = [];
  const incidentIds: string[] = [];
  const ops: OperatorClaims[] = [];
  let platform: PlatformClaims;
  let groqId: string;
  const suffix = Date.now().toString(36);

  async function sos(citizen: string, text: string) {
    const [a] = await admin<{ id: string }[]>`
      INSERT INTO alert (citizen_id, type, source, lat, lng, user_text)
      VALUES (${citizen}, 'EMERGENCY_SOS', 'VOICE', 64.5, 64.5, ${text}) RETURNING id`;
    return a.id;
  }
  const analyze = (alertId: string) =>
    worker.process({ data: { alertId }, attemptsMade: 0, opts: {}, id: `t-${alertId}` } as unknown as Job<ProcessAlertJob>);
  const aiOf = async (id: string) =>
    (await admin<{ ai_status: string; ai_error: string | null }[]>`SELECT ai_status, ai_error FROM alert WHERE id = ${id}`)[0];

  beforeAll(async () => {
    env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    // La IA "externa" de estas pruebas es Groq, aunque el .env local use otra o ninguna.
    legal = new LegalService(
      { ...env, AI_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://api.groq.com/openai/v1', AI_PROCESSOR_KEY: undefined },
      dbs,
    );
    auth = new AuthService(
      env,
      {} as SmsProvider,
      dbs,
      {} as TokenService,
      {} as RateLimitService,
      new AuditService(),
      legal,
    );
    const incidents = new IncidentsService(dbs);
    reads = new AlertReadService({ toPublic: async () => [] } as unknown as MediaService);
    const realtime = {
      alertUpdated: () => undefined,
      alertMoved: () => undefined,
      fieldRefresh: () => undefined,
    } as unknown as RealtimeService;
    const metrics = { aiProcessing: { observe: () => undefined } } as unknown as MetricsService;
    const transfers = { maybeAutoTransfer: async () => false } as unknown as TransferService;
    stub = new ExternalStub();
    worker = new AiProcessor(env, stub, dbs, {} as MediaService, new EventsService(), reads, realtime, metrics, incidents, transfers, legal);
    compliance = new PlatformComplianceService(dbs, new PlatformAuditService(dbs), legal);
    privacySvc = new TenantPrivacyService(dbs, new AuditService());

    for (const [i, x] of [64, 66].entries()) {
      const [t] = await admin<{ id: string }[]>`
        INSERT INTO tenant (name, slug, boundary)
        VALUES (${'Ley ' + i}, ${`ley-test-${i}-${suffix}`}, ST_GeomFromGeoJSON(${box(x)})::geography) RETURNING id`;
      tenants.push(t.id);
      const [o] = await admin<{ id: string }[]>`
        INSERT INTO operator (tenant_id, email, password_hash, name, role)
        VALUES (${t.id}, ${`ley-${i}-${suffix}@test.cl`}, 'x', ${'Admin ' + i}, 'ADMIN') RETURNING id`;
      ops.push({ kind: 'operator', sub: o.id, tenantId: t.id, role: 'ADMIN' });
    }
    const digits = String(Date.now()).slice(-6);
    for (let i = 0; i < 2; i++) {
      const [c] = await admin<{ id: string }[]>`
        INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5696${digits}${i}`}, 'v1', now()) RETURNING id`;
      citizens.push(c.id);
    }
    const [u] = await admin<{ id: string }[]>`
      INSERT INTO platform_user (email, name, role, password_hash)
      VALUES (${`ley-test-${suffix}@guardia.test`}, 'Prueba Ley', 'SUPERADMIN', 'sin-acceso-solo-para-pruebas') RETURNING id`;
    platform = { kind: 'platform', sub: u.id, role: 'SUPERADMIN' };
    [{ id: groqId }] = await admin<{ id: string }[]>`SELECT id FROM subprocessor WHERE key = 'groq'`;
  });

  afterAll(async () => {
    if (!admin) return;
    if (incidentIds.length) {
      await admin`DELETE FROM security_incident_tenant WHERE incident_id IN ${admin(incidentIds)}`;
      await admin`DELETE FROM security_incident WHERE id IN ${admin(incidentIds)}`;
    }
    if (tenants.length) {
      await admin`DELETE FROM audit_log WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM tenant_subprocessor WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM tenant_privacy WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM triage_label WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM alert_event WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM alert WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM incident WHERE tenant_id IN ${admin(tenants)}`;
      await admin`DELETE FROM operator WHERE tenant_id IN ${admin(tenants)}`;
    }
    if (platform) await admin`DELETE FROM platform_audit_log WHERE actor_id = ${platform.sub}`;
    if (tenants.length) await admin`DELETE FROM tenant WHERE id IN ${admin(tenants)}`;
    if (citizens.length) {
      await admin`DELETE FROM consent_record WHERE citizen_id IN ${admin(citizens)}`;
      await admin`DELETE FROM citizen WHERE id IN ${admin(citizens)}`;
    }
    if (platform) await admin`DELETE FROM platform_user WHERE id = ${platform.sub}`;
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('el aviso nombra al proveedor de IA configurado, no uno escrito a mano', async () => {
    const notice = await legal.notice();
    expect(notice.version).toBe(CONSENT_VERSION);
    expect(notice.externalAi).toMatchObject({ name: 'Groq', country: 'Estados Unidos' });
    expect(notice.sections.find((s) => s.key === 'ai')?.text).toContain('Groq');
    expect(JSON.stringify(notice)).not.toContain('OpenAI');
    expect(notice.hash).toMatch(/^[0-9a-f]{64}$/);

    const local = await new LegalService({ ...env, AI_PROVIDER: 'mock' }, dbs).notice();
    expect(local.externalAi).toBeNull();
    expect(local.hash).not.toBe(notice.hash);

    expect(activeAiKey({ ...env, AI_PROVIDER: 'openai', OPENAI_BASE_URL: undefined, AI_PROCESSOR_KEY: undefined })).toBe('openai');
    expect(activeAiKey({ ...env, AI_PROVIDER: 'mock' })).toBeNull();
    expect(activeAiKey({ ...env, AI_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://llm.example.cl/v1', AI_PROCESSOR_KEY: undefined })).toBe(
      'llm-example-cl',
    );
  });

  it('el consentimiento exige la versión y el aviso vigentes, y deja la prueba de qué se aceptó', async () => {
    const notice = await legal.notice();
    const body = { version: CONSENT_VERSION, noticeHash: notice.hash, externalAi: false, ageConfirmed: true as const, platform: 'android' as const };
    await expect(auth.acceptConsent(citizens[0], { ...body, version: '2026-10-v1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(auth.acceptConsent(citizens[0], { ...body, noticeHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ConsentSchema.safeParse({ ...body, ageConfirmed: false }).success).toBe(false);

    await auth.acceptConsent(citizens[0], body);
    const rows = await admin<{ purpose: string; action: string; text_hash: string; body: { sections: unknown[] } }[]>`
      SELECT r.purpose, r.action, n.text_hash, n.body FROM consent_record r JOIN consent_notice n ON n.id = r.notice_id
       WHERE r.citizen_id = ${citizens[0]} ORDER BY r.purpose`;
    expect(rows.map((r) => [r.purpose, r.action])).toEqual([
      ['SERVICE', 'GRANTED'],
      ['EXTERNAL_AI', 'REVOKED'],
    ]);
    expect(rows[0].text_hash).toBe(notice.hash);
    expect(rows[0].body.sections.length).toBe(notice.sections.length);
    const [c] = await admin<{ consent_version: string; external_ai: boolean; age_declared_at: Date | null }[]>`
      SELECT consent_version, external_ai, age_declared_at FROM citizen WHERE id = ${citizens[0]}`;
    expect(c).toMatchObject({ consent_version: CONSENT_VERSION, external_ai: false });
    expect(c.age_declared_at).not.toBeNull();
  });

  it('el vecino vuelve a aceptar la IA externa desde «Mis datos» y la exportación trae el historial', async () => {
    const me = await auth.setExternalAi(citizens[0], true);
    expect(me.externalAi).toBe(true);
    const exported = await new PrivacyService(dbs, {} as MediaService).export(citizens[0]);
    expect(exported.citizen.externalAi).toBe(true);
    expect(exported.consents.map((x) => `${x.purpose}:${x.action}`)).toEqual([
      'SERVICE:GRANTED',
      'EXTERNAL_AI:REVOKED',
      'EXTERNAL_AI:GRANTED',
    ]);
    expect(exported.consents.every((x) => x.version === CONSENT_VERSION)).toBe(true);
  });

  it('el worker no envía nada a la IA externa sin autorización del municipio ni contra la oposición del vecino', async () => {
    // Sin autorización escrita del municipio: todo sin red, LOCAL, y el proveedor no recibe nada.
    const first = await sos(citizens[0], 'me están asaltando en la esquina');
    await analyze(first);
    expect(await aiOf(first)).toMatchObject({ ai_status: 'LOCAL', ai_error: expect.stringContaining('municipio') });
    expect(stub.calls).toBe(0);

    // Autorizado (queda en ambas bitácoras): ahora sí va a la IA externa.
    const auths = await compliance.authorize(
      platform,
      tenants[0],
      { subprocessorId: groqId, authorizedAt: '2026-10-15', authorizedBy: 'Alcaldesa de prueba', documentRef: 'Anexo 2 del contrato' },
      '127.0.0.1',
    );
    expect(auths.map((a) => a.key)).toEqual(['groq']);
    const [logs] = await admin<{ platform: number; tenant: number }[]>`
      SELECT (SELECT count(*)::int FROM platform_audit_log WHERE tenant_id = ${tenants[0]} AND action = 'SUBPROCESSOR_AUTHORIZED') AS platform,
             (SELECT count(*)::int FROM audit_log WHERE tenant_id = ${tenants[0]} AND kind = 'SUBPROCESSOR_AUTHORIZED'
                AND platform_actor_id = ${platform.sub}) AS tenant`;
    expect(logs).toEqual({ platform: 1, tenant: 1 });
    await expect(
      compliance.authorize(platform, tenants[0], { subprocessorId: groqId, authorizedAt: '2026-10-15', authorizedBy: 'x y', documentRef: 'x y' }, '127.0.0.1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // El catálogo cuenta los municipios que lo autorizaron; uno en uso sin autorizar aparece en la central del otro.
    const catalog = await compliance.subprocessors(platform);
    const groq = catalog.find((s) => s.key === 'groq')!;
    expect(groq.authorizedTenants).toBeGreaterThanOrEqual(1);
    await compliance.updateSubprocessor(platform, groqId, { inUse: true }, '127.0.0.1');
    try {
      expect((await privacySvc.overview(ops[1])).missingSubprocessors.map((m) => m.name)).toContain('Groq');
      expect((await privacySvc.overview(ops[0])).missingSubprocessors.map((m) => m.name)).not.toContain('Groq');
    } finally {
      await compliance.updateSubprocessor(platform, groqId, { inUse: groq.inUse }, '127.0.0.1');
    }

    const second = await sos(citizens[0], 'me están asaltando en la esquina');
    await analyze(second);
    expect((await aiOf(second)).ai_status).toBe('DONE');
    expect(stub.calls).toBeGreaterThan(0);

    // El vecino se opone: sin red aunque el municipio haya autorizado.
    const before = stub.calls;
    await auth.setExternalAi(citizens[0], false);
    const third = await sos(citizens[0], 'me están asaltando en la esquina');
    await analyze(third);
    expect(await aiOf(third)).toMatchObject({ ai_status: 'LOCAL', ai_error: expect.stringContaining('vecino') });
    expect(stub.calls).toBe(before);

    // El municipio revoca: desde ya, sin red.
    await auth.setExternalAi(citizens[0], true);
    await compliance.revoke(platform, tenants[0], auths[0].id, '127.0.0.1');
    const fourth = await sos(citizens[0], 'me están asaltando en la esquina');
    await analyze(fourth);
    expect((await aiOf(fourth)).ai_status).toBe('LOCAL');
    expect(stub.calls).toBe(before);
  });

  it('el contacto de privacidad lo fija el administrador, lo ve el vecino del caso y ningún otro municipio', async () => {
    const out = await privacySvc.update(ops[0], { contactEmail: 'Privacidad@Ley0.cl', dpoName: 'Delegada de prueba', dpoEmail: null });
    expect(out.privacy).toMatchObject({ contactEmail: 'privacidad@ley0.cl', dpoName: 'Delegada de prueba' });
    const [a] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenants[0]} AND kind = 'PRIVACY_CONTACT_UPDATED' AND actor_id = ${ops[0].sub}`;
    expect(a.n).toBe(1);

    const otherTenant = await dbs.asOperator(ops[1].tenantId, ops[1].sub, (tx) =>
      tx.execute(sql`SELECT tenant_id FROM tenant_privacy WHERE tenant_id = ${tenants[0]}`),
    );
    expect(otherTenant.length).toBe(0);
    // El vecino con alertas en ese municipio lo ve, en la ficha de su caso; otro vecino no.
    const [alertId] = (await admin<{ id: string }[]>`SELECT id FROM alert WHERE citizen_id = ${citizens[0]} LIMIT 1`).map((r) => r.id);
    const view = await dbs.asCitizen(citizens[0], (tx) => reads.citizenView(tx, alertId));
    expect(view.tenantPrivacyEmail).toBe('privacidad@ley0.cl');
    const stranger = await dbs.asCitizen(citizens[1], (tx) => tx.execute(sql`SELECT tenant_id FROM tenant_privacy`));
    expect(stranger.length).toBe(0);
  });

  it('incidentes: Guard-IA avisa al municipio afectado y este registra su reporte a la Agencia', async () => {
    const inc = await compliance.createIncident(
      platform,
      {
        detectedAt: new Date().toISOString(),
        detectedBy: 'Equipo de prueba',
        nature: 'UNAUTHORIZED_ACCESS',
        summary: 'Acceso indebido de prueba a fichas de alertas',
        dataCategories: 'Fichas de alertas',
        sensitiveData: true,
        tenantIds: [tenants[0]],
      },
      '127.0.0.1',
    );
    incidentIds.push(inc.id);
    expect(inc.tenants.map((t) => t.tenantId)).toEqual([tenants[0]]);
    expect((await privacySvc.overview(ops[1])).incidents).toEqual([]);
    expect((await privacySvc.overview(ops[0])).incidents.map((i) => i.id)).toEqual([inc.id]);
    await expect(privacySvc.recordReport(ops[1], inc.id, { agencyRef: 'Folio 1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const reported = await privacySvc.recordReport(ops[0], inc.id, { agencyReportedAt: new Date().toISOString(), agencyRef: 'Folio 123' });
    expect(reported.incidents[0].tenant).toMatchObject({ agencyRef: 'Folio 123' });
    const kinds = await admin<{ kind: string; platform_actor_id: string | null }[]>`
      SELECT kind, platform_actor_id FROM audit_log WHERE tenant_id = ${tenants[0]} AND target_id = ${inc.id} ORDER BY created_at`;
    expect(kinds).toEqual([
      { kind: 'INCIDENT_NOTIFIED', platform_actor_id: platform.sub },
      { kind: 'INCIDENT_AGENCY_REPORTED', platform_actor_id: null },
    ]);

    await expect(compliance.updateIncident(platform, inc.id, { status: 'CLOSED' }, '127.0.0.1')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const closed = await compliance.updateIncident(platform, inc.id, { status: 'CLOSED', measures: 'Cuenta desactivada y claves rotadas' }, '127.0.0.1');
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
  });

  it('un consentimiento no se edita ni se borra, y cada vecino ve solo los suyos', async () => {
    const others = await dbs.asCitizen(citizens[1], (tx) =>
      tx.execute(sql`SELECT id FROM consent_record WHERE citizen_id = ${citizens[0]}`),
    );
    expect(others.length).toBe(0);
    await expect(
      dbs.asSystem((tx) => tx.execute(sql`UPDATE consent_record SET action = 'GRANTED' WHERE citizen_id = ${citizens[0]}`)),
    ).rejects.toThrow();
    await expect(dbs.asSystem((tx) => tx.execute(sql`DELETE FROM consent_record WHERE citizen_id = ${citizens[0]}`))).rejects.toThrow();
  });
});
