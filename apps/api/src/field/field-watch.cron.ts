import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { inArray, sql } from 'drizzle-orm';
import { FIELD_DEADLINES } from '@guardia/shared';
import { DbService } from '../db/db.service';
import { fieldAlarm } from '../db/schema';
import { RealtimeService } from '../realtime/realtime.service';
import { loadAlarms } from './field-alarms';

/**
 * Plazos de terreno (RT-7): despachada y sin "en camino" en 2 min (LATE); en camino o en el lugar sin noticias en
 * el tiempo esperado (NO_NEWS). Solo para unidades con un funcionario de terreno en turno; una unidad que se
 * maneja por radio la actualiza la central. Un aviso por plazo: se vuelve a avisar solo si el despacho cambió
 * después del aviso anterior. Cuando la unidad mueve el despacho, el trigger dispatch_field_alarm_clear lo cierra.
 */
@Injectable()
export class FieldWatchCron {
  private readonly logger = new Logger(FieldWatchCron.name);
  private running = false;

  constructor(
    private readonly dbs: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  @Cron('*/30 * * * * *')
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.check();
    } catch (e) {
      this.logger.error(`Plazos de terreno: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Crea los avisos vencidos y los emite a cada central. Devuelve cuántos creó (para los tests). */
  async check(): Promise<number> {
    const created = await this.dbs.asSystem(async (tx) => {
      const rows = (await tx.execute(sql`
        WITH due AS (
          SELECT d.id, d.tenant_id, d.unit_id, d.alert_id,
                 (CASE WHEN d.status = 'ASSIGNED' THEN 'LATE' ELSE 'NO_NEWS' END)::field_alarm_kind AS kind
            FROM dispatch d
           WHERE ((d.status = 'ASSIGNED' AND d.updated_at < now() - make_interval(secs => ${FIELD_DEADLINES.assignedSeconds}))
               OR (d.status = 'EN_ROUTE' AND d.updated_at < now() - make_interval(mins => ${FIELD_DEADLINES.enRouteMinutes}))
               OR (d.status = 'ON_SITE' AND d.updated_at < now() - make_interval(mins => ${FIELD_DEADLINES.onSiteMinutes})))
             AND EXISTS (SELECT 1 FROM shift s JOIN operator o ON o.id = s.operator_id
                          WHERE s.unit_id = d.unit_id AND s.started_at IS NOT NULL AND s.ended_at IS NULL
                            AND o.role = 'FIELD')
        )
        INSERT INTO field_alarm (tenant_id, kind, unit_id, dispatch_id, alert_id)
        SELECT due.tenant_id, due.kind, due.unit_id, due.id, due.alert_id FROM due
         WHERE NOT EXISTS (SELECT 1 FROM field_alarm a JOIN dispatch d ON d.id = a.dispatch_id
                            WHERE a.dispatch_id = due.id AND a.kind = due.kind AND a.created_at >= d.updated_at)
        ON CONFLICT DO NOTHING
        RETURNING id, tenant_id, alert_id, kind`)) as unknown as { id: string; tenant_id: string; alert_id: string; kind: string }[];
      for (const r of rows) {
        await tx.execute(sql`
          INSERT INTO alert_event (alert_id, actor_type, kind, payload)
          VALUES (${r.alert_id}::uuid, 'SYSTEM', 'FIELD_ALARM', ${JSON.stringify({ alarmId: r.id, kind: r.kind })}::jsonb)`);
      }
      return rows;
    });
    if (!created.length) return 0;
    const alarms = await this.dbs.asSystem((tx) =>
      loadAlarms(
        tx,
        inArray(
          fieldAlarm.id,
          created.map((r) => r.id),
        ),
      ),
    );
    for (const a of alarms) {
      const tenantId = created.find((r) => r.id === a.id)?.tenant_id;
      if (tenantId) this.realtime.fieldAlarm(tenantId, a);
    }
    this.logger.warn(`${alarms.length} avisos de plazo de terreno`);
    return alarms.length;
  }
}
