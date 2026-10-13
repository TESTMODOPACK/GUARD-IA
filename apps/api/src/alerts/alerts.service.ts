import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import {
  CANCEL_WINDOW_SECONDS,
  type CitizenAlert,
  type CreateAlertMeta,
  type CreateAlertResponse,
} from '@guardia/shared';
import { ALERTS_QUEUE, PROCESS_ALERT_JOB, PROCESS_ALERT_JOB_OPTS, type ProcessAlertJob } from '../ai/ai.queue';
import { AppError } from '../common/app-error';
import { ENV, type Env } from '../config/env';
import { DbService, type Tx } from '../db/db.service';
import { alert, citizen, tenant, type AlertRow } from '../db/schema';
import { EventsService } from '../events/events.service';
import { MetricsService } from '../infra/metrics.service';
import { IncidentsService } from '../incidents/incidents.service';
import { RateLimitService } from '../infra/rate-limit.service';
import { MediaService } from '../media/media.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AlertReadService } from './alert-read.service';

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

interface TenantInfo {
  id: string;
  name: string;
  audioRetentionDays: number;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Camino crítico del SOS (ADR 002): insertar, guardar media, emitir a la central y
 * encolar la IA. Todo antes de responder; nada depende de OpenAI.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectQueue(ALERTS_QUEUE) private readonly queue: Queue<ProcessAlertJob>,
    private readonly dbs: DbService,
    private readonly mediaSvc: MediaService,
    private readonly events: EventsService,
    private readonly reads: AlertReadService,
    private readonly realtime: RealtimeService,
    private readonly rate: RateLimitService,
    private readonly metrics: MetricsService,
    private readonly incidents: IncidentsService,
  ) {}

  async create(
    citizenId: string,
    meta: CreateAlertMeta,
    files: { audio?: UploadedFile; photo?: UploadedFile },
  ): Promise<CreateAlertResponse> {
    const t0 = Date.now();

    if (files.audio && !this.mediaSvc.isAllowed('AUDIO', files.audio.mimetype)) {
      throw new AppError('VALIDATION_ERROR', `Formato de audio no soportado: ${files.audio.mimetype}`);
    }
    if (files.photo && !this.mediaSvc.isAllowed('PHOTO', files.photo.mimetype)) {
      throw new AppError('VALIDATION_ERROR', `Formato de imagen no soportado: ${files.photo.mimetype}`);
    }

    // 1. Idempotencia: un reintento de la app con el mismo clientRef devuelve la misma alerta
    //    sin consumir cuota ni crear nada. Transacción corta y separada (nunca anidar).
    const existing = meta.clientRef ? await this.findByClientRef(citizenId, meta.clientRef) : null;
    if (existing) return this.toResponse(existing.row, existing.tenant);

    // 2. Cuota. Fail-open: si Redis no responde en 300 ms, el SOS pasa igual (sección 9, ADR 002).
    if (meta.type === 'EMERGENCY_SOS') {
      await this.rate.hit(
        `sos:${citizenId}`,
        this.env.RATE_SOS_PER_10MIN,
        600,
        'Demasiados SOS seguidos. Si es una emergencia real, llama al 133.',
        { failOpen: true },
      );
    } else {
      await this.rate.hit(`civic:${citizenId}`, this.env.RATE_CIVIC_PER_DAY, 86_400, 'Límite diario de reportes alcanzado', {
        failOpen: true,
      });
    }

    // 3. Insert + media + evento, en una sola transacción de ciudadano.
    let created: { row: AlertRow; tenant: TenantInfo | null };
    try {
      created = await this.dbs.asCitizen(citizenId, async (tx) => {
        const [c] = await tx.select().from(citizen).where(eq(citizen.id, citizenId)).limit(1);
        if (!c) throw new AppError('UNAUTHORIZED', 'Ciudadano no encontrado');
        if (!c.consentAt) throw new AppError('CONSENT_REQUIRED', 'Debes aceptar el consentimiento antes de enviar una alerta');

        // trust_score < 25 limita la prioridad a MEDIUM; lo aplica el worker IA (sección 9).
        const [row] = await tx
          .insert(alert)
          .values({
            citizenId,
            clientRef: meta.clientRef ?? null,
            type: meta.type,
            source: meta.source,
            lat: meta.location.lat,
            lng: meta.location.lng,
            accuracyM: meta.accuracyM ?? null,
            userText: meta.userText?.trim() || null,
            category: meta.category ?? null,
            // El trigger alert_route fija tenant_id y, si no hay cobertura, status/ai_status.
          })
          .returning();

        // tenant es de solo lectura para todos los roles: se lee con la misma tx.
        const tenantInfo = row.tenantId ? await this.readTenant(tx, row.tenantId) : null;
        const retentionDays = tenantInfo?.audioRetentionDays ?? 90;

        if (files.audio) {
          await this.mediaSvc.store(tx, {
            alertId: row.id,
            tenantId: row.tenantId,
            kind: 'AUDIO',
            body: files.audio.buffer,
            mime: files.audio.mimetype,
            retentionDays,
          });
        }
        if (files.photo) {
          await this.mediaSvc.store(tx, {
            alertId: row.id,
            tenantId: row.tenantId,
            kind: 'PHOTO',
            body: files.photo.buffer,
            mime: files.photo.mimetype,
            retentionDays,
          });
        }

        await this.events.record(tx, {
          alertId: row.id,
          tenantId: row.tenantId,
          actorType: 'CITIZEN',
          actorId: citizenId,
          kind: 'CREATED',
          payload: {
            source: meta.source,
            accuracyM: meta.accuracyM ?? null,
            hasAudio: Boolean(files.audio),
            hasPhoto: Boolean(files.photo),
            trustScore: c.trustScore,
            routed: Boolean(row.tenantId),
          },
        });
        return { row, tenant: tenantInfo };
      });
    } catch (e) {
      // Dos reintentos simultáneos con el mismo clientRef: gana uno, el otro devuelve la misma alerta.
      if (meta.clientRef && isUniqueViolation(e)) {
        const again = await this.findByClientRef(citizenId, meta.clientRef);
        if (again) return this.toResponse(again.row, again.tenant);
      }
      throw e;
    }

    const { row, tenant: tenantInfo } = created;
    this.metrics.alertsCreated.inc({ type: row.type, status: row.status });

    if (row.tenantId) {
      // Agrupar con reportes de la misma situación ANTES de avisar, para que la central reciba la
      // alerta ya agrupada y no suene por cada repetido. Ya está confirmada: si esto tarda más de
      // 200 ms o falla, sale sin grupo y el worker la agrupa después (regla 1: el SOS no espera).
      const incidentId = await this.groupQuickly(row.id);
      // Paso 2: la central lo ve ahora, antes de cualquier IA.
      const summary = await this.dbs.asSystem((tx) => this.reads.summary(tx, { ...row, incidentId }));
      this.realtime.alertCreated(row.tenantId, summary);
      this.metrics.alertCreateLatency.observe({ type: row.type }, (Date.now() - t0) / 1000);

      if (row.aiStatus === 'QUEUED') await this.enqueue(row.id);
    } else {
      this.logger.warn(`alerta ${row.id} fuera de cobertura (${row.lat}, ${row.lng})`);
    }

    return this.toResponse(row, tenantInfo);
  }

  /**
   * Encola el job de IA sin bloquear la respuesta más de 800 ms. Si Redis no responde,
   * la alerta queda QUEUED y el barrido de AiOutboxCron la reencola después.
   */
  async enqueue(alertId: string, jobId = `alert-${alertId}`): Promise<boolean> {
    try {
      await withTimeout(
        this.queue.add(PROCESS_ALERT_JOB, { alertId, enqueuedAt: new Date().toISOString() }, { ...PROCESS_ALERT_JOB_OPTS, jobId }),
        800,
      );
      return true;
    } catch (e) {
      this.logger.error(`No se pudo encolar la IA de ${alertId}: ${(e as Error).message}; la reencola el outbox`);
      return false;
    }
  }

  private toResponse(row: AlertRow, t: TenantInfo | null): CreateAlertResponse {
    return {
      alertId: row.id,
      status: row.status,
      tenant: t ? { id: t.id, name: t.name } : null,
      cancellableUntil: new Date(row.createdAt.getTime() + CANCEL_WINDOW_SECONDS * 1000).toISOString(),
    };
  }

  private async findByClientRef(citizenId: string, clientRef: string) {
    return this.dbs.asCitizen(citizenId, async (tx) => {
      const [row] = await tx
        .select()
        .from(alert)
        .where(and(eq(alert.citizenId, citizenId), eq(alert.clientRef, clientRef)))
        .limit(1);
      if (!row) return null;
      return { row, tenant: row.tenantId ? await this.readTenant(tx, row.tenantId) : null };
    });
  }

  private async readTenant(tx: Tx, tenantId: string): Promise<TenantInfo | null> {
    const [t] = await tx
      .select({ id: tenant.id, name: tenant.name, audioRetentionDays: tenant.audioRetentionDays })
      .from(tenant)
      .where(eq(tenant.id, tenantId))
      .limit(1);
    return t ?? null;
  }

  /** El vecino cancela su alerta: solo PENDING y dentro de la ventana. */
  async cancel(citizenId: string, alertId: string): Promise<CitizenAlert> {
    const { view, tenantId } = await this.dbs.asCitizen(citizenId, async (tx) => {
      const [row] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
      if (!row) throw new AppError('NOT_FOUND', 'Alerta no encontrada');
      if (row.status !== 'PENDING') {
        throw new AppError('INVALID_TRANSITION', `No se puede cancelar una alerta en estado ${row.status}`);
      }
      if (Date.now() - row.createdAt.getTime() > CANCEL_WINDOW_SECONDS * 1000) {
        throw new AppError('CANCEL_WINDOW_EXPIRED', `La ventana de cancelación es de ${CANCEL_WINDOW_SECONDS} s`);
      }
      const [updated] = await tx
        .update(alert)
        .set({ status: 'CANCELLED', aiStatus: row.aiStatus === 'QUEUED' ? 'SKIPPED' : row.aiStatus })
        .where(eq(alert.id, alertId))
        .returning();
      await this.events.record(tx, {
        alertId,
        tenantId: row.tenantId,
        actorType: 'CITIZEN',
        actorId: citizenId,
        kind: 'CANCELLED',
        payload: { secondsAfterCreate: Math.round((Date.now() - row.createdAt.getTime()) / 1000) },
      });
      return { view: await this.reads.citizenViewFromRow(tx, updated), tenantId: row.tenantId };
    });

    // Si el job aún no corrió (en cola, con backoff o priorizado) se retira; si ya corre, el worker verá CANCELLED.
    try {
      const job = await this.queue.getJob(`alert-${alertId}`);
      const state = job ? await job.getState() : null;
      if (job && state && ['waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) {
        await job.remove();
      }
    } catch (e) {
      this.logger.warn(`No se pudo retirar el job de ${alertId}: ${(e as Error).message}`);
    }

    if (tenantId) {
      // Una alerta cancelada deja de contar en su grupo.
      await this.incidents.attach(alertId).catch((e: Error) => this.logger.warn(`recalcular incidente de ${alertId}: ${e.message}`));
      const detail = await this.dbs.asSystem((tx) => this.reads.detail(tx, alertId));
      this.realtime.alertUpdated(tenantId, detail);
    }
    return view;
  }

  /**
   * Agrupa con tope de 200 ms (en producción tarda unos ms). Nunca lanza: si no alcanza, el worker
   * IA vuelve a intentarlo (attach es idempotente). Devuelve el incidente o null.
   */
  private async groupQuickly(alertId: string): Promise<string | null> {
    try {
      return (await withTimeout(this.incidents.attach(alertId), 200))?.incidentId ?? null;
    } catch (e) {
      this.logger.warn(`agrupación de ${alertId} pendiente (la hace el worker): ${(e as Error).message}`);
      return null;
    }
  }

  async mine(citizenId: string, limit: number): Promise<CitizenAlert[]> {
    return this.dbs.asCitizen(citizenId, async (tx) => {
      const rows = await tx
        .select()
        .from(alert)
        .where(eq(alert.citizenId, citizenId))
        .orderBy(desc(alert.createdAt))
        .limit(limit);
      return Promise.all(rows.map((r) => this.reads.citizenViewFromRow(tx, r)));
    });
  }

  async one(citizenId: string, alertId: string): Promise<CitizenAlert> {
    return this.dbs.asCitizen(citizenId, (tx) => this.reads.citizenView(tx, alertId));
  }
}
