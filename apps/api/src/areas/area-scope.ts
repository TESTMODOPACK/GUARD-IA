import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { AreaRef, AreaSource, OperatorRole } from '@guardia/shared';
import type { Tx } from '../db/db.service';
import { area, operatorArea, tenantAreaMode } from '../db/schema';

/**
 * Qué avisos ve un operador (0013), igual que las políticas de la base (operator_sees_all, operator_area_ids,
 * operator_in_sos_area): la central lo muestra y el socket /ops elige las rooms con esto. Funciona en contexto system
 * y operator.
 */
export interface OperatorScope {
  /** Administrador, municipio en modo compartido o municipio sin áreas activas. */
  seesAll: boolean;
  areas: AreaRef[];
  /** Pertenece al área que recibe los SOS: ve también los reportes urbanos con carácter de seguridad. */
  inSosArea: boolean;
}

export async function loadOperatorScope(
  tx: Tx,
  op: { id: string; tenantId: string; role: OperatorRole },
): Promise<OperatorScope> {
  const areas = await tx
    .select({ id: area.id, name: area.name, receivesSos: area.receivesSos })
    .from(operatorArea)
    .innerJoin(area, and(eq(area.id, operatorArea.areaId), eq(area.active, true)))
    .where(and(eq(operatorArea.operatorId, op.id), eq(operatorArea.tenantId, op.tenantId)))
    .orderBy(asc(area.name));
  const [{ n }] = await tx
    .select({ n: count() })
    .from(area)
    .where(and(eq(area.tenantId, op.tenantId), eq(area.active, true)));
  const [mode] = await tx
    .select({ shared: tenantAreaMode.shared })
    .from(tenantAreaMode)
    .where(eq(tenantAreaMode.tenantId, op.tenantId))
    .limit(1);
  return {
    seesAll: op.role === 'ADMIN' || !!mode?.shared || n === 0,
    areas,
    inSosArea: areas.some((a) => a.receivesSos),
  };
}

/** Cómo estaba el aviso antes de recalcular su área (para avisar a quienes dejan de verlo). */
export type AreaBefore = { areaId: string | null; securityRelevant: boolean };

/**
 * Recalcula el área (y la marca de seguridad, si se indica) con refresh_alert_area (0013). Respeta la reasignación de
 * una persona. Contexto system u operator del mismo municipio.
 */
export async function refreshAlertArea(
  tx: Tx,
  alertId: string,
  source: AreaSource,
  security: boolean | null,
): Promise<AreaBefore | null> {
  const rows = (await tx.execute(
    sql`SELECT out_prev_area, out_prev_security FROM refresh_alert_area(${alertId}::uuid, ${source}::area_source, ${security}::boolean)`,
  )) as unknown as { out_prev_area: string | null; out_prev_security: boolean }[];
  const r = rows[0];
  return r ? { areaId: r.out_prev_area, securityRelevant: r.out_prev_security } : null;
}
