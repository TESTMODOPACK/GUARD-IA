import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { buildTriage, hasCriticalPhrase, type AlertType, type Priority } from '@guardia/shared';
import { AlertReadService } from '../alerts/alert-read.service';
import { refreshAlertArea, type AreaBefore } from '../areas/area-scope';
import { ENV, type Env } from '../config/env';
import { DbService } from '../db/db.service';
import { alert, citizen, media, tenant, triageLabel } from '../db/schema';
import { EventsService } from '../events/events.service';
import { TransferService } from '../geo/transfer.service';
import { IncidentsService } from '../incidents/incidents.service';
import { MediaService } from '../media/media.service';
import { MetricsService } from '../infra/metrics.service';
import { LegalService, type LocalReason } from '../legal/legal.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AI_PROVIDER, type AiProvider } from './ai.provider';
import { ALERTS_QUEUE, type ProcessAlertJob } from './ai.queue';
import { MockAiProvider } from './mock.provider';

/**
 * Sección 9 y migración 0011: con confianza bajo 25 o con la cuenta restringida (2 avisos falsos en 90 días), la
 * IA no deja un SOS en HIGH por sí sola: entra en MEDIUM. Excepción: una frase de riesgo vital de las reglas fijas
 * (alguien herido, un arma, no respira): una emergencia real nunca queda atrás por el historial de la cuenta.
 */
export function capPriority(
  priority: Priority,
  o: { type: AlertType; text: string; trustScore: number; restricted: boolean },
): Priority {
  if (priority !== 'HIGH' || (o.trustScore >= 25 && !o.restricted)) return priority;
  return hasCriticalPhrase(o.type, o.text) ? priority : 'MEDIUM';
}

/** Clasificador sin red para cuando la IA no responde (más las reglas fijas de shared). */
const FALLBACK = new MockAiProvider();

/** Lo que ve la central cuando una alerta se clasificó sin IA externa (0014; no es una falla). */
const LOCAL_REASON_TEXT: Record<LocalReason, string> = {
  CITIZEN: 'Sin IA externa: el vecino se opuso al análisis; se clasificó con las reglas fijas',
  TENANT: 'Sin IA externa: el municipio aún no autoriza al proveedor de IA; se clasificó con las reglas fijas',
};

/**
 * Worker del pipeline IA (sección 8). Corre en el mismo proceso que la API en el MVP;
 * separar a otro contenedor es cambiar el módulo raíz, no el código.
 */
@Processor(ALERTS_QUEUE, { concurrency: 4 })
export class AiProcessor extends WorkerHost {
  private readonly logger = new Logger(AiProcessor.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly dbs: DbService,
    private readonly mediaSvc: MediaService,
    private readonly events: EventsService,
    private readonly reads: AlertReadService,
    private readonly realtime: RealtimeService,
    private readonly metrics: MetricsService,
    private readonly incidents: IncidentsService,
    private readonly transfers: TransferService,
    private readonly legal: LegalService,
  ) {
    super();
  }

