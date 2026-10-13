import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AuditKind, PlatformAction, PlatformAuditEntry, PlatformAuditPage, PlatformAuditQuery } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { auditLog, platformAuditLog } from '../db/schema';

export interface PlatformAuditInput {
  actorId: string | null;
  action: PlatformAction;
  tenantId?: string | null;
  comunaCut?: number | null;
  targetId?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown>;
  ip?: string | null;
}

/** "+56912345678" → "+569•••••678": la bitácora identifica el teléfono sin guardarlo entero. */
export function maskPhone(phone: string): string {
  return phone.length > 7 ? `${phone.slice(0, 4)}•••••${phone.slice(-3)}` : '•••';
}

/**
 * Bitácora de plataforma (solo inserción, RF-8.1) y, cuando la acción toca un municipio, también la del
 * municipio (RF-4.3), con el actor de plataforma: el municipio la ve como "Equipo Guard-IA". Siempre en la
 * MISMA transacción que el cambio. Nunca contraseñas, códigos, tokens ni datos de vecinos en el payload.
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly dbs: DbService) {}

  async record(tx: Tx, e: PlatformAuditInput): Promise<void> {
    await tx.insert(platformAuditLog).values({
      actorId: e.actorId,
      action: e.action,
      tenantId: e.tenantId ?? null,
      comunaCut: e.comunaCut ?? null,
      targetId: e.targetId ?? null,
      reason: e.reason ?? null,
      payload: e.payload ?? {},
      ip: e.ip ?? null,
    });
  }

  async recordInTenant(
    tx: Tx,
    e: { tenantId: string; platformActorId: string; kind: AuditKind; targetId?: string | null; payload?: Record<string, unknown> },
  ): Promise<void> {
    await tx.insert(auditLog).values({
      tenantId: e.tenantId,
      actorId: null,
      platformActorId: e.platformActorId,
      kind: e.kind,
      targetId: e.targetId ?? null,
      payload: e.payload ?? {},
    });
  }

  list(userId: string, q: PlatformAuditQuery): Promise<PlatformAuditPage> {
    let after: { at: string; id: string } | null = null;
    if (q.cursor) {
      const [at, id] = q.cursor.split('|');
      if (!at || !id || Number.isNaN(Date.parse(at))) throw new AppError('VALIDATION_ERROR', 'Cursor inválido');
      after = { at, id };
    }
    return this.dbs.asPlatform(userId, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT l.id, to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
               l.action, u.name AS actor_name, l.tenant_id, t.name AS tenant_name, l.comuna_cut, l.target_id,
               l.reason, l.payload, host(l.ip) AS ip
          FROM platform_audit_log l
          LEFT JOIN platform_user u ON u.id = l.actor_id
          LEFT JOIN tenant t ON t.id = l.tenant_id
         WHERE ${q.tenantId ? sql`l.tenant_id = ${q.tenantId}::uuid` : sql`true`}
           AND ${after ? sql`(l.created_at, l.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql`true`}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ${q.limit + 1}`)) as unknown as {
        id: string;
        created_at: string;
        action: PlatformAction;
        actor_name: string | null;
        tenant_id: string | null;
        tenant_name: string | null;
        comuna_cut: number | null;
        target_id: string | null;
        reason: string | null;
        payload: Record<string, unknown>;
        ip: string | null;
      }[];
      const page = rows.slice(0, q.limit);
      const items: PlatformAuditEntry[] = page.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        action: r.action,
        actorName: r.actor_name,
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        comunaCut: r.comuna_cut,
        targetId: r.target_id,
        reason: r.reason,
        payload: r.payload ?? {},
        ip: r.ip,
      }));
      const last = page[page.length - 1];
      return { items, nextCursor: rows.length > q.limit && last ? `${last.created_at}|${last.id}` : null };
    });
  }
}
