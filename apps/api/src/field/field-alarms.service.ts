import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AckFieldAlarm, FieldAlarm } from '@guardia/shared';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { DbService } from '../db/db.service';
import { fieldAlarm } from '../db/schema';
import { EventsService } from '../events/events.service';
import { RealtimeService } from '../realtime/realtime.service';
import { loadAlarms } from './field-alarms';

/** Avisos de terreno en la central (0012): los abiertos se muestran arriba con sonido hasta que alguien los atiende. */
@Injectable()
export class FieldAlarmsService {
  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
  ) {}

  open(op: OperatorClaims): Promise<FieldAlarm[]> {
    return this.dbs.asOperator(op.tenantId, op.sub, (tx) =>
      loadAlarms(tx, and(eq(fieldAlarm.tenantId, op.tenantId), isNull(fieldAlarm.closedAt))),
    );
  }

  /** "Atendido": queda quién y cuándo; el funcionario recibe la respuesta a su pánico. */
  async ack(op: OperatorClaims, id: string, body: AckFieldAlarm): Promise<FieldAlarm> {
    const alarm = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await tx
        .update(fieldAlarm)
        .set({ closedAt: new Date(), closedBy: op.sub, closeNote: body.note ?? null })
        .where(and(eq(fieldAlarm.id, id), eq(fieldAlarm.tenantId, op.tenantId), isNull(fieldAlarm.closedAt)))
        .returning();
      if (!row) {
        const [current] = await loadAlarms(tx, and(eq(fieldAlarm.id, id), eq(fieldAlarm.tenantId, op.tenantId)), 1);
        if (!current) throw new AppError('NOT_FOUND', 'Aviso no encontrado');
        return current; // Otro operador ya lo atendió.
      }
      if (row.alertId) {
        await this.events.record(tx, {
          alertId: row.alertId,
          tenantId: op.tenantId,
          actorType: 'OPERATOR',
          actorId: op.sub,
          kind: 'FIELD_ALARM',
          payload: { alarmId: row.id, kind: row.kind, acknowledged: true, note: body.note ?? null },
        });
      }
      const [loaded] = await loadAlarms(tx, eq(fieldAlarm.id, row.id), 1);
      return loaded;
    });
    this.realtime.fieldAlarm(op.tenantId, alarm);
    return alarm;
  }
}
