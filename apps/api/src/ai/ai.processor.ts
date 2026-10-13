import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { AlertReadService } from '../alerts/alert-read.service';
import { ENV, type Env } from '../config/env';
import { DbService } from '../db/db.service';
import { alert, citizen, media, tenant } from '../db/schema';
import { EventsService } from '../events/events.service';
import { IncidentsService } from '../incidents/incidents.service';
import { MediaService } from '../media/media.service';
import { MetricsService } from '../infra/metrics.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AI_PROVIDER, type AiProvider } from './ai.provider';
import { ALERTS_QUEUE, type ProcessAlertJob } from './ai.queue';

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

    // Sección 9: bajo 25 de confianza la alerta entra como MEDIUM aunque la IA diga HIGH.
    const lowTrust = trustScore < 25 && result.priority === 'HIGH';
    const priority = lowTrust ? 'MEDIUM' : result.priority;

    await this.dbs.asSystem(async (tx) => {
      await tx
        .update(alert)
        .set({
          transcription,
          category: result.category,
          priority,
          suggestedAgency: result.suggested_agency,
          aiStatus: 'DONE',
          aiConfidence: result.confidence,
          aiSummary: result.summary,
          aiFlags: result.flags,
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
          category: result.category,
          priority,
          aiPriority: result.priority,
          loweredByTrust: lowTrust,
          confidence: result.confidence,
          ms: Date.now() - started,
          attempt: job.attemptsMade + 1,
        },
      });
    });
    this.metrics.aiProcessing.observe({ provider: this.ai.name, outcome: 'done' }, (Date.now() - started) / 1000);
    await this.emitUpdated(alertId, row.tenantId);
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
      await tx
        .update(alert)
        .set({
          aiStatus: 'FAILED',
          // Mensaje genérico para la central; el detalle (rutas, códigos) queda en el log.
          aiError: `Clasificación automática no disponible tras ${attempts} intentos`,
          priority: row.priority ?? (row.type === 'EMERGENCY_SOS' ? 'HIGH' : 'MEDIUM'),
          category: row.category ?? (row.type === 'EMERGENCY_SOS' ? 'OTRO_EMERGENCIA' : 'OTRO_URBANO'),
          suggestedAgency: row.suggestedAgency ?? (row.type === 'EMERGENCY_SOS' ? 'SEGURIDAD_MUNICIPAL' : 'OBRAS_ASEO'),
        })
        .where(eq(alert.id, alertId));
      await this.events.record(tx, {
        alertId,
        tenantId: row.tenantId,
        actorType: 'AI',
        kind: 'AI_FAILED',
        payload: { provider: this.ai.name, errorClass: error.name, attempts },
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
