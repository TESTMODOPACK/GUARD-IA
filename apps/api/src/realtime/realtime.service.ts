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
  type FieldAlarm,
  type Unit,
} from '@guardia/shared';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { AlertReadService } from '../alerts/alert-read.service';
import { DbService } from '../db/db.service';
import { shift } from '../db/schema';

/**
 * Única puerta de salida hacia los sockets. Los servicios de dominio llaman aquí
 * después de confirmar la transacción; nunca desde dentro de ella.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private ops?: Namespace;
  private citizenNs?: Namespace;
  private fieldNs?: Namespace;

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

  attachField(ns: Namespace) {
    this.fieldNs = ns;
  }

  /**
   * Avisos por área (0013): a quienes ven todo, al área del aviso y, si tiene carácter de seguridad, al área de los SOS.
   * Sin área (municipio sin áreas definidas) va a todo el municipio. Es el mismo criterio de la política
   * alert_operator_area: nadie recibe por aquí lo que la base no le dejaría leer.
   */
  private alertRooms(tenantId: string, a: { area: { id: string } | null; securityRelevant: boolean }): string[] {
    if (!a.area) return [wsRooms.tenant(tenantId)];
    return [
      wsRooms.alertsAll(tenantId),
      wsRooms.area(a.area.id),
      ...(a.securityRelevant ? [wsRooms.security(tenantId)] : []),
    ];
  }

  alertCreated(tenantId: string, alert: AlertSummary) {
    this.ops?.to(this.alertRooms(tenantId, alert)).emit('alert.created', alert);
  }

  alertUpdated(tenantId: string, alert: AlertDetail) {
    this.ops?.to(this.alertRooms(tenantId, alert)).emit('alert.updated', alert);
  }

  /**
   * El aviso cambió de área o perdió la marca de seguridad: quienes lo veían y ya no, lo sacan de su cola. Va antes de
   * `alertUpdated` con el estado nuevo.
   */
  alertMoved(
    tenantId: string,
    alertId: string,
    before: { areaId: string | null; securityRelevant: boolean },
    after: { area: { id: string; name: string } | null; securityRelevant: boolean },
  ) {
    if (!this.ops || !before.areaId) return;
    const prev = this.alertRooms(tenantId, { area: { id: before.areaId }, securityRelevant: before.securityRelevant });
    const next = this.alertRooms(tenantId, after);
    const lost = prev.filter((r) => !next.includes(r));
    if (lost.length === 0) return;
    this.ops.to(lost).except(next).emit('alert.removed', { alertId, areaName: after.area?.name ?? null });
  }

  /**
   * Cambió lo que ven (sus áreas, su rol, el modo compartido): los sockets se cierran y la central se reconecta sola,
   * relee /ops/me y entra a las rooms nuevas.
   */
  async reconnectOperators(tenantId: string, operatorIds?: string[]) {
    if (!this.ops) return;
    const sockets = await this.ops.in(wsRooms.tenant(tenantId)).fetchSockets();
    for (const s of sockets) {
      const sub = (s.data as { claims?: { sub: string } }).claims?.sub;
      if (!operatorIds || (sub && operatorIds.includes(sub))) s.disconnect(true);
    }
  }

  /** Cualquier cambio de un despacho llega a la central y avisa a quienes salieron con esa unidad. */
  dispatchUpdated(tenantId: string, d: Dispatch) {
    this.ops?.to(wsRooms.tenant(tenantId)).emit('dispatch.updated', d);
    this.fieldRefresh([d.unitId]);
  }

  /** Terreno (0012): la página /terreno de esas unidades vuelve a pedir su estado. */
  fieldRefresh(unitIds: Iterable<string>) {
    for (const id of new Set(unitIds)) this.fieldNs?.to(wsRooms.unit(id)).emit('field.refresh', { reason: 'dispatch' });
  }

  /** Aviso de terreno: banner en la central y, si es su pánico, respuesta al funcionario. */
  fieldAlarm(tenantId: string, alarm: FieldAlarm) {
    this.ops?.to(wsRooms.tenant(tenantId)).emit('field.alarm', alarm);
    if (alarm.operatorId) this.fieldNs?.to(wsRooms.operator(alarm.operatorId)).emit('field.alarm', alarm);
  }

  /** Al iniciar o terminar turno, los sockets del funcionario pasan a la room de su unidad (o salen de ella). */
  async moveFieldOperator(operatorId: string, unitId: string | null) {
    if (!this.fieldNs) return;
    const sockets = await this.fieldNs.in(wsRooms.operator(operatorId)).fetchSockets();
    for (const s of sockets) {
      for (const room of s.rooms) if (room.startsWith('unit:')) s.leave(room);
      if (unitId) s.join(wsRooms.unit(unitId));
      s.emit('field.refresh', { reason: 'shift' });
    }
  }

  /** Unidad del turno abierto de un funcionario (para unir su socket al conectarse). */
  async fieldUnitOf(tenantId: string, operatorId: string): Promise<string | null> {
    const [row] = await this.dbs.asField(tenantId, operatorId, (tx) =>
      tx
        .select({ unitId: shift.unitId })
        .from(shift)
        .where(and(eq(shift.operatorId, operatorId), isNotNull(shift.startedAt), isNull(shift.endedAt)))
        .limit(1),
    );
    return row?.unitId ?? null;
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
