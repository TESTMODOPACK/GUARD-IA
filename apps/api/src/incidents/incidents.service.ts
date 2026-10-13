import { Global, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  importanceLevel,
  incidentImportance,
  INCIDENT_RULES,
  RECURRENCE_LOOKBACK_DAYS,
  type ImportanceReason,
  type IncidentInfo,
  type Priority,
} from '@guardia/shared';
import { DbService, type Tx } from '../db/db.service';
import { alert, incident, type AlertRow } from '../db/schema';

const OPEN_SQL = sql.raw(`('PENDING','ACKNOWLEDGED','DISPATCHED')`);
const PRIORITY_BY_RANK: Priority[] = ['HIGH', 'MEDIUM', 'LOW'];

export interface AttachResult {
  incidentId: string;
  /** La alerta se sumó a un incidente que ya existía (no abrió uno nuevo). */
  joined: boolean;
}

/**
 * Agrupa alertas en incidentes (migración 0004) y mantiene su importancia. Nunca está en el camino
 * crítico del SOS: se llama después del commit, con tope de tiempo, y el worker lo reintenta.
 */
@Injectable()
export class IncidentsService {
  constructor(private readonly dbs: DbService) {}

  /**
   * Suma la alerta al incidente abierto que corresponda o abre uno nuevo. Idempotente: si la
   * alerta ya tiene incidente, solo recalcula (lo usa el worker cuando la IA cambia prioridad o
   * categoría, y la central tras cancelar o rechazar).
   */
  attach(alertId: string): Promise<AttachResult | null> {
    return this.dbs.asSystem((tx) => this.attachInTx(tx, alertId));
  }

  async attachInTx(tx: Tx, alertId: string): Promise<AttachResult | null> {
    const [a] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
    if (!a || !a.tenantId) return null;
    if (a.incidentId) {
      await this.recompute(tx, a.incidentId);
      return { incidentId: a.incidentId, joined: false };
    }
    if (!['PENDING', 'ACKNOWLEDGED', 'DISPATCHED'].includes(a.status)) return null;

    // Dos reportes simultáneos del mismo bache no deben abrir dos incidentes: se serializa la
    // búsqueda por municipio y tipo (el lock se suelta al terminar la transacción).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${a.tenantId}:${a.type}`}, 0))`);

    const existing = await this.findOpenMatch(tx, a);
    if (existing) {
      await tx.update(alert).set({ incidentId: existing }).where(eq(alert.id, a.id));
      await this.recompute(tx, existing);
      return { incidentId: existing, joined: true };
    }

    const recurrenceCount = a.type === 'CIVIC_REPORT' ? await this.closedNearby(tx, a) : 0;
    const [created] = await tx
      .insert(incident)
      .values({
        tenantId: a.tenantId,
        type: a.type,
        category: a.category,
        lat: a.lat,
        lng: a.lng,
        recurrenceCount,
        firstAlertAt: a.createdAt,
        lastAlertAt: a.createdAt,
      })
      .returning({ id: incident.id });
    await tx.update(alert).set({ incidentId: created.id }).where(eq(alert.id, a.id));
    await this.recompute(tx, created.id);
    return { incidentId: created.id, joined: false };
  }

  /**
   * "Separar del grupo": la central decidió que esta alerta es otra situación. Queda sola en un
   * incidente nuevo (sin volver a agruparse) y el grupo anterior se recalcula. Usa la tx del
   * operador (RLS: solo su municipio).
   */
  async detachInTx(tx: Tx, a: AlertRow): Promise<string> {
    const previous = a.incidentId;
    const [created] = await tx
      .insert(incident)
      .values({
        tenantId: a.tenantId!,
        type: a.type,
        category: a.category,
        lat: a.lat,
        lng: a.lng,
        firstAlertAt: a.createdAt,
        lastAlertAt: a.createdAt,
      })
      .returning({ id: incident.id });
    await tx.update(alert).set({ incidentId: created.id }).where(eq(alert.id, a.id));
    await this.recompute(tx, created.id);
    if (previous) await this.recompute(tx, previous);
    return created.id;
  }