  override async process(job: Job<ProcessAlertJob>): Promise<void> {
    const { alertId } = job.data;
    const started = Date.now();

    const ctx = await this.dbs.asSystem(async (tx) => {
      const [row] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
      if (!row) return null;
      if (!['QUEUED', 'PROCESSING', 'FAILED'].includes(row.aiStatus)) return null;
      if (['CANCELLED', 'REJECTED', 'UNROUTED'].includes(row.status)) return null;
      await tx.update(alert).set({ aiStatus: 'PROCESSING', aiError: null }).where(eq(alert.id, alertId));
      const [audio] = await tx
        .select()
        .from(media)
        .where(and(eq(media.alertId, alertId), eq(media.kind, 'AUDIO'), isNull(media.deletedAt)))
        .limit(1);
      const [t] = row.tenantId
        ? await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, row.tenantId)).limit(1)
        : [];
      const [c] = await tx
        .select({ trust: citizen.trustScore, externalAi: citizen.externalAi })
        .from(citizen)
        .where(eq(citizen.id, row.citizenId))
        .limit(1);
      return {
        row,
        audio: audio ?? null,
        timezone: t?.timezone ?? 'America/Santiago',
        trustScore: c?.trust ?? 100,
        externalAi: c?.externalAi ?? true,
      };
    });
    if (!ctx) {
      this.logger.debug(`job ${job.id}: alerta ${alertId} no requiere IA`);
      return;
    }
    const { row, audio, timezone, trustScore, externalAi } = ctx;
    // Ley 21.719 (0014): el audio y el texto solo salen a la IA externa si el vecino no se opuso y el municipio de la
    // alerta autorizó al proveedor por escrito (art. 15 bis). Si no, todo se hace sin red y queda LOCAL.
    const local = this.ai.name === 'mock' ? null : await this.legal.localReason(row.tenantId, externalAi);
    const provider: AiProvider = local ? FALLBACK : this.ai;

    // Sin nada que analizar: reporte urbano con categoría elegida → SKIPPED.
    if (!audio && !row.userText?.trim()) {
      const before = await this.dbs.asSystem(async (tx) => {
        await tx
          .update(alert)
          .set({
            aiStatus: 'SKIPPED',
            priority: row.priority ?? (row.type === 'EMERGENCY_SOS' ? 'HIGH' : 'LOW'),
            category: row.category ?? (row.type === 'EMERGENCY_SOS' ? 'OTRO_EMERGENCIA' : 'OTRO_URBANO'),
            suggestedAgency: row.suggestedAgency ?? (row.type === 'EMERGENCY_SOS' ? 'SEGURIDAD_MUNICIPAL' : 'OBRAS_ASEO'),
          })
          .where(eq(alert.id, alertId));
        await this.events.record(tx, {
          alertId,
          tenantId: row.tenantId,
          actorType: 'AI',
          kind: 'AI_PROCESSED',
          payload: { skipped: true, reason: 'sin audio ni texto' },
        });
        return refreshAlertArea(tx, alertId, 'AI', null);
      });
      await this.emitUpdated(alertId, row.tenantId, before);
      return;
    }

    let transcription: string | null = row.transcription;
    let durationS: number | undefined;
    if (audio && !transcription && !local) {
      const buf = await this.mediaSvc.download(audio.storageKey);
      const r = await this.ai.transcribe({ audio: buf, mime: audio.mime });
      // La base acepta hasta 5000 caracteres (0009); un audio largo no debe hacer fallar el guardado.
      transcription = r.text.slice(0, 5000);
      durationS = r.durationS;
      if (durationS && durationS > this.env.AI_MAX_AUDIO_SECONDS) {
        this.logger.warn(`alerta ${alertId}: audio de ${durationS}s supera el máximo; se procesa igual`);
      }
      // La transcripción se guarda y se muestra apenas existe: el operador la lee mientras se
      // clasifica, y no se pierde si la clasificación falla (los reintentos no vuelven a transcribir).
      if (transcription) {
        await this.dbs.asSystem((tx) => tx.update(alert).set({ transcription }).where(eq(alert.id, alertId)));
        await this.emitTranscript(alertId, row.tenantId);
      }
    }

    const localTime = new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(row.createdAt);

    const result = await provider.classify({
      type: row.type,
      transcription,
      userText: row.userText,
      chosenCategory: row.category,
      localTime,
    });
    // Agente de clasificación: salida del modelo → normalizada → reglas fijas (frases críticas que
    // solo suben la urgencia). Igual para la IA real y para el clasificador sin red.
    const triage = buildTriage(row.type, result, [transcription, row.userText].filter(Boolean).join('. '), {
      provider: provider.name,
      model: provider.model,
    });

    const priority = capPriority(triage.priority, {
      type: row.type,
      text: [transcription, row.userText].filter(Boolean).join('. '),
      trustScore,
      restricted: row.citizenRestricted,
    });

    const { kept: keptByOperator, before } = await this.dbs.asSystem(async (tx) => {
      // Si el operador ya corrigió la clasificación (p. ej. llamó al vecino mientras la IA corría o
      // pidió volver a analizar), manda la suya: la IA solo actualiza su propuesta en ai_triage.
      const [label] = await tx
        .select({ category: triageLabel.category })
        .from(triageLabel)
        .where(eq(triageLabel.alertId, alertId))
        .limit(1);
      const kept = !!label?.category;
      await tx
        .update(alert)
        .set({
          transcription,
          ...(kept ? {} : { category: triage.category, subcategory: triage.subcategory }),
          priority,
          suggestedAgency: triage.agencies[0].agency,
          aiStatus: local ? 'LOCAL' : 'DONE',
          aiConfidence: triage.confidence,
          aiSummary: triage.summary,
          aiFlags: triage.flags,
          aiTriage: triage,
          aiError: local ? LOCAL_REASON_TEXT[local] : null,
        })
        .where(eq(alert.id, alertId));
      if (audio && durationS !== undefined) {
        await tx.update(media).set({ durationS }).where(eq(media.id, audio.id));
      }
      await this.events.record(tx, {
        alertId,
        tenantId: row.tenantId,
        actorType: 'AI',
        kind: 'AI_PROCESSED',
        payload: {
          provider: provider.name,
          model: provider.model,
          ...(local ? { local } : {}),
          version: triage.version,
          category: triage.category,
          subcategory: triage.subcategory,
          agencies: triage.agencies.map((a) => a.agency),
          priority,
          aiPriority: triage.modelPriority,
          rules: triage.rules,
          // Baja confianza o cuenta restringida (0011) dejaron el SOS en media.
          loweredByTrust: triage.priority === 'HIGH' && priority === 'MEDIUM',
          citizenRestricted: row.citizenRestricted,
          keptOperatorCategory: kept,
          confidence: triage.confidence,
          ms: Date.now() - started,
          attempt: job.attemptsMade + 1,
        },
      });
      // Áreas (0013): el reporte urbano va al área de la categoría que quedó (salvo que una persona lo haya
      // reasignado) y, si tiene carácter de seguridad, lo ve también el área de los SOS.
      return { kept, before: await refreshAlertArea(tx, alertId, 'AI', triage.flags.security_relevant) };
    });
    if (keptByOperator) this.logger.debug(`alerta ${alertId}: se mantiene la clasificación del operador`);
    this.metrics.aiProcessing.observe(
      { provider: provider.name, outcome: local ? 'local' : 'done' },
      (Date.now() - started) / 1000,
    );
    // Redirección por georreferencia: si el hecho ocurre en otra comuna de Guard-IA, el agente la
    // traspasa (con las condiciones de AUTO_TRANSFER) y el traspaso emite a ambas centrales.
    const moved = await this.transfers.maybeAutoTransfer(alertId, triage).catch((e: Error) => {
      this.logger.warn(`alerta ${alertId}: traspaso automático falló: ${e.message}`);
      return false;
    });
    if (!moved) await this.emitUpdated(alertId, row.tenantId, before);
  }

  /** Último intento fallido: falla segura. Un SOS sin clasificar es HIGH y se muestra igual. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessAlertJob> | undefined, error: Error) {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    // "Connection error." del SDK no dice nada: la causa real (certificado, DNS, timeout) viene en `cause`.
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    const why = cause ? ` (causa: ${cause.code ?? ''} ${cause.message ?? ''})` : '';
    this.logger.warn(`job ${job.id} intento ${job.attemptsMade}/${attempts} falló: ${error.message}${why}`);
    if (job.attemptsMade < attempts) return;

    const { alertId } = job.data;
    const out = await this.dbs.asSystem(async (tx) => {
      const [row] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
      if (!row) return null;
      // Sin IA (caída, sin cuota) igual se clasifica lo que se pueda: el clasificador sin red y las
      // reglas fijas no necesitan red. La alerta queda FAILED (la central sabe que no hubo IA) pero
      // no "sin clasificar" si el vecino escribió o alcanzó a transcribirse algo.
      const text = [row.transcription, row.userText].filter((t) => t?.trim()).join('. ');
      const fallback = text
        ? buildTriage(
            row.type,
            await FALLBACK.classify({ type: row.type, transcription: row.transcription, userText: row.userText, chosenCategory: row.category, localTime: '' }),
            text,
            { provider: FALLBACK.name, model: null },
          )
        : null;
      const [label] = await tx.select({ category: triageLabel.category }).from(triageLabel).where(eq(triageLabel.alertId, alertId)).limit(1);
      const keepCategory = !!label?.category;
      await tx
        .update(alert)
        .set({
          aiStatus: 'FAILED',
          // Mensaje genérico para la central; el detalle (rutas, códigos) queda en el log.
          aiError: `Clasificación automática no disponible tras ${attempts} intentos${fallback ? '; se clasificó con las reglas fijas' : ''}`,
          priority: capPriority(fallback?.priority ?? row.priority ?? (row.type === 'EMERGENCY_SOS' ? 'HIGH' : 'MEDIUM'), {
            type: row.type,
            text,
            trustScore: 100,
            restricted: row.citizenRestricted,
          }),
          ...(keepCategory
            ? {}
            : {
                category: fallback?.category ?? row.category ?? (row.type === 'EMERGENCY_SOS' ? 'OTRO_EMERGENCIA' : 'OTRO_URBANO'),
                subcategory: fallback?.subcategory ?? row.subcategory,
              }),
          suggestedAgency:
            fallback?.agencies[0].agency ?? row.suggestedAgency ?? (row.type === 'EMERGENCY_SOS' ? 'SEGURIDAD_MUNICIPAL' : 'OBRAS_ASEO'),
          ...(fallback ? { aiTriage: fallback, aiFlags: fallback.flags } : {}),
        })
        .where(eq(alert.id, alertId));
      await this.events.record(tx, {
        alertId,
        tenantId: row.tenantId,
        actorType: 'AI',
        kind: 'AI_FAILED',
        payload: {
          provider: this.ai.name,
          errorClass: error.name,
          attempts,
          ...(fallback ? { fallback: 'reglas', category: fallback.category, priority: fallback.priority, rules: fallback.rules } : {}),
        },
      });
      return { tenantId: row.tenantId, before: await refreshAlertArea(tx, alertId, 'AI', fallback ? fallback.flags.security_relevant : null) };
    });
    this.metrics.aiProcessing.observe({ provider: this.ai.name, outcome: 'failed' }, 0);
    await this.emitUpdated(alertId, out?.tenantId ?? null, out?.before);
  }

  /** Solo la ficha (sin recalcular el grupo): la clasificación llega después con emitUpdated. */
  private async emitTranscript(alertId: string, tenantId: string | null) {
    if (!tenantId) return;
    const detail = await this.dbs.asSystem((tx) => this.reads.detail(tx, alertId));
    this.realtime.alertUpdated(tenantId, detail);
  }

  private async emitUpdated(alertId: string, tenantId: string | null, before?: AreaBefore | null) {
    if (!tenantId) return;
    // La IA fijó prioridad, categoría y señales: se agrupa (si no alcanzó al crear la alerta) y se
    // recalcula la importancia del grupo. Si falla, la alerta se emite igual sin grupo actualizado.
    try {
      await this.incidents.attach(alertId);
    } catch (e) {
      this.logger.warn(`incidente de ${alertId} sin recalcular: ${(e as Error).message}`);
    }
    const detail = await this.dbs.asSystem((tx) => this.reads.detail(tx, alertId));
    if (before) this.realtime.alertMoved(tenantId, alertId, before, detail);
    this.realtime.alertUpdated(tenantId, detail);
  }
}

