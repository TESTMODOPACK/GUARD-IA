import { desc, eq, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FieldAlarm } from '@guardia/shared';
import type { Tx } from '../db/db.service';
import { fieldAlarm, operator, unit, type FieldAlarmRow } from '../db/schema';

const closer = alias(operator, 'closer');

/**
 * Avisos de terreno con el código de la unidad y los nombres. En el contexto `field` el funcionario solo ve su
 * propia cuenta: el nombre de quien atendió llega null (la página dice "la central").
 */
export async function loadAlarms(tx: Tx, where: SQL | undefined, limit = 100): Promise<FieldAlarm[]> {
  const rows = await tx
    .select({ a: fieldAlarm, unitCode: unit.code, operatorName: operator.name, closedByName: closer.name })
    .from(fieldAlarm)
    .leftJoin(unit, eq(unit.id, fieldAlarm.unitId))
    .leftJoin(operator, eq(operator.id, fieldAlarm.operatorId))
    .leftJoin(closer, eq(closer.id, fieldAlarm.closedBy))
    .where(where)
    .orderBy(desc(fieldAlarm.createdAt))
    .limit(limit);
  return rows.map((r) => toFieldAlarm(r.a, r));
}

export function toFieldAlarm(
  a: FieldAlarmRow,
  names: { unitCode: string | null; operatorName: string | null; closedByName: string | null },
): FieldAlarm {
  return {
    id: a.id,
    kind: a.kind,
    unitId: a.unitId,
    unitCode: names.unitCode,
    operatorId: a.operatorId,
    operatorName: names.operatorName,
    dispatchId: a.dispatchId,
    alertId: a.alertId,
    location: a.lat !== null && a.lng !== null ? { lat: a.lat, lng: a.lng } : null,
    note: a.note,
    createdAt: a.createdAt.toISOString(),
    closedAt: a.closedAt?.toISOString() ?? null,
    closedByName: names.closedByName,
  };
}
