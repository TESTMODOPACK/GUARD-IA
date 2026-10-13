import { Injectable, Logger } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import {
  wsRooms,
  type AccountLevel,
  type AlertDetail,
  type AlertSummary,
  type AlertTransferred,
  type CitizenAlert,
  type Dispatch,
  type Unit,
} from '@guardia/shared';
import { AlertReadService } from '../alerts/alert-read.service';
import { DbService } from '../db/db.service';

/**
 * Única puerta de salida hacia los sockets. Los servicios de dominio llaman aquí
 * después de confirmar la transacción; nunca desde dentro de ella.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private ops?: Namespace;
  private citizenNs?: Namespace;

  constructor(
    private readonly dbs: DbService,
    private readonly reads: AlertReadService,
  ) {}

  attachOps(ns: Namespace) {
    this.ops = ns;
  }

  attachCitizen(ns: Namespace) {
    this.citizenNs = ns;
  }

  alertCreated(tenantId: string, alert: AlertSummary) {
    this.ops?.to(wsRooms.tenant(tenantId)).emit('alert.created', alert);
  }

  alertUpdated(tenantId: string, alert: AlertDetail) {
    this.ops?.to(wsRooms.tenant(tenantId)).emit('alert.updated', alert);
  }

  dispatchUpdated(tenantId: string, d: Dispatch) {
    this.ops?.to(wsRooms.tenant(tenantId)).emit('dispatch.updated', d);
  }

  unitUpdated(tenantId: string, u: Unit) {
    this.ops?.to(wsRooms.tenant(tenantId)).emit('unit.updated', u);
  }

  /** La alerta pasó a otro municipio: la central de origen la saca de su cola. */
  alertTransferred(fromTenantId: string, payload: AlertTransferred) {
    this.ops?.to(wsRooms.tenant(fromTenantId)).emit('alert.transferred', payload);
  }

  citizenAlertStatus(citizenId: string, payload: CitizenAlert) {
    this.citizenNs?.to(wsRooms.citizen(citizenId)).emit('alert.status', payload);
  }

  /** La cuenta del vecino cambió (bloqueo, falta anulada, revisión; 0011): la app relee GET /me. */
  citizenAccountUpdated(citizenId: string, payload: { level: AccountLevel }) {
    this.citizenNs?.to(wsRooms.citizen(citizenId)).emit('account.updated', payload);
  }

  /** Sync al reconectar: alertas tocadas desde `since` (máximo 200). */
  async buildSync(tenantId: string, operatorId: string, since: string) {
    const d = new Date(since);
    const safeSince = Number.isNaN(d.getTime()) ? new Date(Date.now() - 3600_000) : d;
    const { items } = await this.dbs.asOperator(tenantId, operatorId, (tx) =>
      this.reads.list(tx, { tenantId, since: safeSince, limit: 200 }),
    );
    return { since: safeSince.toISOString(), alerts: items };
  }

  /** Operadores con la central abierta ahora (panel del administrador). */
  async connectedOperatorIds(tenantId: string): Promise<Set<string>> {
    if (!this.ops) return new Set();
    const sockets = await this.ops.in(wsRooms.tenant(tenantId)).fetchSockets();
    return new Set(sockets.map((s) => (s.data as { claims?: { sub: string } }).claims?.sub).filter((x): x is string => !!x));
  }

  /** Número de operadores conectados por tenant (para /health y métricas). */
  async connectedOperators(tenantId: string): Promise<number> {
    if (!this.ops) return 0;
    const sockets = await this.ops.in(wsRooms.tenant(tenantId)).fetchSockets();
    return sockets.length;
  }
}
