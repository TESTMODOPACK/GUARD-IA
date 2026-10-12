import { Injectable } from '@nestjs/common';
import type { ActorType, AlertEventKind } from '@guardia/shared';
import type { Tx } from '../db/db.service';
import { alertEvent, type AlertEventRow } from '../db/schema';

export interface RecordEventInput {
  alertId: string;
  tenantId: string | null;
  actorType: ActorType;
  actorId?: string | null;
  kind: AlertEventKind;
  payload?: Record<string, unknown>;
}

/** Línea de tiempo / auditoría. Siempre dentro de la transacción que produce el cambio. */
@Injectable()
export class EventsService {
  async record(tx: Tx, e: RecordEventInput): Promise<AlertEventRow> {
    const [row] = await tx
      .insert(alertEvent)
      .values({
        alertId: e.alertId,
        tenantId: e.tenantId,
        actorType: e.actorType,
        actorId: e.actorId ?? null,
        kind: e.kind,
        payload: e.payload ?? {},
      })
      .returning();
    return row;
  }
}
