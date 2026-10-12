import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  canTransitionAlert,
  canTransitionDispatch,
  type AlertDetail,
  type AlertEvent,
  type Dispatch,
  type DispatchAlert,
  type OpsAlertsQuery,
  type RejectAlert,
  type UpdateDispatch,
} from '@guardia/shared';
import { AlertReadService } from '../alerts/alert-read.service';
import { AppError } from '../common/app-error';
import { toAlertEvent, toDispatch, toUnit } from '../common/mappers';
import { DbService, type Tx } from '../db/db.service';
import { alert, citizen, dispatch, unit, type AlertRow } from '../db/schema';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { OperatorClaims } from '../auth/auth.guard';

const TRUST_PENALTY_FALSE_ALARM = 25;
const TRUST_REWARD_RESOLVED = 5;
const OPEN_DISPATCH: Dispatch['status'][] = ['ASSIGNED', 'EN_ROUTE', 'ON_SITE'];

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

/** Acciones de la central. Cada acción: transacción con RLS → evento → emisión WS/push. */
@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly reads: AlertReadService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  list(op: OperatorClaims, q: OpsAlertsQuery) {
    return this.dbs.asOperator(op.tenantId, op.sub, (tx) =>
      this.reads.list(tx, {
        statuses: q.status,
        type: q.type,
        since: q.since ? new Date(q.since) : undefined,
        limit: q.limit,
        cursor: q.cursor,
      }),
    );
  }

  detail(op: OperatorClaims, alertId: string): Promise<AlertDetail> {
    return this.dbs.asOperator(op.tenantId, op.sub, (tx) => this.reads.detail(tx, alertId));
  }

  private async loadForUpdate(tx: Tx, alertId: string): Promise<AlertRow> {
    const [row] = await tx
      .select()
      .from(alert)
      .where(eq(alert.id, alertId))
      .for('update')
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 'Alerta no encontrada');
    return row;
  }

  private assertTransition(row: AlertRow, to: AlertRow['status']) {
    if (!canTransitionAlert(row.status, to)) {
      throw new AppError('INVALID_TRANSITION', `No se puede pasar de ${row.status} a ${to}`);
    }
  }

  async acknowledge(op: OperatorClaims, alertId: string): Promise<AlertDetail> {
    const detail = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      this.assertTransition(row, 'ACKNOWLEDGED');
      await tx
        .update(alert)
        .set({ status: 'ACKNOWLEDGED', acknowledgedBy: op.sub })
        .where(eq(alert.id, alertId));
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'ACKNOWLEDGED',
      });
      return this.reads.detail(tx, alertId);
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    await this.notifyCitizen(detail, {
      title: 'Tu alerta fue recibida',
      body: 'Un operador de la central está revisando tu caso.',
    });
    return detail;
  }

  async reject(op: OperatorClaims, alertId: string, body: RejectAlert): Promise<AlertDetail> {
    const detail = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      this.assertTransition(row, 'REJECTED');
      await tx.update(alert).set({ status: 'REJECTED', resolvedAt: new Date() }).where(eq(alert.id, alertId));
      let trustDelta = 0;
      if (body.reason === 'FALSE_ALARM') {
        trustDelta = -TRUST_PENALTY_FALSE_ALARM;
        await tx
          .update(citizen)
          .set({ trustScore: sql`greatest(0, ${citizen.trustScore} - ${TRUST_PENALTY_FALSE_ALARM})` })
          .where(eq(citizen.id, row.citizenId));
      }
      await this.cancelOpenDispatches(tx, row, op, 'alerta rechazada');
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'REJECTED',
        payload: { reason: body.reason, notes: body.notes ?? null, trustDelta },
      });
      return this.reads.detail(tx, alertId);
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    await this.notifyCitizen(detail, {
      title: 'Tu alerta fue cerrada',
      body: 'La central cerró el caso sin despacho. Si sigues en peligro, llama al 133.',
    });
    return detail;
  }

  async dispatch(op: OperatorClaims, alertId: string, body: DispatchAlert): Promise<Dispatch> {
    const { d, detail } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      this.assertTransition(row, 'DISPATCHED');
      const [u] = await tx.select().from(unit).where(eq(unit.id, body.unitId)).for('update').limit(1);
      if (!u) throw new AppError('NOT_FOUND', 'Unidad no encontrada en este municipio');
      if (u.status !== 'AVAILABLE') throw new AppError('UNIT_UNAVAILABLE', `La unidad ${u.code} está ${u.status}`);
      const [open] = await tx
        .select({ id: dispatch.id, alertId: dispatch.alertId })
        .from(dispatch)
        .where(and(eq(dispatch.unitId, u.id), inArray(dispatch.status, OPEN_DISPATCH)))
        .limit(1);
      if (open) throw new AppError('UNIT_UNAVAILABLE', `La unidad ${u.code} ya tiene un despacho abierto (alerta ${open.alertId})`);

      let created: typeof dispatch.$inferSelect;
      try {
        [created] = await tx
          .insert(dispatch)
          .values({
            alertId,
            tenantId: op.tenantId,
            unitId: u.id,
            operatorId: op.sub,
            status: 'ASSIGNED',
            notes: body.notes ?? null,
          })
          .returning();
      } catch (e) {
        // Índice único parcial dispatch_unit_open_uidx: carrera perdida.
        if (isUniqueViolation(e)) throw new AppError('UNIT_UNAVAILABLE', `La unidad ${u.code} acaba de ser despachada`);
        throw e;
      }
      await tx.update(unit).set({ status: 'BUSY' }).where(eq(unit.id, u.id));
      await tx.update(alert).set({ status: 'DISPATCHED' }).where(eq(alert.id, alertId));
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'DISPATCHED',
        payload: { dispatchId: created.id, unitId: u.id, unitCode: u.code, notes: body.notes ?? null },
      });
      return { d: toDispatch(created, u.code), detail: await this.reads.detail(tx, alertId) };
    });
    this.realtime.dispatchUpdated(op.tenantId, d);
    this.realtime.alertUpdated(op.tenantId, detail);
    await this.emitUnit(op, d.unitId);
    await this.notifyCitizen(detail, {
      title: 'Unidad en camino',
      body: `La unidad ${d.unitCode} fue despachada a tu ubicación.`,
    });
    return d;
  }

  async updateDispatch(op: OperatorClaims, dispatchId: string, body: UpdateDispatch): Promise<Dispatch> {
    const { d, detail } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await tx.select().from(dispatch).where(eq(dispatch.id, dispatchId)).for('update').limit(1);
      if (!row) throw new AppError('NOT_FOUND', 'Despacho no encontrado');
      if (!canTransitionDispatch(row.status, body.status)) {
        throw new AppError('INVALID_TRANSITION', `No se puede pasar de ${row.status} a ${body.status}`);
      }
      const terminal = body.status === 'CLOSED' || body.status === 'CANCELLED';
      const [updated] = await tx
        .update(dispatch)
        .set({
          status: body.status,
          notes: body.notes ?? row.notes,
          closedAt: terminal ? new Date() : null,
        })
        .where(eq(dispatch.id, dispatchId))
        .returning();
      if (terminal) await tx.update(unit).set({ status: 'AVAILABLE' }).where(eq(unit.id, row.unitId));
      const [u] = await tx.select({ code: unit.code }).from(unit).where(eq(unit.id, row.unitId)).limit(1);

      // Si se canceló el último despacho abierto, la alerta vuelve a ACKNOWLEDGED para poder
      // despacharse de nuevo. Cualquier otro cambio toca updated_at para que `sync` lo vea.
      const alertRow = await this.loadForUpdate(tx, row.alertId);
      let revertedToAck = false;
      if (body.status === 'CANCELLED' && alertRow.status === 'DISPATCHED') {
        const [stillOpen] = await tx
          .select({ id: dispatch.id })
          .from(dispatch)
          .where(and(eq(dispatch.alertId, row.alertId), inArray(dispatch.status, OPEN_DISPATCH)))
          .limit(1);
        if (!stillOpen) {
          await tx.update(alert).set({ status: 'ACKNOWLEDGED' }).where(eq(alert.id, row.alertId));
          revertedToAck = true;
        }
      }
      if (!revertedToAck) await this.touch(tx, row.alertId);

      await this.events.record(tx, {
        alertId: row.alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'DISPATCH_STATUS',
        payload: { dispatchId, status: body.status, notes: body.notes ?? null, unitCode: u?.code, revertedToAck },
      });
      return { d: toDispatch(updated, u?.code ?? ''), detail: await this.reads.detail(tx, row.alertId) };
    });
    this.realtime.dispatchUpdated(op.tenantId, d);
    this.realtime.alertUpdated(op.tenantId, detail);
    await this.emitUnit(op, d.unitId);
    const text = STATUS_TEXT[d.status];
    if (text) await this.notifyCitizen(detail, { title: text.title, body: text.body.replace('{unit}', d.unitCode) });
    return d;
  }

  async resolve(op: OperatorClaims, alertId: string, notes?: string): Promise<AlertDetail> {
    const detail = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      this.assertTransition(row, 'RESOLVED');
      await tx.update(alert).set({ status: 'RESOLVED', resolvedAt: new Date() }).where(eq(alert.id, alertId));
      await this.closeOpenDispatches(tx, row, op);
      await tx
        .update(citizen)
        .set({ trustScore: sql`least(100, ${citizen.trustScore} + ${TRUST_REWARD_RESOLVED})` })
        .where(eq(citizen.id, row.citizenId));
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'RESOLVED',
        payload: { notes: notes ?? null, trustDelta: TRUST_REWARD_RESOLVED },
      });
      return this.reads.detail(tx, alertId);
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    await this.notifyCitizen(detail, { title: 'Caso resuelto', body: 'La central cerró tu alerta. Gracias por reportar.' });
    return detail;
  }

  async addNote(op: OperatorClaims, alertId: string, text: string): Promise<AlertEvent> {
    const { ev, detail } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await tx.select({ id: alert.id }).from(alert).where(eq(alert.id, alertId)).limit(1);
      if (!row) throw new AppError('NOT_FOUND', 'Alerta no encontrada');
      await this.touch(tx, alertId);
      const ev = await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'NOTE',
        payload: { text },
      });
      return { ev: toAlertEvent(ev), detail: await this.reads.detail(tx, alertId) };
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    return ev;
  }

  // ---------------------------------------------------------------- helpers

  /** Fuerza updated_at (el trigger lo fija al tocar cualquier columna) para que `sync` incluya la alerta. */
  private async touch(tx: Tx, alertId: string) {
    await tx.update(alert).set({ addressHint: sql`${alert.addressHint}` }).where(eq(alert.id, alertId));
  }

  private async cancelOpenDispatches(tx: Tx, row: AlertRow, op: OperatorClaims, reason: string) {
    const open = await tx
      .select()
      .from(dispatch)
      .where(and(eq(dispatch.alertId, row.id), inArray(dispatch.status, OPEN_DISPATCH)));
    for (const d of open) {
      await tx.update(dispatch).set({ status: 'CANCELLED', closedAt: new Date(), notes: reason }).where(eq(dispatch.id, d.id));
      await tx.update(unit).set({ status: 'AVAILABLE' }).where(eq(unit.id, d.unitId));
    }
  }

  private async closeOpenDispatches(tx: Tx, row: AlertRow, op: OperatorClaims) {
    const open = await tx
      .select()
      .from(dispatch)
      .where(and(eq(dispatch.alertId, row.id), inArray(dispatch.status, OPEN_DISPATCH)));
    for (const d of open) {
      await tx.update(dispatch).set({ status: 'CLOSED', closedAt: new Date() }).where(eq(dispatch.id, d.id));
      await tx.update(unit).set({ status: 'AVAILABLE' }).where(eq(unit.id, d.unitId));
    }
  }

  private async emitUnit(op: OperatorClaims, unitId: string) {
    const u = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await tx.select().from(unit).where(eq(unit.id, unitId)).limit(1);
      return row;
    });
    if (u) this.realtime.unitUpdated(op.tenantId, toUnit(u));
  }

  private async notifyCitizen(detail: AlertDetail, text: { title: string; body: string }) {
    try {
      const view = await this.dbs.asSystem((tx) => this.reads.citizenView(tx, detail.id));
      await this.notifications.notifyAlertStatus(detail.citizenId, detail.tenantId, view, text);
    } catch (e) {
      this.logger.warn(`No se pudo notificar al vecino de ${detail.id}: ${(e as Error).message}`);
    }
  }
}

const STATUS_TEXT: Partial<Record<Dispatch['status'], { title: string; body: string }>> = {
  EN_ROUTE: { title: 'Unidad en camino', body: 'La unidad {unit} va hacia tu ubicación.' },
  ON_SITE: { title: 'Unidad en el lugar', body: 'La unidad {unit} llegó a tu ubicación.' },
  CANCELLED: { title: 'Despacho cancelado', body: 'La central canceló el despacho de la unidad {unit}.' },
};