  /** Incidente abierto más cercano que cumple las reglas de tipo, distancia, tiempo y categoría. */
  private async findOpenMatch(tx: Tx, a: AlertRow): Promise<string | null> {
    const rule = INCIDENT_RULES[a.type];
    const point = sql`ST_SetSRID(ST_MakePoint(${a.lng}, ${a.lat}), 4326)::geography`;
    const category =
      a.type === 'CIVIC_REPORT'
        ? sql`i.category IS NOT DISTINCT FROM ${a.category}::alert_category`
        : // En un SOS la categoría llega después (IA): sin clasificar o "otro" no separa.
          sql`(i.category IS NULL OR ${a.category}::alert_category IS NULL OR i.category = ${a.category}::alert_category
               OR i.category = 'OTRO_EMERGENCIA' OR ${a.category}::alert_category = 'OTRO_EMERGENCIA')`;
    const rows = (await tx.execute(sql`
      SELECT i.id FROM incident i
      WHERE i.tenant_id = ${a.tenantId}::uuid
        AND i.type = ${a.type}::alert_type
        AND i.last_alert_at >= ${a.createdAt.toISOString()}::timestamptz - make_interval(mins => ${rule.windowMin})
        AND ST_DWithin(i.location, ${point}, ${rule.radiusM})
        AND ${category}
        AND EXISTS (SELECT 1 FROM alert m WHERE m.incident_id = i.id AND m.status IN ${OPEN_SQL})
      ORDER BY ST_Distance(i.location, ${point})
      LIMIT 1`)) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  }

