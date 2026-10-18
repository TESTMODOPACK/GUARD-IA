/**
 * Consola de plataforma contra base real (pnpm test:db, migración 0010): segundo factor, sesiones, contexto
 * RLS `platform`, ruteo en modo prueba, puesta en marcha validada en la base, activación, suspensión y baja.
 */
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import { CreateTenantSchema, UpdateTenantSchema } from '@guardia/shared';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperatorStatusService } from '../src/auth/operator-status.service';
import { TokenService } from '../src/auth/token.service';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import type { RateLimitService } from '../src/infra/rate-limit.service';
import { PlatformAuditService } from '../src/platform/platform-audit.service';
import { PlatformAuthService } from '../src/platform/platform-auth.service';
import { PlatformTokensService, type PlatformClaims } from '../src/platform/platform-tokens.service';
import { PlatformUsersService } from '../src/platform/platform-users.service';
import { PlatformUserStatusService } from '../src/platform/platform.guard';
import { PlatformTenantsService } from '../src/platform/tenants.service';
import { base32Encode, currentStep, SecretBox, totpAt, verifyTotp } from '../src/platform/totp';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const TEST_TENANT = 'Municipio de prueba plataforma';
const PASSWORD = 'clave-de-prueba-plataforma';
const IP = '127.0.0.1';

