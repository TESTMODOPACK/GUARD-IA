import { Inject, Injectable, Logger } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import {
  CONSENT_VERSION,
  type AccessClaims,
  type CitizenAccount,
  type CitizenPublic,
  type Consent,
  type DeviceUpsert,
  type OperatorPublic,
  type TenantStatus,
  type TokenPair,
} from '@guardia/shared';
import { loadCitizenAccount } from '../accounts/account-read';
import { loadOperatorScope, type OperatorScope } from '../areas/area-scope';
import { AppError } from '../common/app-error';
import { ENV, type Env } from '../config/env';
import { DbService, type Tx } from '../db/db.service';
import { citizen, consentRecord, device, operator, otpCode, tenant } from '../db/schema';
import { LegalService } from '../legal/legal.service';
import { RateLimitService } from '../infra/rate-limit.service';
import { AuditService } from './audit.service';
import { SMS_PROVIDER, type SmsProvider } from './sms/sms.provider';
import { TokenService } from './token.service';

const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;

/** Hash fijo para igualar el tiempo de un login con usuario inexistente (se calcula una vez). */
const DUMMY_HASH = argonHash('guard-ia-dummy-password-' + randomInt(1e9));

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly dbs: DbService,
    private readonly tokens: TokenService,
    private readonly rate: RateLimitService,
    private readonly audit: AuditService,
    private readonly legal: LegalService,
  ) {}

  // ---------------------------------------------------------------- ciudadano

  async requestOtp(phone: string, ip: string): Promise<void> {
    // Por teléfono (sección 9) y por IP (SMS pumping: cada envío cuesta dinero).
    await this.rate.hit(`otp:ip:${ip}`, this.env.RATE_OTP_PER_IP_PER_HOUR, 3600, 'Demasiados códigos solicitados desde esta red');
    await this.rate.hit(`otp:${phone}`, this.env.RATE_OTP_PER_HOUR, 3600, 'Demasiados códigos solicitados; intenta en una hora');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await argonHash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);
    await this.dbs.asSystem((tx) =>
      tx
        .insert(otpCode)
        .values({ phone, codeHash, expiresAt, attempts: 0 })
        .onConflictDoUpdate({ target: otpCode.phone, set: { codeHash, expiresAt, attempts: 0, createdAt: new Date() } }),
    );
    if (this.env.OTP_DEBUG_ENDPOINT) devOtpCache.set(phone, code);
    await this.sms.send(phone, `Guard-IA: tu código es ${code}. Vence en 5 minutos.`);
  }

  async verifyOtp(phone: string, code: string, ip: string): Promise<TokenPair & { citizen: CitizenPublic }> {
    await this.rate.hit(`otpv:${phone}:${ip}`, this.env.RATE_OTP_VERIFY_PER_5MIN, 300, 'Demasiados intentos; pide un código nuevo');

    const row = await this.dbs.asSystem(async (tx) => {
      const [r] = await tx.select().from(otpCode).where(eq(otpCode.phone, phone)).limit(1);
      return r ?? null;
    });
    if (!row) throw new AppError('OTP_INVALID', 'Código incorrecto');
    if (row.expiresAt.getTime() < Date.now()) throw new AppError('OTP_EXPIRED', 'Código vencido');
    if (row.attempts >= OTP_MAX_ATTEMPTS) throw new AppError('OTP_INVALID', 'Demasiados intentos; pide un código nuevo');

    const ok = await argonVerify(row.codeHash, code);
    if (!ok) {
      // El contador se confirma en su propia transacción; un throw dentro lo revertiría.
      const attempts = row.attempts + 1;
      await this.dbs.asSystem((tx) =>
        attempts >= OTP_MAX_ATTEMPTS
          ? tx.delete(otpCode).where(eq(otpCode.phone, phone))
          : tx.update(otpCode).set({ attempts }).where(eq(otpCode.phone, phone)),
      );
      throw new AppError('OTP_INVALID', attempts >= OTP_MAX_ATTEMPTS ? 'Código bloqueado; pide uno nuevo' : 'Código incorrecto');
    }

    return this.dbs.asSystem(async (tx) => {
      const deleted = await tx.delete(otpCode).where(eq(otpCode.phone, phone)).returning({ phone: otpCode.phone });
      if (deleted.length === 0) throw new AppError('OTP_INVALID', 'Código ya utilizado');

      // Upsert que devuelve la fila: en conflicto toca una columna permitida consigo misma
      // (phone no es actualizable por el GRANT de columnas).
      const [c] = await tx
        .insert(citizen)
        .values({ phone })
        .onConflictDoUpdate({ target: citizen.phone, set: { name: sql`${citizen.name}` } })
        .returning();
      if (c.blockedAt) throw new AppError('FORBIDDEN', 'Cuenta bloqueada');

      const { refreshId: _id, ...pair } = await this.tokens.issuePair(tx, { kind: 'citizen', sub: c.id });
      return { ...pair, citizen: toCitizenPublic(c, await loadCitizenAccount(tx, c.id)) };
    });
  }

  /**
   * Consentimiento con prueba (0014, Ley 21.719 art. 12): solo la versión vigente y el aviso exacto que la app mostró
   * (por su hash). Queda una fila por finalidad en consent_record (solo inserción) apuntando al texto guardado;
   * citizen.consent_version es la caché que lee la app. Nunca toca el SOS: una cuenta con un consentimiento anterior
   * igual puede pedir ayuda (alerts.service exige solo consent_at) y la app le pide aceptar el nuevo.
   */
  async acceptConsent(citizenId: string, body: Consent): Promise<void> {
    if (body.version !== CONSENT_VERSION) {
      throw new AppError('CONFLICT', 'Hay una versión nueva del aviso: revísala antes de aceptar', { version: CONSENT_VERSION });
    }
    const notice = await this.legal.notice();
    if (body.noticeHash !== notice.hash) {
      throw new AppError('CONFLICT', 'El aviso cambió mientras lo leías: revísalo de nuevo', { version: CONSENT_VERSION });
    }
    const noticeId = await this.legal.persistNotice(notice);
    const meta = { noticeId, appVersion: body.appVersion ?? null, platform: body.platform ?? null };
    await this.dbs.asCitizen(citizenId, async (tx) => {
      await tx.insert(consentRecord).values({ citizenId, purpose: 'SERVICE', action: 'GRANTED', ...meta });
      // La IA externa solo se registra si hoy hay una: con la IA sin red no hay nada que aceptar.
      if (notice.externalAi) {
        await tx
          .insert(consentRecord)
          .values({ citizenId, purpose: 'EXTERNAL_AI', action: body.externalAi ? 'GRANTED' : 'REVOKED', ...meta });
      }
      await tx
        .update(citizen)
        .set({
          consentVersion: CONSENT_VERSION,
          consentAt: new Date(),
          externalAi: body.externalAi,
          ageDeclaredAt: sql`coalesce(${citizen.ageDeclaredAt}, now())`,
        })
        .where(eq(citizen.id, citizenId));
    });
  }

  /**
   * Oponerse (o volver a aceptar) el análisis con IA externa desde «Mis datos» (0014). Desde la próxima alerta el
   * worker la clasifica sin red (ai_status LOCAL); la central la atiende igual.
   */
  async setExternalAi(citizenId: string, enabled: boolean): Promise<CitizenPublic> {
    const notice = await this.legal.notice();
    const noticeId = await this.legal.persistNotice(notice);
    return this.dbs.asCitizen(citizenId, async (tx) => {
      await tx
        .insert(consentRecord)
        .values({ citizenId, noticeId, purpose: 'EXTERNAL_AI', action: enabled ? 'GRANTED' : 'REVOKED' });
      const [c] = await tx.update(citizen).set({ externalAi: enabled }).where(eq(citizen.id, citizenId)).returning();
      if (!c) throw new AppError('NOT_FOUND', 'Cuenta no encontrada');
      return toCitizenPublic(c, await loadCitizenAccount(tx, c.id));
    });
  }

  /**
   * Un token Expo pertenece a un solo dispositivo físico. Si el teléfono cambió de cuenta,
   * el token se reasigna al nuevo ciudadano (contexto system: la política citizen no vería la
   * fila del dueño anterior). La reasignación queda en el log para auditoría.
   */
  async upsertDevice(citizenId: string, d: DeviceUpsert): Promise<void> {
    await this.dbs.asSystem(async (tx) => {
      const [prev] = await tx
        .select({ citizenId: device.citizenId })
        .from(device)
        .where(eq(device.expoPushToken, d.expoPushToken))
        .limit(1);
      if (prev && prev.citizenId !== citizenId) {
        this.logger.warn(`token Expo reasignado de ${prev.citizenId} a ${citizenId}`);
      }
      await tx
        .insert(device)
        .values({
          citizenId,
          expoPushToken: d.expoPushToken,
          platform: d.platform,
          appVersion: d.appVersion ?? null,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: device.expoPushToken,
          set: { citizenId, platform: d.platform, appVersion: d.appVersion ?? null, lastSeenAt: new Date() },
        });
    });
  }

  async me(citizenId: string): Promise<CitizenPublic> {
    return this.dbs.asCitizen(citizenId, async (tx) => {
      const [c] = await tx.select().from(citizen).where(eq(citizen.id, citizenId)).limit(1);
      if (!c) throw new AppError('NOT_FOUND', 'Ciudadano no encontrado');
      return toCitizenPublic(c, await loadCitizenAccount(tx, c.id));
    });
  }

  // ----------------------------------------------------------------- operador

  async operatorLogin(email: string, password: string, ip: string): Promise<TokenPair & { operator: OperatorPublic }> {
    const normalized = email.toLowerCase();
    await this.rate.hit(`login:${ip}:${normalized}`, this.env.RATE_LOGIN_PER_MINUTE, 60, 'Demasiados intentos de inicio de sesión');
    await this.rate.hit(`login:${normalized}`, this.env.RATE_LOGIN_PER_MINUTE * 3, 60, 'Demasiados intentos de inicio de sesión');

    const op = await this.dbs.asSystem(async (tx) => {
      const [o] = await tx
        .select()
        .from(operator)
        .where(and(eq(operator.email, normalized), eq(operator.active, true)))
        .limit(1);
      return o ?? null;
    });
    // Verificación en tiempo constante aunque no exista el usuario, para no filtrar emails.
    const ok = await argonVerify(op?.passwordHash ?? (await DUMMY_HASH), password);
    if (op && !ok) {
      // El intento fallido se confirma en su propia transacción antes del throw (regla 4).
      await this.dbs.asSystem((tx) =>
        this.audit.record(tx, { tenantId: op.tenantId, actorId: null, kind: 'LOGIN_FAILED', targetId: op.id, payload: { ip, email: op.email } }),
      );
    }
    if (!op || !ok) throw new AppError('UNAUTHORIZED', 'Credenciales inválidas');

    return this.dbs.asSystem(async (tx) => {
      const [t] = await tx.select({ name: tenant.name, status: tenant.status }).from(tenant).where(eq(tenant.id, op.tenantId)).limit(1);
      // Municipio dado de baja (0010): sus cuentas ya no entran.
      if (!t || t.status === 'TERMINATED') throw new AppError('UNAUTHORIZED', 'El municipio ya no usa Guard-IA');
      await tx.update(operator).set({ lastLoginAt: new Date() }).where(eq(operator.id, op.id));
      await this.audit.record(tx, { tenantId: op.tenantId, actorId: op.id, kind: 'LOGIN', targetId: op.id, payload: { ip } });
      const claims: AccessClaims = { kind: 'operator', sub: op.id, tenantId: op.tenantId, role: op.role };
      const { refreshId: _id, ...pair } = await this.tokens.issuePair(tx, claims);
      const scope = await loadOperatorScope(tx, { id: op.id, tenantId: op.tenantId, role: op.role });
      return { ...pair, operator: toOperatorPublic(op, t.name, t.status, scope) };
    });
  }

  // ------------------------------------------------------------------ refresh

  async refresh(raw: string): Promise<TokenPair> {
    return this.tokens.rotate(raw, (tx, kind, subjectId) => this.claimsFor(tx, kind, subjectId));
  }

  /** Cierre de sesión (vecino u operador): el refresh deja de servir. El access vence solo. */
  async logout(raw: string): Promise<void> {
    const subject = await this.tokens.revoke(raw);
    if (subject?.kind !== 'OPERATOR') return;
    await this.dbs.asSystem(async (tx) => {
      const [op] = await tx.select({ tenantId: operator.tenantId }).from(operator).where(eq(operator.id, subject.subjectId)).limit(1);
      if (op) await this.audit.record(tx, { tenantId: op.tenantId, actorId: subject.subjectId, kind: 'LOGOUT', targetId: subject.subjectId });
    });
  }

  private async claimsFor(tx: Tx, kind: 'CITIZEN' | 'OPERATOR', subjectId: string): Promise<AccessClaims> {
    if (kind === 'CITIZEN') {
      const [c] = await tx.select().from(citizen).where(eq(citizen.id, subjectId)).limit(1);
      if (!c || c.blockedAt) throw new AppError('UNAUTHORIZED', 'Cuenta no disponible');
      return { kind: 'citizen', sub: c.id };
    }
    const [op] = await tx
      .select()
      .from(operator)
      .where(and(eq(operator.id, subjectId), eq(operator.active, true)))
      .limit(1);
    if (!op) throw new AppError('UNAUTHORIZED', 'Operador no disponible');
    const [t] = await tx.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, op.tenantId)).limit(1);
    if (!t || t.status === 'TERMINATED') throw new AppError('UNAUTHORIZED', 'El municipio ya no usa Guard-IA');
    return { kind: 'operator', sub: op.id, tenantId: op.tenantId, role: op.role };
  }

  /** Solo desarrollo: el simulador necesita leer el último OTP (el hash no es reversible). */
  async devPeekOtp(phone: string): Promise<{ hint: string }> {
    if (!this.env.OTP_DEBUG_ENDPOINT) throw new AppError('NOT_FOUND', 'No disponible');
    const code = devOtpCache.get(phone);
    if (!code) throw new AppError('NOT_FOUND', 'Sin OTP vigente para ese teléfono');
    return { hint: code };
  }

  static readonly hashPassword = (plain: string) => argonHash(plain);
}

/** Caché de códigos OTP solo cuando OTP_DEBUG_ENDPOINT=true (ver ConsoleSmsProvider). */
export const devOtpCache = new Map<string, string>();

function toCitizenPublic(c: typeof citizen.$inferSelect, account: CitizenAccount): CitizenPublic {
  return {
    id: c.id,
    phone: c.phone,
    name: c.name,
    trustScore: c.trustScore,
    consentVersion: c.consentVersion,
    consentAt: c.consentAt ? c.consentAt.toISOString() : null,
    externalAi: c.externalAi,
    account,
  };
}

function toOperatorPublic(
  o: typeof operator.$inferSelect,
  tenantName: string,
  tenantStatus: TenantStatus,
  scope: OperatorScope,
): OperatorPublic {
  return {
    id: o.id,
    tenantId: o.tenantId,
    tenantName,
    email: o.email,
    name: o.name,
    role: o.role,
    mustChangePassword: o.mustChangePassword,
    tenantStatus,
    areas: scope.areas,
    seesAll: scope.seesAll,
  };
}