  /** Incidentes ya cerrados de la misma categoría en el mismo lugar en los últimos 90 días. */
  private async closedNearby(tx: Tx, a: AlertRow): Promise<number> {
    const point = sql`ST_SetSRID(ST_MakePoint(${a.lng}, ${a.lat}), 4326)::geography`;
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM incident i
      WHERE i.tenant_id = ${a.tenantId}::uuid
        AND i.type = 'CIVIC_REPORT'
        AND i.category IS NOT DISTINCT FROM ${a.category}::alert_category
        AND i.last_alert_at >= now() - make_interval(days => ${RECURRENCE_LOOKBACK_DAYS})
        AND ST_DWithin(i.location, ${point}, ${INCIDENT_RULES.CIVIC_REPORT.radiusM})
        AND NOT EXISTS (SELECT 1 FROM alert m WHERE m.incident_id = i.id AND m.status IN ${OPEN_SQL})`)) as unknown as {
      n: number;
    }[];
    return rows[0]?.n ?? 0;
  }

  /**
   * Recalcula conteos, centro e importancia desde sus alertas. No cuentan las canceladas por el
   * vecino ni las rechazadas por la central (una falsa alarma no confirma nada).
   */
  async recompute(tx: Tx, incidentId: string): Promise<void> {
    const [inc] = await tx.select().from(incident).where(eq(incident.id, incidentId)).limit(1);
    if (!inc) return;
    const [agg] = (await tx.execute(sql`
      SELECT count(*)::int AS n,
             count(DISTINCT a.citizen_id)::int AS citizens,
             to_char(min(a.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_at,
             to_char(max(a.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_at,
             avg(a.lat) AS lat, avg(a.lng) AS lng,
             min(CASE a.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 END) AS prank,
             coalesce(bool_or((a.ai_flags->>'weapon_mentioned')::boolean), false) AS weapon,
             coalesce(bool_or((a.ai_flags->>'people_injured')::boolean), false) AS injured,
             coalesce(bool_or((a.ai_flags->>'minor_involved')::boolean), false) AS minor,
             coalesce(bool_and(coalesce((a.ai_flags->>'possible_false_alarm')::boolean, false)), false) AS false_alarm,
             max(c.trust_score) AS max_trust,
             (array_agg(a.category ORDER BY a.created_at) FILTER (WHERE a.category IS NOT NULL))[1] AS category
      FROM alert a JOIN citizen c ON c.id = a.citizen_id
      WHERE a.incident_id = ${incidentId}::uuid AND a.status NOT IN ('CANCELLED', 'REJECTED')`)) as unknown as {
      n: number;
      citizens: number;
      first_at: string | null;
      last_at: string | null;
      lat: number | null;
      lng: number | null;
      prank: number | null;
      weapon: boolean;
      injured: boolean;
      minor: boolean;
      false_alarm: boolean;
      max_trust: number | null;
      category: string | null;
    }[];

    const category = (inc.category ?? agg.category) as typeof inc.category;
    const result = incidentImportance({
      type: inc.type,
      category,
      maxPriority: agg.prank === null ? null : PRIORITY_BY_RANK[Number(agg.prank)],
      citizenCount: agg.citizens,
      recurrenceCount: inc.recurrenceCount,
      weapon: agg.weapon,
      injured: agg.injured,
      minor: agg.minor,
      possibleFalseAlarm: agg.false_alarm,
      maxTrust: agg.max_trust === null ? null : Number(agg.max_trust),
    });
    await tx
      .update(incident)
      .set({
        category,
        alertCount: agg.n,
        citizenCount: agg.citizens,
        ...(agg.n > 0 && agg.first_at && agg.last_at
          ? {
              lat: Number(agg.lat),
              lng: Number(agg.lng),
              firstAlertAt: new Date(agg.first_at),
              lastAlertAt: new Date(agg.last_at),
            }
          : {}),
        importance: result.score,
        importanceReasons: result.reasons,
        updatedAt: new Date(),
      })
      .where(eq(incident.id, incidentId));
  }
}

/**
 * Lo que la central ve de los incidentes de un conjunto de alertas: conteos, importancia y cuál
 * alerta lo representa en la cola (la abierta más antigua; si no queda ninguna abierta, la primera).
 */
export async function loadIncidentInfos(tx: Tx, ids: string[]): Promise<Map<string, IncidentInfo>> {
  const out = new Map<string, IncidentInfo>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  // SQL explícito: dentro de una subconsulta, la columna del incidente debe ir con su alias.
  const rows = (await tx.execute(sql`
    SELECT i.id, i.alert_count, i.citizen_count, i.recurrence_count, i.importance, i.importance_reasons,
           to_char(i.first_alert_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_at,
           to_char(i.last_alert_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_at,
           (SELECT m.id FROM alert m WHERE m.incident_id = i.id
             ORDER BY (m.status IN ${OPEN_SQL}) DESC, m.created_at, m.id LIMIT 1) AS primary_id,
           (SELECT count(*)::int FROM alert m WHERE m.incident_id = i.id AND m.status IN ${OPEN_SQL}) AS open_count
    FROM incident i
    WHERE i.id IN (${sql.join(
      unique.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`)) as unknown as {
    id: string;
    alert_count: number;
    citizen_count: number;
    recurrence_count: number;
    importance: number;
    importance_reasons: string[];
    first_at: string;
    last_at: string;
    primary_id: string | null;
    open_count: number;
  }[];
  for (const r of rows) {
    if (!r.primary_id) continue;
    out.set(r.id, {
      id: r.id,
      primaryAlertId: r.primary_id,
      alertCount: r.alert_count,
      openCount: Number(r.open_count),
      citizenCount: r.citizen_count,
      recurrenceCount: r.recurrence_count,
      importance: r.importance,
      level: importanceLevel(r.importance),
      reasons: r.importance_reasons as ImportanceReason[],
      firstAlertAt: r.first_at,
      lastAlertAt: r.last_at,
    });
  }
  return out;
}

/** Global: lo usan la creación de alertas, el worker IA y las acciones de la central. */
@Global()
@Module({ providers: [IncidentsService], exports: [IncidentsService] })
export class IncidentsModule {}
