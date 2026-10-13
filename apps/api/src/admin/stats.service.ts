import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  AI_STATUSES,
  ALERT_STATUSES,
  UNIT_STATUSES,
  type ActivityPage,
  type ActivityQuery,
  type AdminOverview,
  type AdminRange,
  type CaseActivity,
  type SystemActivity,
} from '@guardia/shared';
import type { OperatorClaims } from '../auth/auth.guard';
import { DbService, type Tx } from '../db/db.service';
import { operator, tenant } from '../db/schema';
import { RealtimeService } from '../realtime/realtime.service';
import { openShiftOperatorIds } from './operators.service';

const RANGE_MS: Record<AdminRange, number> = { '24h': 24 * 3600_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

const zeros = <T extends string>(keys: readonly T[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v)));

/**
 * Panel del administrador: actividad del municipio en el período y bitácoras. Todo en contexto
 * operator, así que RLS limita cada consulta al tenant de quien mira (alertas fuera de cobertura,
 * sin tenant, no aparecen).
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly dbs: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  async overview(op: OperatorClaims, range: AdminRange): Promise<AdminOverview> {
    const to = new Date();
    const from = new Date(to.getTime() - RANGE_MS[range]);
    const bucket = range === '24h' ? 'hour' : 'day';
    // postgres-js no serializa Date dentro de sql``: texto ISO con cast explícito.
    const fromTs = sql`${from.toISOString()}::timestamptz`;
    // tenant_id explícito en cada consulta: bajo RLS es lo que permite usar los índices por municipio
    // (docs/revision-base-de-datos.md, C3). La RLS sigue siendo la frontera; esto es rendimiento.
    const T = sql`${op.tenantId}::uuid`;
    const online = await this.realtime.connectedOperatorIds(op.tenantId);

    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [t] = await tx.select({ tz: tenant.timezone }).from(tenant).where(eq(tenant.id, op.tenantId)).limit(1);
      const tz = t?.tz ?? 'America/Santiago';

      const open = await rows<{ status: string; n: number; oldest: string | null }>(
        tx,
        sql`SELECT status, count(*)::int AS n, min(created_at)::text AS oldest
            FROM alert WHERE tenant_id = ${T} AND status IN ('PENDING','ACKNOWLEDGED','DISPATCHED') GROUP BY status`,
      );
      const units = await rows<{ status: string; n: number }>(tx, sql`SELECT status, count(*)::int AS n FROM unit WHERE tenant_id = ${T} GROUP BY status`);
      const onShift = await openShiftOperatorIds(tx, op.tenantId);

      const byStatus = await rows<{ type: string; status: string; n: number }>(
        tx,
        sql`SELECT type, status, count(*)::int AS n FROM alert WHERE tenant_id = ${T} AND created_at >= ${fromTs} GROUP BY type, status`,
      );
      // Una barra por hora o día en la zona del municipio, incluidas las vacías.
      const series = await rows<{ bucket: string; sos: number; civic: number }>(
        tx,
        sql`WITH b AS (
              SELECT generate_series(
                date_trunc(${bucket}, ${fromTs} AT TIME ZONE ${tz}),
                date_trunc(${bucket}, now() AT TIME ZONE ${tz}),
                ('1 ' || ${bucket})::interval) AS local_bucket)
            SELECT to_char((b.local_bucket AT TIME ZONE ${tz}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
                   count(a.id) FILTER (WHERE a.type = 'EMERGENCY_SOS')::int AS sos,
                   count(a.id) FILTER (WHERE a.type = 'CIVIC_REPORT')::int AS civic
            FROM b
            LEFT JOIN alert a
              ON a.tenant_id = ${T} AND a.created_at >= ${fromTs} AND date_trunc(${bucket}, a.created_at AT TIME ZONE ${tz}) = b.local_bucket
            GROUP BY b.local_bucket ORDER BY b.local_bucket`,
      );
      const byCategory = await rows<{ category: string; n: number }>(
        tx,
        sql`SELECT category, count(*)::int AS n FROM alert
            WHERE tenant_id = ${T} AND created_at >= ${fromTs} AND category IS NOT NULL GROUP BY category ORDER BY n DESC`,
      );
      const response = await rows<{
        type: string;
        acknowledged: number;
        ack_p50: string | null;
        ack_p90: string | null;
        dispatch_p50: string | null;
        resolve_p50: string | null;
      }>(
        tx,
        sql`SELECT a.type,
                   count(ack.t)::int AS acknowledged,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ack.t - a.created_at)) AS ack_p50,
                   percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM ack.t - a.created_at)) AS ack_p90,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM dsp.t - a.created_at)) AS dispatch_p50,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.resolved_at - a.created_at))
                     FILTER (WHERE a.status = 'RESOLVED') AS resolve_p50
            FROM alert a
            LEFT JOIN LATERAL (SELECT min(e.created_at) AS t FROM alert_event e WHERE e.alert_id = a.id AND e.kind = 'ACKNOWLEDGED') ack ON true
            LEFT JOIN LATERAL (SELECT min(e.created_at) AS t FROM alert_event e WHERE e.alert_id = a.id AND e.kind = 'DISPATCHED') dsp ON true
            WHERE a.tenant_id = ${T} AND a.created_at >= ${fromTs}
            GROUP BY a.type`,
      );
      const rejections = await rows<{ reason: string; n: number }>(
        tx,
        sql`SELECT payload->>'reason' AS reason, count(*)::int AS n FROM alert_event
            WHERE tenant_id = ${T} AND kind = 'REJECTED' AND created_at >= ${fromTs} GROUP BY 1 ORDER BY n DESC`,
      );
      const ai = await rows<{ ai_status: string; n: number }>(
        tx,
        sql`SELECT ai_status, count(*)::int AS n FROM alert WHERE tenant_id = ${T} AND created_at >= ${fromTs} GROUP BY ai_status`,
      );
      const work = await rows<{ actor_id: string; kind: string; n: number }>(
        tx,
        sql`SELECT actor_id, kind, count(*)::int AS n FROM alert_event
            WHERE tenant_id = ${T} AND actor_type = 'OPERATOR' AND created_at >= ${fromTs} AND actor_id IS NOT NULL
            GROUP BY actor_id, kind`,
      );
      const ops = await tx
        .select()
        .from(operator)
        .where(and(eq(operator.tenantId, op.tenantId), eq(operator.active, true)))
        .orderBy(asc(operator.name));

      const statusCounts = zeros(ALERT_STATUSES);
      let sos = 0;
      let civic = 0;
      for (const r of byStatus) {
        statusCounts[r.status as keyof typeof statusCounts] += r.n;
        if (r.type === 'EMERGENCY_SOS') sos += r.n;
        else civic += r.n;
      }
      const openBy = { PENDING: 0, ACKNOWLEDGED: 0, DISPATCHED: 0 };
      let oldestPending: string | null = null;
      for (const r of open) {
        openBy[r.status as keyof typeof openBy] = r.n;
        if (r.status === 'PENDING') oldestPending = r.oldest;
      }
      const unitCounts = zeros(UNIT_STATUSES);
      for (const r of units) unitCounts[r.status as keyof typeof unitCounts] = r.n;
      const aiCounts = zeros(AI_STATUSES);
      for (const r of ai) aiCounts[r.ai_status as keyof typeof aiCounts] = r.n;

      const KIND_TO_FIELD = { ACKNOWLEDGED: 'acks', DISPATCHED: 'dispatches', RESOLVED: 'resolves', REJECTED: 'rejects', NOTE: 'notes' } as const;
      const perOp = new Map<string, { acks: number; dispatches: number; resolves: number; rejects: number; notes: number }>();
      for (const r of work) {
        const field = KIND_TO_FIELD[r.kind as keyof typeof KIND_TO_FIELD];
        if (!field) continue;
        const acc = perOp.get(r.actor_id) ?? { acks: 0, dispatches: 0, resolves: 0, rejects: 0, notes: 0 };
        acc[field] += r.n;
        perOp.set(r.actor_id, acc);
      }

      return {
        range,
        from: from.toISOString(),
        to: to.toISOString(),
        bucket,
        now: {
          open: openBy,
          oldestPendingSeconds: oldestPending ? Math.max(0, Math.round((Date.now() - Date.parse(oldestPending)) / 1000)) : null,
          units: unitCounts,
          operatorsOnline: ops.filter((o) => online.has(o.id)).length,
          operatorsOnShift: onShift.size,
        },
        totals: { sos, civic, byStatus: statusCounts },
        series: series.map((s) => ({ bucket: s.bucket, sos: s.sos, civic: s.civic })),
        byCategory: byCategory.map((c) => ({ category: c.category as AdminOverview['byCategory'][number]['category'], count: c.n })),
        response: response.map((r) => ({
          type: r.type as AdminOverview['response'][number]['type'],
          acknowledged: r.acknowledged,
          ackP50: num(r.ack_p50),
          ackP90: num(r.ack_p90),
          dispatchP50: num(r.dispatch_p50),
          resolveP50: num(r.resolve_p50),
        })),
        rejections: rejections
          .filter((r) => r.reason)
          .map((r) => ({ reason: r.reason as AdminOverview['rejections'][number]['reason'], count: r.n })),
        ai: aiCounts,
        operators: ops.map((o) => ({
          id: o.id,
          name: o.name,
          role: o.role,
          online: online.has(o.id),
          onShift: onShift.has(o.id),
          lastLoginAt: o.lastLoginAt?.toISOString() ?? null,
          ...(perOp.get(o.id) ?? { acks: 0, dispatches: 0, resolves: 0, rejects: 0, notes: 0 }),
        })),
      };
    });
  }

  /** Bitácora paginada, más reciente primero. Cursor `${created_at texto}_${id}` (microsegundos exactos). */
  async activity(op: OperatorClaims, q: ActivityQuery): Promise<ActivityPage<CaseActivity> | ActivityPage<SystemActivity>> {
    const after = parseCursor(q.cursor);
    const T = sql`${op.tenantId}::uuid`;
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      if (q.source === 'system') {
        const list = await rows<{
          id: string;
          created_at: string;
          kind: SystemActivity['kind'];
          actor_name: string | null;
          target_id: string | null;
          payload: Record<string, unknown>;
        }>(
          tx,
          // Acciones de la consola de plataforma (0010): el municipio no lee platform_user; ve "Equipo Guard-IA".
          sql`SELECT l.id, l.created_at::text AS created_at, l.kind,
                     COALESCE(o.name, CASE WHEN l.platform_actor_id IS NOT NULL THEN 'Equipo Guard-IA' END) AS actor_name,
                     l.target_id, l.payload
              FROM audit_log l LEFT JOIN operator o ON o.id = l.actor_id
              WHERE l.tenant_id = ${T}
              ${after ? sql`AND (l.created_at, l.id) < (${after.ts}::timestamptz, ${after.id}::uuid)` : sql``}
              ORDER BY l.created_at DESC, l.id DESC LIMIT ${q.limit + 1}`,
        );
        return page(list, q.limit, (r) => ({
          id: r.id,
          createdAt: new Date(r.created_at).toISOString(),
          kind: r.kind,
          actorName: r.actor_name,
          targetId: r.target_id,
          payload: r.payload ?? {},
        }));
      }
      const list = await rows<{
        id: string;
        created_at: string;
        kind: CaseActivity['kind'];
        actor_type: CaseActivity['actorType'];
        actor_name: string | null;
        alert_id: string;
        alert_type: CaseActivity['alertType'];
        category: CaseActivity['category'];
        payload: Record<string, unknown>;
      }>(
        tx,
        sql`SELECT e.id, e.created_at::text AS created_at, e.kind, e.actor_type,
                   CASE WHEN e.actor_type = 'OPERATOR' THEN o.name END AS actor_name,
                   e.alert_id, a.type AS alert_type, a.category, e.payload
            FROM alert_event e
            JOIN alert a ON a.id = e.alert_id
            LEFT JOIN operator o ON o.id = e.actor_id
            WHERE e.tenant_id = ${T}
            ${after ? sql`AND (e.created_at, e.id) < (${after.ts}::timestamptz, ${after.id}::uuid)` : sql``}
            ORDER BY e.created_at DESC, e.id DESC LIMIT ${q.limit + 1}`,
      );
      return page(list, q.limit, (r) => ({
        id: r.id,
        createdAt: new Date(r.created_at).toISOString(),
        kind: r.kind,
        actorType: r.actor_type,
        actorName: r.actor_name,
        alertId: r.alert_id,
        alertType: r.alert_type,
        category: r.category,
        payload: r.payload ?? {},
      }));
    });
  }
}

async function rows<T>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(q)) as unknown as T[];
}

function parseCursor(c?: string): { ts: string; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf('_');
  const ts = decodeURIComponent(c.slice(0, i));
  const id = c.slice(i + 1);
  if (!ts || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(ts))) return null;
  return { ts, id };
}

function page<R extends { id: string; created_at: string }, T>(list: R[], limit: number, map: (r: R) => T): ActivityPage<T> {
  const items = list.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(map),
    nextCursor: list.length > limit && last ? `${encodeURIComponent(last.created_at)}_${last.id}` : null,
  };
}
