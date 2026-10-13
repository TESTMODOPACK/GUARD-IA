import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AlertDetail, AlertStatus, AlertSummary, AlertType, CitizenAlert, RejectReason, TriageLabel } from '@guardia/shared';
import { AppError } from '../common/app-error';
import {
  toAlertDetail,
  toAlertEvent,
  toAlertSummary,
  toCitizenAlert,
  toDispatch,
} from '../common/mappers';
import type { Tx } from '../db/db.service';
import {
  alert,
  alertEvent,
  citizen,
  citizenStrike,
  dispatch,
  media,
  operator,
  tenant,
  triageLabel,
  unit,
  type AlertRow,
} from '../db/schema';
import { comunaName, geoContext } from '../geo/geo.queries';
import { loadIncidentInfos } from '../incidents/incidents.service';
import { MediaService } from '../media/media.service';

export interface ListFilters {
  /** Siempre explícito: bajo RLS es lo que deja usar los índices por municipio (C3). */
  tenantId: string;
  statuses?: AlertStatus[];
  type?: AlertType;
  since?: Date;
  limit: number;
  cursor?: string;
}

/** Faltas vigentes de un vecino (todo el país; RLS deja verlas si tiene alertas en este municipio). */
export async function activeStrikes(tx: Tx, citizenId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(citizenStrike)
    .where(and(eq(citizenStrike.citizenId, citizenId), isNull(citizenStrike.annulledAt), gt(citizenStrike.expiresAt, sql`now()`)));
  return r?.n ?? 0;
}

/** Orden de prioridad para la cola de la central: HIGH primero, luego antigüedad. */
const classifier = alias(operator, 'classifier');
const referrer = alias(operator, 'referrer');

/** Columna generada (0009) con el orden de la cola; tiene índice parcial con tenant_id primero. */
const PRIORITY_RANK = alert.priorityRank;

/**
 * Lecturas de alertas compartidas por la API de ciudadano, la central, el worker IA
 * y el gateway WS. Siempre reciben la transacción ya contextualizada (RLS).
 */
@Injectable()
export class AlertReadService {
  constructor(private readonly mediaSvc: MediaService) {}

  private async extras(tx: Tx, rows: AlertRow[]) {
    if (rows.length === 0) return new Map<string, { hasAudio: boolean; hasPhoto: boolean; trust: number | null }>();
    const ids = rows.map((r) => r.id);
    const mediaRows = await tx
      .select({ alertId: media.alertId, kind: media.kind })
      .from(media)
      .where(and(inArray(media.alertId, ids), isNull(media.deletedAt)));
    const citizenIds = [...new Set(rows.map((r) => r.citizenId))];
    const citizens = await tx
      .select({ id: citizen.id, trust: citizen.trustScore })
      .from(citizen)
      .where(inArray(citizen.id, citizenIds));
    const trustById = new Map(citizens.map((c) => [c.id, c.trust]));
    const map = new Map<string, { hasAudio: boolean; hasPhoto: boolean; trust: number | null }>();
    for (const r of rows) {
      map.set(r.id, { hasAudio: false, hasPhoto: false, trust: trustById.get(r.citizenId) ?? null });
    }
    for (const m of mediaRows) {
      const e = map.get(m.alertId)!;
      if (m.kind === 'AUDIO') e.hasAudio = true;
      if (m.kind === 'PHOTO') e.hasPhoto = true;
    }
    return map;
  }

  async summaries(tx: Tx, rows: AlertRow[]): Promise<AlertSummary[]> {
    const ex = await this.extras(tx, rows);
    const incidents = await loadIncidentInfos(
      tx,
      rows.map((r) => r.incidentId).filter((x): x is string => !!x),
    );
    return rows.map((r) => {
      const e = ex.get(r.id)!;
      return toAlertSummary(r, {
        hasAudio: e.hasAudio,
        hasPhoto: e.hasPhoto,
        citizenTrustScore: e.trust,
        incident: r.incidentId ? (incidents.get(r.incidentId) ?? null) : null,
      });
    });
  }

  async summary(tx: Tx, row: AlertRow): Promise<AlertSummary> {
    return (await this.summaries(tx, [row]))[0];
  }

