import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { AlertsService } from '../alerts/alerts.service';
import { DbService } from '../db/db.service';
import { alert } from '../db/schema';

/**
 * Patrón outbox para la IA: si Redis no respondió al crear la alerta (o el job se perdió),
 * una alerta con cobertura queda `ai_status = QUEUED` sin job. Cada minuto se reencola.
 * El jobId determinista (`alert-<id>`) evita duplicados cuando el job sí existe.
 */
@Injectable()
export class AiOutboxCron {
  private readonly logger = new Logger(AiOutboxCron.name);
  private running = false;

  constructor(
    private readonly dbs: DbService,
    private readonly alerts: AlertsService,
  ) {}

  @Cron('*/1 * * * *')
  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const stale = await this.dbs.asSystem((tx) =>
        tx
          .select({ id: alert.id })
          .from(alert)
          .where(
            and(
              eq(alert.aiStatus, 'QUEUED'),
              isNotNull(alert.tenantId),
              lt(alert.createdAt, new Date(Date.now() - 45_000)),
            ),
          )
          .limit(200),
      );
      let n = 0;
      for (const { id } of stale) if (await this.alerts.enqueue(id)) n++;
      if (stale.length) this.logger.warn(`outbox IA: ${n}/${stale.length} alertas reencoladas`);
    } catch (e) {
      this.logger.error(`outbox IA falló: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
