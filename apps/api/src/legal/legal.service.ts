import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  CONSENT_VERSION,
  buildLegalNotice,
  type LegalNotice,
  type NoticeProcessor,
  type SubprocessorService,
} from '@guardia/shared';
import { ENV, type Env } from '../config/env';
import { DbService } from '../db/db.service';
import { consentNotice, subprocessor, tenantSubprocessor } from '../db/schema';

const CACHE_MS = 60_000;

/**
 * Clave del proveedor de IA externo en uso (subprocessor.key), o null si las alertas no salen del servidor (mock).
 * Un servicio que no está en el catálogo queda con una clave propia: sin ficha ni autorización, el worker no le
 * envía nada.
 */
export function activeAiKey(env: Env): string | null {
  if (env.AI_PROVIDER !== 'openai') return null;
  if (env.AI_PROCESSOR_KEY) return env.AI_PROCESSOR_KEY;
  if (!env.OPENAI_BASE_URL) return 'openai';
  const host = new URL(env.OPENAI_BASE_URL).hostname.toLowerCase();
  if (host === 'api.openai.com') return 'openai';
  if (host === 'groq.com' || host.endsWith('.groq.com')) return 'groq';
  return host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'desconocido';
}

export function noticeHash(body: Omit<LegalNotice, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** Por qué una alerta se clasifica sin IA externa (ai_status = 'LOCAL'). */
export type LocalReason = 'CITIZEN' | 'TENANT';

/**
 * Ley 21.719, etapa 1: el aviso al vecino con la configuración vigente (nunca un proveedor escrito a mano), la prueba
 * de qué aceptó (consent_notice) y la regla de subencargados: el contenido de una alerta solo va al proveedor de IA si
 * el municipio de esa alerta lo autorizó por escrito (art. 15 bis).
 */
@Injectable()
export class LegalService {
  private readonly logger = new Logger(LegalService.name);
  readonly aiKey: string | null;
  private noticeCache: { at: number; value: LegalNotice } | null = null;
  private readonly authorizedCache = new Map<string, { at: number; ok: boolean }>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly dbs: DbService,
  ) {
    this.aiKey = activeAiKey(env);
  }

  /** Primera capa del aviso (caché de 1 minuto: el catálogo cambia poco y la consola la invalida). */
  async notice(): Promise<LegalNotice> {
    if (this.noticeCache && Date.now() - this.noticeCache.at < CACHE_MS) return this.noticeCache.value;
    const sms = this.env.SMS_PROVIDER === 'twilio' ? 'twilio' : null;
    const keys = [this.aiKey, sms, 'expo'].filter((k): k is string => !!k);
    const rows = await this.dbs.asSystem((tx) => tx.select().from(subprocessor).where(inArray(subprocessor.key, keys)));
    const describe = (key: string, service: SubprocessorService): NoticeProcessor => {
      const r = rows.find((x) => x.key === key);
      if (r) return { service: r.service, name: r.name, country: r.country, data: r.dataCategories };
      this.logger.warn(`el subencargado "${key}" no tiene ficha en el catálogo; el aviso lo nombra sin país`);
      return { service, name: key, country: 'país no informado', data: 'Datos necesarios para el servicio' };
    };
    const body = buildLegalNotice({
      version: CONSENT_VERSION,
      externalAi: this.aiKey ? describe(this.aiKey, 'AI') : null,
      processors: [...(sms ? [describe(sms, 'SMS')] : []), describe('expo', 'PUSH')],
      contactEmail: this.env.PRIVACY_CONTACT_EMAIL ?? null,
      policyUrl: this.env.PRIVACY_POLICY_URL ?? null,
    });
    const value: LegalNotice = { ...body, hash: noticeHash(body) };
    this.noticeCache = { at: Date.now(), value };
    return value;
  }

  /** Guarda una vez el texto exacto del aviso y devuelve su id: la prueba de qué aceptó el vecino (art. 12). */
  async persistNotice(notice: LegalNotice): Promise<string> {
    const { hash, ...body } = notice;
    return this.dbs.asSystem(async (tx) => {
      await tx
        .insert(consentNotice)
        .values({ version: notice.version, textHash: hash, body })
        .onConflictDoNothing({ target: consentNotice.textHash });
      const [row] = await tx
        .select({ id: consentNotice.id })
        .from(consentNotice)
        .where(eq(consentNotice.textHash, hash))
        .limit(1);
      return row.id;
    });
  }

  /**
   * ¿Se puede enviar a la IA externa esta alerta? null = sí. Con la IA sin red (mock) no aplica: nada sale del
   * servidor. Se llama fuera de toda transacción (regla 2).
   */
  async localReason(tenantId: string | null, citizenAcceptsExternalAi: boolean): Promise<LocalReason | null> {
    if (!this.aiKey) return null;
    if (!citizenAcceptsExternalAi) return 'CITIZEN';
    if (!tenantId || !(await this.aiAuthorized(tenantId))) return 'TENANT';
    return null;
  }

  private async aiAuthorized(tenantId: string): Promise<boolean> {
    const hit = this.authorizedCache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
    const key = this.aiKey!;
    const ok = await this.dbs.asSystem(async (tx) => {
      const [r] = await tx
        .select({ id: tenantSubprocessor.id })
        .from(tenantSubprocessor)
        .innerJoin(subprocessor, eq(subprocessor.id, tenantSubprocessor.subprocessorId))
        .where(
          and(eq(tenantSubprocessor.tenantId, tenantId), eq(subprocessor.key, key), isNull(tenantSubprocessor.revokedAt)),
        )
        .limit(1);
      return !!r;
    });
    this.authorizedCache.set(tenantId, { at: Date.now(), ok });
    return ok;
  }

  /** Tras cambiar el catálogo o una autorización: el aviso y el worker ven el cambio de inmediato. */
  invalidate(): void {
    this.noticeCache = null;
    this.authorizedCache.clear();
  }
}
