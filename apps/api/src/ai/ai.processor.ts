import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { buildTriage } from '@guardia/shared';
import { AlertReadService } from '../alerts/alert-read.service';
import { ENV, type Env } from '../config/env';
import { DbService } from '../db/db.service';
import { alert, citizen, media, tenant, triageLabel } from '../db/schema';
import { EventsService } from '../events/events.service';
import { TransferService } from '../geo/transfer.service';
import { IncidentsService } from '../incidents/incidents.service';
import { MediaService } from '../media/media.service';
import { MetricsService } from '../infra/metrics.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AI_PROVIDER, type AiProvider } from './ai.provider';
import { ALERTS_QUEUE, type ProcessAlertJob } from './ai.queue';
import { MockAiProvider } from './mock.provider';

/** Clasificador sin red para cuando la IA no responde (más las reglas fijas de shared). */
const FALLBACK = new MockAiProvider();

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
        .select({ trust: citizen.trustScore })
        .from(citizen)
        .where(eq(citizen.id, row.citizenId))
        .limit(1);
      return {
        row,
        audio: audio ?? null,
        timezone: t?.timezone ?? 'America/Santiago',
        trustScore: c?.trust ?? 100,
      };
    });
    if (!ctx) {
      this.logger.debug(`job ${job.id}: alerta ${alertId} no requiere IA`);
      return;
    }
    const { row, audio, timezone, trustScore } = ctx;

    // Sin nada que analizar: reporte urbano con categoría elegida → SKIPPED.
    if (!audio && !row.userText?.trim()) {
      await this.dbs.asSystem(async (tx) => {
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
      });
      await this.emitUpdated(alertId, row.tenantId);
      return;
    }

    let transcription: string | null = row.transcription;
    let durationS: number | undefined;
    if (audio && !transcription) {
      const buf = await this.mediaSvc.download(audio.storageKey);
      const r = await this.ai.transcribe({ audio: buf, mime: audio.mime });
      transcription = r.text;
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

    const result = await this.ai.classify({
      type: row.type,
      transcription,
      userText: row.userText,
      chosenCategory: row.category,
      localTime,
    });
    // Agente de clasificación: salida del modelo → normalizada → reglas fijas (frases críticas que
    // solo suben la urgencia). Igual para la IA real y para el clasificador sin red.
    const triage = buildTriage(row.type, result, [transcription, row.userText].filter(Boolean).join('. '), {
      provider: this.ai.name,
      model: this.ai.model,
    });

    // Sección 9: bajo 25 de confianza la alerta entra como MEDIUM aunque la IA diga HIGH.
    const lowTrust = trustScore < 25 && triage.priority === 'HIGH';
    const priority = lowTrust ? 'MEDIUM' : triage.priority;

    const keptByOperator = await this.dbs.asSystem(async (tx) => {
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
          aiStatus: 'DONE',
          aiConfidence: triage.confidence,
          aiSummary: triage.summary,
          aiFlags: triage.flags,
          aiTriage: triage,
          aiError: null,
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
          provider: this.ai.name,
          model: this.ai.model,
          version: triage.version,
          category: triage.category,
          subcategory: triage.subcategory,
          agencies: triage.agencies.map((a) => a.agency),
          priority,
          aiPriority: triage.modelPriority,
          rules: triage.rules,
          loweredByTrust: lowTrust,
          keptOperatorCategory: kept,
          confidence: triage.confidence,
          ms: Date.now() - started,
          attempt: job.attemptsMade + 1,
        },
      });
      return kept;
    });
    if (keptByOperator) this.logger.debug(`alerta ${alertId}: se mantiene la clasificación del operador`);
    this.metrics.aiProcessing.observe({ provider: this.ai.name, outcome: 'done' }, (Date.now() - started) / 1000);
    // Redirección por georreferencia: si el hecho ocurre en otra comuna de Guard-IA, el agente la
    // traspasa (con las condiciones de AUTO_TRANSFER) y el traspaso emite a ambas centrales.
    const moved = await this.transfers.maybeAutoTransfer(alertId, triage).catch((e: Error) => {
      this.logger.warn(`alerta ${alertId}: traspaso automático falló: ${e.message}`);
      return false;
    });
    if (!moved) await this.emitUpdated(alertId, row.tenantId);
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
    const tenantId = await this.dbs.asSystem(async (tx) => {
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
          priority: fallback?.priority ?? row.priority ?? (row.type === 'EMERGENCY_SOS' ? 'HIGH' : 'MEDIUM'),
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
      return row.tenantId;
    });
    this.metrics.aiProcessing.observe({ provider: this.ai.name, outcome: 'failed' }, 0);
    await this.emitUpdated(alertId, tenantId);
  }

  /** Solo la ficha (sin recalcular el grupo): la clasificación llega después con emitUpdated. */
  private async emitTranscript(alertId: string, tenantId: string | null) {
    if (!tenantId) return;
    const detail = await this.dbs.asSystem((tx) => this.reads.detail(tx, alertId));
    this.realtime.alertUpdated(tenantId, detail);
  }

  private async emitUpdated(alertId: string, tenantId: string | null) {
    if (!tenantId) return;
    // La IA fijó prioridad, categoría y señales: se agrupa (si no alcanzó al crear la alerta) y se
    // recalcula la importancia del grupo. Si falla, la alerta se emite igual sin grupo actualizado.
    try {
      await this.incidents.attach(alertId);
    } catch (e) {
      this.logger.warn(`incidente de ${alertId} sin recalcular: ${(e as Error).message}`);
    }
    const detail = await this.dbs.asSystem((tx) => this.reads.detail(tx, alertId));
    this.realtime.alertUpdated(tenantId, detail);
  }
}