  /**
   * Lista para la central, ordenada por prioridad y luego antigüedad.
   * El cursor codifica la tupla completa de orden `${rank}_${createdAt ISO}_${id}` para que
   * la página siguiente continúe exactamente donde terminó la anterior.
   */
  async list(tx: Tx, f: ListFilters): Promise<{ items: AlertSummary[]; nextCursor: string | null }> {
    const where: SQL[] = [eq(alert.tenantId, f.tenantId)];
    if (f.statuses?.length) where.push(inArray(alert.status, f.statuses));
    if (f.type) where.push(eq(alert.type, f.type));
    if (f.since) where.push(gt(alert.updatedAt, f.since));
    if (f.cursor) {
      // created_at viaja como texto de Postgres (microsegundos): un ISO de JS lo truncaría a ms
      // y la página siguiente repetiría la última fila.
      const [rankStr, ts, id] = f.cursor.split('_');
      const rank = Number(rankStr);
      if (Number.isInteger(rank) && ts && id && /^[0-9a-f-]{36}$/.test(id)) {
        where.push(
          sql`(${PRIORITY_RANK}, ${alert.createdAt}, ${alert.id}) > (${rank}::int, ${decodeURIComponent(ts)}::timestamptz, ${id}::uuid)`,
        );
      }
    }
    const rows = await tx
      .select({ row: alert, rank: PRIORITY_RANK, createdAtText: sql<string>`${alert.createdAt}::text` })
      .from(alert)
      .where(where.length ? and(...where) : undefined)
      .orderBy(PRIORITY_RANK, asc(alert.createdAt), asc(alert.id))
      .limit(f.limit + 1);
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      items: await this.summaries(tx, page.map((r) => r.row)),
      nextCursor:
        rows.length > f.limit && last ? `${last.rank}_${encodeURIComponent(last.createdAtText)}_${last.row.id}` : null,
    };
  }

  async detail(tx: Tx, alertId: string): Promise<AlertDetail> {
    const [row] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
    if (!row) throw new AppError('NOT_FOUND', 'Alerta no encontrada');
    const [c] = await tx
      .select({ phone: citizen.phone, name: citizen.name, trust: citizen.trustScore })
      .from(citizen)
      .where(eq(citizen.id, row.citizenId))
      .limit(1);
    const mediaRows = await tx.select().from(media).where(eq(media.alertId, row.id));
    const dispatchRows = await tx
      .select({ d: dispatch, unitCode: unit.code })
      .from(dispatch)
      .innerJoin(unit, eq(unit.id, dispatch.unitId))
      .where(eq(dispatch.alertId, row.id))
      .orderBy(desc(dispatch.createdAt));
    const eventRows = await tx
      .select()
      .from(alertEvent)
      .where(eq(alertEvent.alertId, row.id))
      .orderBy(asc(alertEvent.createdAt));
    const live = mediaRows.filter((m) => !m.deletedAt);
    const incidentInfo = row.incidentId ? ((await loadIncidentInfos(tx, [row.incidentId])).get(row.incidentId) ?? null) : null;
    return toAlertDetail(row, {
      triageLabel: await this.triageLabel(tx, row.id),
      geo: await geoContext(tx, row),
      hasAudio: live.some((m) => m.kind === 'AUDIO'),
      hasPhoto: live.some((m) => m.kind === 'PHOTO'),
      citizenTrustScore: c?.trust ?? null,
      incident: incidentInfo,
      citizenPhone: c?.phone ?? null,
      citizenName: c?.name ?? null,
      citizenStrikes: await activeStrikes(tx, row.citizenId),
      media: await this.mediaSvc.toPublic(mediaRows),
      dispatches: dispatchRows.map((d) => toDispatch(d.d, d.unitCode)),
      events: eventRows.map(toAlertEvent),
    });
  }

  /** Lo que la central confirmó o corrigió de la clasificación y a quién derivó (migración 0005). */
  private async triageLabel(tx: Tx, alertId: string): Promise<TriageLabel | null> {
    const [l] = await tx
      .select({ l: triageLabel, classifiedBy: classifier.name, referredBy: referrer.name })
      .from(triageLabel)
      .leftJoin(classifier, eq(classifier.id, triageLabel.classifiedBy))
      .leftJoin(referrer, eq(referrer.id, triageLabel.referredBy))
      .where(eq(triageLabel.alertId, alertId))
      .limit(1);
    if (!l) return null;
    return {
      category: l.l.category,
      subcategory: l.l.subcategory,
      agencies: l.l.agencies,
      classifiedBy: l.classifiedBy,
      classifiedAt: l.l.classifiedAt?.toISOString() ?? null,
      referredBy: l.referredBy,
      referredAt: l.l.referredAt?.toISOString() ?? null,
    };
  }

  /** Vista del vecino: estado + despacho activo + nombre del municipio. */
  async citizenView(tx: Tx, alertId: string): Promise<CitizenAlert> {
    const [row] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
    if (!row) throw new AppError('NOT_FOUND', 'Alerta no encontrada');
    return this.citizenViewFromRow(tx, row);
  }

  async citizenViewFromRow(tx: Tx, row: AlertRow): Promise<CitizenAlert> {
    let tenantName: string | null = null;
    if (row.tenantId) {
      const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, row.tenantId)).limit(1);
      tenantName = t?.name ?? null;
    }
    const [active] = await tx
      .select({ unitCode: unit.code, status: dispatch.status, updatedAt: dispatch.updatedAt })
      .from(dispatch)
      .innerJoin(unit, eq(unit.id, dispatch.unitId))
      .where(and(eq(dispatch.alertId, row.id), inArray(dispatch.status, ['ASSIGNED', 'EN_ROUTE', 'ON_SITE'])))
      .orderBy(desc(dispatch.createdAt))
      .limit(1);
    // Cerrada sin despacho: el motivo (y, si fue aviso falso, cuántas faltas tiene) para que la app lo explique.
    let closed: { reason: RejectReason; strikeCount: number | null } | null = null;
    if (row.status === 'REJECTED') {
      const [ev] = await tx
        .select({ payload: alertEvent.payload })
        .from(alertEvent)
        .where(and(eq(alertEvent.alertId, row.id), eq(alertEvent.kind, 'REJECTED')))
        .orderBy(desc(alertEvent.createdAt))
        .limit(1);
      const p = (ev?.payload ?? {}) as { reason?: RejectReason; strikeCount?: number };
      if (p.reason) closed = { reason: p.reason, strikeCount: p.strikeCount ?? null };
    }
    return toCitizenAlert(row, tenantName, active ?? null, await comunaName(tx, row.comunaCut), closed);
  }
}