d('consola de plataforma', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let tokens: PlatformTokensService;
  let auth: PlatformAuthService;
  let devAuth: PlatformAuthService;
  let tenants: PlatformTenantsService;
  let users: PlatformUsersService;
  let opStatus: OperatorStatusService;
  let opTokens: TokenService;
  const suffix = Date.now().toString(36);
  const digits = String(Date.now()).slice(-6);
  const email = (k: string) => `plat-test-${k}-${suffix}@guardia.test`;
  let superClaims: PlatformClaims;
  let implClaims: PlatformClaims;
  let comuna: { cut: number; name: string; lat: number; lng: number };
  let tenantId: string;
  let testCitizen: string;
  let otherCitizen: string;
  const testPhone = `+569777${digits}`;

  async function wipe() {
    const ts = (await admin<{ id: string }[]>`SELECT id FROM tenant WHERE name LIKE ${TEST_TENANT + '%'}`).map((r) => r.id);
    if (ts.length) {
      await admin`DELETE FROM alert_event WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM dispatch WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM alert WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM shift WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM contact WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM unit WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM audit_log WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM refresh_token WHERE operator_id IN (SELECT id FROM operator WHERE tenant_id IN ${admin(ts)})`;
      await admin`DELETE FROM operator WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM tenant_test_phone WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM tenant_privacy WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM tenant_subprocessor WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM platform_audit_log WHERE tenant_id IN ${admin(ts)}`;
      await admin`DELETE FROM tenant WHERE id IN ${admin(ts)}`;
    }
    await admin`DELETE FROM alert WHERE citizen_id IN (SELECT id FROM citizen WHERE phone LIKE '+569777%' OR phone LIKE '+569778%')`;
    await admin`DELETE FROM citizen WHERE phone LIKE '+569777%' OR phone LIKE '+569778%'`;
    const us = (await admin<{ id: string }[]>`SELECT id FROM platform_user WHERE email LIKE 'plat-test-%@guardia.test'`).map((r) => r.id);
    if (us.length) {
      await admin`DELETE FROM platform_audit_log WHERE actor_id IN ${admin(us)} OR target_id IN ${admin(us)}`;
      await admin`DELETE FROM platform_session WHERE user_id IN ${admin(us)}`;
      await admin`UPDATE platform_user SET created_by = NULL WHERE id IN ${admin(us)}`;
      await admin`DELETE FROM platform_user WHERE id IN ${admin(us)}`;
    }
  }

  async function platformUser(k: string, role: string): Promise<string> {
    const [u] = await admin<{ id: string }[]>`
      INSERT INTO platform_user (email, name, role, password_hash, must_change_password)
      VALUES (${email(k)}, ${'Prueba ' + k}, ${role}::platform_role, ${await argonHash(PASSWORD)}, true) RETURNING id`;
    return u.id;
  }

  async function sos(citizenId: string): Promise<{ id: string; tenant_id: string | null; status: string; comuna_cut: number | null }> {
    const [a] = await admin<{ id: string; tenant_id: string | null; status: string; comuna_cut: number | null }[]>`
      INSERT INTO alert (citizen_id, type, source, lat, lng)
      VALUES (${citizenId}, 'EMERGENCY_SOS', 'BUTTON', ${comuna.lat}, ${comuna.lng})
      RETURNING id, tenant_id, status, comuna_cut`;
    return a;
  }

  beforeAll(async () => {
    // El segundo factor se prueba siempre, aunque el .env local lo tenga apagado (PLATFORM_TOTP_REQUIRED=false).
    const env = { ...validateEnv(process.env), PLATFORM_TOTP_REQUIRED: true };
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    if (!env.PLATFORM_JWT_SECRET || !env.PLATFORM_ENCRYPTION_KEY) throw new Error('PLATFORM_JWT_SECRET y PLATFORM_ENCRYPTION_KEY requeridos');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    await wipe();

    const jwt = new JwtService();
    const rate = { hit: async () => undefined } as unknown as RateLimitService;
    tokens = new PlatformTokensService(env, jwt, dbs);
    const status = new PlatformUserStatusService(dbs);
    const audit = new PlatformAuditService(dbs);
    auth = new PlatformAuthService(env, dbs, tokens, audit, status, rate);
    devAuth = new PlatformAuthService({ ...env, PLATFORM_TOTP_REQUIRED: false }, dbs, tokens, audit, status, rate);
    opStatus = new OperatorStatusService(dbs);
    opTokens = new TokenService(env, jwt, dbs);
    tenants = new PlatformTenantsService(dbs, audit, opStatus, opTokens);
    users = new PlatformUsersService(dbs, audit, status, tokens);

    superClaims = { kind: 'platform', sub: await platformUser('super', 'SUPERADMIN'), role: 'SUPERADMIN' };
    implClaims = { kind: 'platform', sub: await platformUser('impl', 'IMPLEMENTATION'), role: 'IMPLEMENTATION' };

    // Una comuna de Aysén sin municipio: lejos del polígono del municipio demo (Gran Santiago).
    const [c] = await admin<{ cut: number; name: string; lat: number; lng: number }[]>`
      SELECT c.cut, c.name, ST_Y(ST_PointOnSurface(c.boundary::geometry)) AS lat, ST_X(ST_PointOnSurface(c.boundary::geometry)) AS lng
        FROM comuna c
       WHERE c.region_cut = 11 AND NOT EXISTS (SELECT 1 FROM tenant t WHERE t.comuna_cut = c.cut)
       ORDER BY c.cut LIMIT 1`;
    comuna = c;
    const [tc] = await admin<{ id: string }[]>`INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${testPhone}, 'v1', now()) RETURNING id`;
    const [oc] = await admin<{ id: string }[]>`INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+569778${digits}`}, 'v1', now()) RETURNING id`;
    testCitizen = tc.id;
    otherCitizen = oc.id;
  });

  afterAll(async () => {
    if (admin) {
      await wipe();
      await admin.end({ timeout: 5 });
    }
    if (dbs) await dbs.onModuleDestroy();
  });

  it('TOTP: vectores de la RFC 6238, base32 y un código no sirve dos veces', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(verifyTotp(secret, '287082', null, 59_000)).toBe(1);
    expect(verifyTotp(secret, '287082', 1, 59_000)).toBeNull();
    expect(verifyTotp(secret, '000000', null, 59_000)).toBeNull();

    const box = new SecretBox('una-llave-de-prueba-de-al-menos-32-caracteres');
    const sealed = box.seal(secret);
    expect(sealed).not.toContain(secret);
    expect(box.open(sealed)).toBe(secret);
    expect(() => new SecretBox('otra-llave-de-prueba-de-al-menos-32-caracteres').open(sealed)).toThrow();
  });

  it('primer ingreso: enrola el segundo factor, abre sesión, rota el refresh y detecta reutilización', async () => {
    const step = await auth.login(email('super'), PASSWORD, IP);
    expect(step.step).toBe('enroll');
    if (step.step !== 'enroll') return;
    const [row] = await admin<{ totp_pending_enc: string }[]>`SELECT totp_pending_enc FROM platform_user WHERE id = ${superClaims.sub}`;
    expect(row.totp_pending_enc).not.toContain(step.secret);

    const code = totpAt(step.secret, currentStep());
    const s = await auth.verifyCode(step.challengeToken, code, IP);
    expect(s.user).toMatchObject({ id: superClaims.sub, role: 'SUPERADMIN', mustChangePassword: true });
    expect(tokens.verifyAccess(s.accessToken)).toMatchObject({ kind: 'platform', sub: superClaims.sub });

    // Segundo ingreso: ya no enrola, y el mismo código no se acepta otra vez.
    const again = await auth.login(email('super'), PASSWORD, IP);
    expect(again.step).toBe('totp');
    if (again.step !== 'totp') return;
    await expect(auth.verifyCode(again.challengeToken, code, IP)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const r = await auth.refresh(s.refreshToken, IP);
    expect(r.refreshToken).not.toBe(s.refreshToken);
    await expect(auth.refresh(s.refreshToken, IP)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // Reutilizar el viejo cerró toda la familia: el nuevo tampoco sirve.
    await expect(auth.refresh(r.refreshToken, IP)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const actions = (await admin<{ action: string }[]>`
      SELECT action FROM platform_audit_log WHERE target_id = ${superClaims.sub} ORDER BY created_at`).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['TOTP_ENROLLED', 'LOGIN', 'LOGIN_FAILED']));
  });

  it('cinco fallos seguidos bloquean la cuenta 15 minutos', async () => {
    const id = await platformUser('lock', 'SUPPORT');
    for (let i = 0; i < 5; i++) {
      await expect(auth.login(email('lock'), 'incorrecta-123', IP)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(auth.login(email('lock'), PASSWORD, IP)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const [u] = await admin<{ locked: boolean }[]>`SELECT locked_until > now() + interval '14 minutes' AS locked FROM platform_user WHERE id = ${id}`;
    expect(u.locked).toBe(true);
    const [l] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM platform_audit_log WHERE target_id = ${id} AND action = 'LOCKED'`;
    expect(l.n).toBe(1);
  });

  it('en desarrollo, con el segundo factor apagado, la contraseña basta y la bitácora lo anota', async () => {
    const id = await platformUser('nototp', 'SUPPORT');
    await expect(devAuth.login(email('nototp'), 'incorrecta-123', IP)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const r = await devAuth.login(email('nototp'), PASSWORD, IP);
    expect(r.step).toBe('done');
    if (r.step !== 'done') return;
    expect(r.session.user).toMatchObject({ id, mustChangePassword: true });
    expect(tokens.verifyAccess(r.session.accessToken).sub).toBe(id);
    const [l] = await admin<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM platform_audit_log WHERE target_id = ${id} AND action = 'LOGIN'`;
    expect(l.payload).toEqual({ secondFactor: false });
  });

  it('un token de operador no abre la consola', () => {
    const { token } = opTokens.signAccess({ kind: 'operator', sub: superClaims.sub, tenantId: superClaims.sub, role: 'ADMIN' });
    expect(() => tokens.verifyAccess(token)).toThrow();
  });

  it('el contexto platform ve municipios y comunas, pero no alertas ni vecinos', async () => {
    const r = await dbs.asPlatform(superClaims.sub, async (tx) => {
      const n = async (q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as { n: number }[])[0].n;
      return {
        alerts: await n(sql`SELECT count(*)::int AS n FROM alert`),
        citizens: await n(sql`SELECT count(*)::int AS n FROM citizen`),
        events: await n(sql`SELECT count(*)::int AS n FROM alert_event`),
        tenants: await n(sql`SELECT count(*)::int AS n FROM tenant`),
        comunas: await n(sql`SELECT count(*)::int AS n FROM comuna`),
        regions: await n(sql`SELECT count(*)::int AS n FROM region`),
        operators: await n(sql`SELECT count(*)::int AS n FROM operator WHERE role <> 'ADMIN'`),
      };
    });
    expect(r).toMatchObject({ alerts: 0, citizens: 0, events: 0, operators: 0, regions: 16 });
    expect(r.tenants).toBeGreaterThan(0);
    expect(r.comunas).toBeGreaterThan(300);
  });

  it('alta en implementación: solo el teléfono de prueba llega a la central', async () => {
    // Como el controlador: el pipe de zod normaliza el RUT y valida el dígito verificador.
    const t = await tenants.create(implClaims, CreateTenantSchema.parse({ comunaCut: comuna.cut, name: `${TEST_TENANT} ${suffix}`, rut: '11.111.111-1' }), IP);
    tenantId = t.id;
    expect(t).toMatchObject({ status: 'ONBOARDING', comunaCut: comuna.cut, rut: '11111111-1', regionCut: 11 });
    expect(t.readiness.ready).toBe(false);
    expect(t.transitions).toEqual(['ACTIVE']); // implementación no da de baja
    await expect(tenants.create(implClaims, { comunaCut: comuna.cut }, IP)).rejects.toMatchObject({ code: 'CONFLICT' });

    await tenants.addTestPhone(implClaims, tenantId, { phone: testPhone, label: 'Teléfono QA' }, IP);
    const fromTest = await sos(testCitizen);
    expect(fromTest).toMatchObject({ tenant_id: tenantId, status: 'PENDING', comuna_cut: comuna.cut });
    const fromNeighbor = await sos(otherCitizen);
    expect(fromNeighbor).toMatchObject({ tenant_id: null, status: 'UNROUTED', comuna_cut: comuna.cut });

    // La plataforma ve la demanda no atendida de la comuna, solo como cifra.
    const [u] = (await dbs.asPlatform(superClaims.sub, (tx) =>
      tx.execute(sql`SELECT sos::int AS sos FROM platform_unserved(now() - interval '1 hour') WHERE comuna_cut = ${comuna.cut}`),
    )) as unknown as { sos: number }[];
    expect(u.sos).toBeGreaterThanOrEqual(1);
  });

  it('no se activa con la lista incompleta ni con otro nombre; la baja pide superadministrador y sin alertas abiertas', async () => {
    const body = { reason: 'Prueba automática', confirmName: comuna.name };
    await expect(tenants.changeStatus(superClaims, tenantId, { ...body, status: 'ACTIVE' }, IP)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(tenants.changeStatus(superClaims, tenantId, { ...body, status: 'ACTIVE', confirmName: 'Otra comuna' }, IP)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(tenants.changeStatus(superClaims, tenantId, { ...body, status: 'SUSPENDED' }, IP)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(tenants.changeStatus(implClaims, tenantId, { ...body, status: 'TERMINATED' }, IP)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Hay un SOS abierto del teléfono de prueba.
    await expect(tenants.changeStatus(superClaims, tenantId, { ...body, status: 'TERMINATED' }, IP)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('con la lista completa se activa y desde ahí llegan todos los vecinos; queda en ambas bitácoras', async () => {
    const created = await tenants.createAdmin(implClaims, tenantId, { email: email('admin'), name: 'Admin Prueba' }, IP);
    expect(created.temporaryPassword).toMatch(/^[A-Za-z2-9]{14}$/);
    const adminId = created.admin.id;
    await admin`UPDATE operator SET must_change_password = false WHERE id = ${adminId}`;
    const ops = await admin<{ id: string }[]>`
      INSERT INTO operator (tenant_id, email, password_hash, name, role) VALUES
        (${tenantId}, ${email('op1')}, 'x', 'Operadora Uno', 'OPERATOR'),
        (${tenantId}, ${email('op2')}, 'x', 'Supervisor Dos', 'SUPERVISOR') RETURNING id`;
    for (const cat of ['CARABINEROS', 'SAMU', 'BOMBEROS', 'EMERGENCIA_MUNICIPAL']) {
      await admin`INSERT INTO contact (tenant_id, category, name, phone) VALUES (${tenantId}, ${cat}::contact_category, ${'Contacto ' + cat}, '133')`;
    }
    const [unit] = await admin<{ id: string }[]>`INSERT INTO unit (tenant_id, code, kind) VALUES (${tenantId}, ${'PT-' + suffix}, 'PATRULLA') RETURNING id`;
    await admin`
      INSERT INTO shift (tenant_id, operator_id, planned_start, planned_end)
      VALUES (${tenantId}, ${ops[0].id}, date_trunc('day', now()) + interval '1 day 8 hours', date_trunc('day', now()) + interval '1 day 16 hours')`;
    // Solo con fechas no basta (0014): cada documento con su referencia, la evaluación de impacto aprobada, el contacto
    // de privacidad que fija el municipio y la autorización escrita de los subencargados en uso.
    await tenants.update(implClaims, tenantId, UpdateTenantSchema.parse({ contractSignedAt: '2026-10-01', dpaSignedAt: '2026-10-01' }), IP);
    const partial = await tenants.detail(implClaims, tenantId);
    expect(partial.readiness.items.filter((i) => !i.ok).map((i) => i.key)).toEqual(
      expect.arrayContaining(['CONTRACT_SIGNED', 'DPA_SIGNED', 'DPIA_APPROVED', 'PRIVACY_CONTACT']),
    );
    await tenants.update(
      implClaims,
      tenantId,
      UpdateTenantSchema.parse({
        contractRef: 'Contrato N° 1, v1',
        dpaRef: 'Contrato de encargo v1',
        dpiaApprovedAt: '2026-10-02',
        dpiaRef: 'Evaluación de impacto v1, decreto 10',
      }),
      IP,
    );
    await admin`INSERT INTO tenant_privacy (tenant_id, contact_email) VALUES (${tenantId}, 'privacidad@prueba.cl')`;
    await admin`
      INSERT INTO tenant_subprocessor (tenant_id, subprocessor_id, authorized_at, authorized_by, document_ref)
      SELECT ${tenantId}, s.id, current_date, 'Alcalde de prueba', 'Anexo 2' FROM subprocessor s WHERE s.in_use`;
    // Prueba de extremo a extremo: el SOS del teléfono de prueba, despachado y resuelto.
    const [open] = await admin<{ id: string }[]>`SELECT id FROM alert WHERE tenant_id = ${tenantId} AND citizen_id = ${testCitizen} LIMIT 1`;
    await admin`INSERT INTO dispatch (alert_id, tenant_id, unit_id, operator_id, status, closed_at) VALUES (${open.id}, ${tenantId}, ${unit.id}, ${ops[0].id}, 'CLOSED', now())`;
    await admin`UPDATE alert SET status = 'RESOLVED', resolved_at = now() WHERE id = ${open.id}`;

    const ready = await tenants.detail(implClaims, tenantId);
    expect(ready.readiness.items.filter((i) => !i.ok).map((i) => i.key)).toEqual([]);
    expect(ready.readiness.ready).toBe(true);

    // El nombre de confirmación no distingue mayúsculas ni tildes.
    const active = await tenants.changeStatus(implClaims, tenantId, {
      status: 'ACTIVE',
      reason: 'Puesta en marcha completa',
      confirmName: comuna.name.toUpperCase(),
    }, IP);
    expect(active.status).toBe('ACTIVE');
    expect(active.goLiveAt).not.toBeNull();
    expect(await sos(otherCitizen)).toMatchObject({ tenant_id: tenantId, status: 'PENDING' });

    const [p] = await admin<{ payload: { from: string; to: string }; reason: string }[]>`
      SELECT payload, reason FROM platform_audit_log WHERE tenant_id = ${tenantId} AND action = 'TENANT_STATUS_CHANGED'`;
    expect(p).toMatchObject({ payload: { from: 'ONBOARDING', to: 'ACTIVE' }, reason: 'Puesta en marcha completa' });
    const [m] = await admin<{ actor_id: string | null; platform_actor_id: string }[]>`
      SELECT actor_id, platform_actor_id FROM audit_log WHERE tenant_id = ${tenantId} AND kind = 'TENANT_STATUS_CHANGED'`;
    expect(m).toEqual({ actor_id: null, platform_actor_id: implClaims.sub });

    // Restablecer el acceso del administrador: temporal nueva, en ambas bitácoras.
    const reset = await tenants.resetAdmin(implClaims, tenantId, adminId, IP);
    expect(reset.admin.mustChangePassword).toBe(true);
    const [k] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenantId} AND kind = 'PASSWORD_RESET' AND platform_actor_id IS NOT NULL`;
    expect(k.n).toBe(1);
  });

  it('suspender no corta el SOS; dar de baja deja las alertas nuevas fuera de cobertura y cierra las cuentas', async () => {
    const body = { reason: 'Prueba automática', confirmName: comuna.name };
    expect((await tenants.changeStatus(implClaims, tenantId, { ...body, status: 'SUSPENDED' }, IP)).status).toBe('SUSPENDED');
    expect(await sos(otherCitizen)).toMatchObject({ tenant_id: tenantId, status: 'PENDING' });

    await admin`UPDATE alert SET status = 'RESOLVED', resolved_at = now() WHERE tenant_id = ${tenantId} AND status = 'PENDING'`;
    const [adm] = await admin<{ id: string }[]>`SELECT id FROM operator WHERE tenant_id = ${tenantId} AND role = 'ADMIN'`;
    expect((await opStatus.get(adm.id))?.active).toBe(true);

    const gone = await tenants.changeStatus(superClaims, tenantId, { ...body, status: 'TERMINATED' }, IP);
    expect(gone).toMatchObject({ status: 'TERMINATED', transitions: [] });
    expect(await sos(otherCitizen)).toMatchObject({ tenant_id: null, status: 'UNROUTED' });
    expect((await opStatus.get(adm.id))?.active).toBe(false);
    // De baja, la comuna puede volver a contratar con un alta nueva.
    const [free] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant WHERE comuna_cut = ${comuna.cut} AND status <> 'TERMINATED'`;
    expect(free.n).toBe(0);
  });

  it('equipo: no cambia su propio rol y restablecer obliga a enrolar de nuevo', async () => {
    const other = await users.create(superClaims, { email: email('support'), name: 'Soporte Prueba', role: 'SUPPORT' }, IP);
    expect(other.user).toMatchObject({ role: 'SUPPORT', mustChangePassword: true, totpEnabled: false });
    await expect(users.update(superClaims, superClaims.sub, { role: 'SUPPORT' }, IP)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin`UPDATE platform_user SET totp_secret_enc = 'v1.a.b.c', totp_enabled_at = now(), must_change_password = false WHERE id = ${other.user.id}`;
    const reset = await users.reset(superClaims, other.user.id, IP);
    expect(reset.user).toMatchObject({ totpEnabled: false, mustChangePassword: true });
  });
});
