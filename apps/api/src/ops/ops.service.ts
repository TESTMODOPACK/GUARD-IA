import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import {
  canTransitionAlert,
  canTransitionDispatch,
  categoriesFor,
  rejectNotice,
  STRIKE_WINDOW_DAYS,
  TERMINAL_OUTCOMES,
  type AlertDetail,
  type AlertEvent,
  type Dispatch,
  type DispatchAlert,
  type OpsAlertsQuery,
  type CitizenStanding,
  type ReclassifyAlert,
  type RecordOutcome,
  type ReferAlert,
  type RejectReason,
  type RejectAlert,
  type UpdateDispatch,
} from '@guardia/shared';
import { AlertReadService, activeStrikes } from '../alerts/alert-read.service';
import { AlertsService } from '../alerts/alerts.service';
import { AppError } from '../common/app-error';
import { toAlertEvent, toDispatch, toUnit } from '../common/mappers';
import { DbService, type Tx } from '../db/db.service';
import { alert, alertEvent, citizen, citizenStrike, dispatch, triageLabel, unit, type AlertRow } from '../db/schema';
import { EventsService } from '../events/events.service';
import { IncidentsService, loadIncidentInfos } from '../incidents/incidents.service';
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
    private readonly incidents: IncidentsService,
    private readonly alertsSvc: AlertsService,
  ) {}

  list(op: OperatorClaims, q: OpsAlertsQuery) {
    return this.dbs.asOperator(op.tenantId, op.sub, (tx) =>
      this.reads.list(tx, {
        tenantId: op.tenantId,
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
    let strikes: number | null = null;
    let detail = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      this.assertTransition(row, 'REJECTED');
      await tx.update(alert).set({ status: 'REJECTED', resolvedAt: new Date() }).where(eq(alert.id, alertId));
      let trustDelta = 0;
      let strikeCount: number | null = null;
      // Solo el engaño intencional es falta del vecino (docs/plan-plataforma.md §5b): baja la confianza y
      // queda registrada con la evidencia, por 90 días. Accidental, mal reportado o duplicado no sancionan.
      if (body.reason === 'FALSE_ALARM') {
        if ((body.notes?.trim().length ?? 0) < 10) {
          throw new AppError('VALIDATION_ERROR', 'Describe la evidencia del aviso falso (mínimo 10 caracteres)');
        }
        trustDelta = -TRUST_PENALTY_FALSE_ALARM;
        await tx
          .update(citizen)
          .set({ trustScore: sql`greatest(0, ${citizen.trustScore} - ${TRUST_PENALTY_FALSE_ALARM})` })
          .where(eq(citizen.id, row.citizenId));
        await tx
          .insert(citizenStrike)
          .values({
            citizenId: row.citizenId,
            tenantId: op.tenantId,
            alertId,
            note: body.notes!,
            decidedBy: op.sub,
            expiresAt: new Date(Date.now() + STRIKE_WINDOW_DAYS * 86_400_000),
          })
          .onConflictDoNothing({ target: citizenStrike.alertId });
        strikeCount = await activeStrikes(tx, row.citizenId);
      }
      await this.cancelOpenDispatches(tx, row, op, 'alerta rechazada');
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'REJECTED',
        payload: { reason: body.reason, notes: body.notes ?? null, trustDelta, strikeCount },
      });
      return { detail: await this.reads.detail(tx, alertId), strikeCount };
    }).then((r) => {
      strikes = r.strikeCount;
      return r.detail;
    });
    // Una alerta rechazada deja de confirmar su grupo: se recalcula y se emite con el grupo al día.
    if (detail.incident) {
      await this.incidents.attach(alertId).catch((e: Error) => this.logger.warn(`incidente de ${alertId}: ${e.message}`));
      detail = await this.dbs.asOperator(op.tenantId, op.sub, (tx) => this.reads.detail(tx, alertId));
    }
    this.realtime.alertUpdated(op.tenantId, detail);
    const notice = rejectNotice(body.reason, strikes);
    await this.notifyCitizen(detail, { title: notice.title, body: notice.body });
    return detail;
  }

  /**
   * Lo que ve el operador antes de rechazar: faltas vigentes del vecino en todo el país (con el municipio
   * que las puso) y los rechazos recientes en este municipio (p. ej. una "prueba" que se repite).
   */
  citizenStanding(op: OperatorClaims, alertId: string): Promise<CitizenStanding> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await tx.select({ citizenId: alert.citizenId }).from(alert).where(eq(alert.id, alertId)).limit(1);
      if (!row) throw new AppError('NOT_FOUND', 'Alerta no encontrada');
      // El nombre del otro municipio sale del directorio (0009): la RLS de tenant solo muestra el propio.
      const byTenant = (await tx.execute(sql`
        SELECT d.name AS "tenantName", count(*)::int AS count
          FROM citizen_strike s
          JOIN tenant_directory d ON d.id = s.tenant_id
         WHERE s.citizen_id = ${row.citizenId}::uuid AND s.annulled_at IS NULL AND s.expires_at > now()
         GROUP BY d.name`)) as unknown as { tenantName: string; count: number }[];
      const rejections = await tx
        .select({ payload: alertEvent.payload, at: alertEvent.createdAt })
        .from(alertEvent)
        .innerJoin(alert, eq(alert.id, alertEvent.alertId))
        .where(
          and(
            eq(alert.citizenId, row.citizenId),
            eq(alertEvent.kind, 'REJECTED'),
            gt(alertEvent.createdAt, sql`now() - make_interval(days => ${STRIKE_WINDOW_DAYS})`),
          ),
        )
        .orderBy(desc(alertEvent.createdAt))
        .limit(10);
      return {
        activeStrikes: byTenant.reduce((n, t) => n + t.count, 0),
        strikesByTenant: byTenant,
        recentRejections: rejections
          .map((r) => ({ reason: (r.payload as { reason?: RejectReason }).reason, at: r.at.toISOString() }))
          .filter((r): r is { reason: RejectReason; at: string } => !!r.reason),
      };
    });
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

  /**
   * Resolver. Con `includeGrouped`, también se resuelven las demás alertas abiertas del mismo
   * incidente (el mismo bache reportado por cinco vecinos se cierra una vez) y cada vecino recibe
   * su aviso. Todo en una transacción: o se cierran todas o ninguna.
   */
  async resolve(op: OperatorClaims, alertId: string, notes?: string, includeGrouped = false): Promise<AlertDetail> {
    const { detail, grouped } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      this.assertTransition(row, 'RESOLVED');
      await this.resolveRow(tx, row, op, { notes: notes ?? null, trustDelta: TRUST_REWARD_RESOLVED });
      const grouped: string[] = [];
      if (includeGrouped && row.incidentId) {
        const others = await tx
          .select()
          .from(alert)
          .where(and(eq(alert.incidentId, row.incidentId), ne(alert.id, row.id), inArray(alert.status, ['PENDING', 'ACKNOWLEDGED', 'DISPATCHED'])))
          // Siempre en el mismo orden: dos operadores cerrando el mismo grupo no se bloquean mutuamente (M7).
          .orderBy(asc(alert.id))
          .for('update');
        for (const m of others) {
          await this.resolveRow(tx, m, op, { notes: notes ?? null, trustDelta: TRUST_REWARD_RESOLVED, viaAlertId: row.id });
          grouped.push(m.id);
        }
      }
      return { detail: await this.reads.detail(tx, alertId), grouped };
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    await this.notifyCitizen(detail, { title: 'Caso resuelto', body: 'La central cerró tu alerta. Gracias por reportar.' });
    for (const id of grouped) {
      const d = await this.dbs.asOperator(op.tenantId, op.sub, (tx) => this.reads.detail(tx, id));
      this.realtime.alertUpdated(op.tenantId, d);
      await this.notifyCitizen(d, {
        title: 'Caso resuelto',
        body: 'La central resolvió el problema que reportaste (también lo reportaron otros vecinos). Gracias.',
      });
    }
    return detail;
  }

  private async resolveRow(tx: Tx, row: AlertRow, op: OperatorClaims, payload: Record<string, unknown>) {
    await tx.update(alert).set({ status: 'RESOLVED', resolvedAt: new Date() }).where(eq(alert.id, row.id));
    await this.closeOpenDispatches(tx, row, op);
    await tx
      .update(citizen)
      .set({ trustScore: sql`least(100, ${citizen.trustScore} + ${TRUST_REWARD_RESOLVED})` })
      .where(eq(citizen.id, row.citizenId));
    await this.events.record(tx, {
      alertId: row.id,
      tenantId: op.tenantId,
      actorType: 'OPERATOR',
      actorId: op.sub,
      kind: 'RESOLVED',
      payload,
    });
  }

  /**
   * Volver a analizar con IA (transcribir y clasificar de nuevo): para una alerta que llegó con la
   * IA en modo de prueba o caída. Se borra la transcripción anterior y se encola un job nuevo (id
   * propio: el del primer análisis ya existe en la cola y BullMQ lo ignoraría).
   */
  async reanalyze(op: OperatorClaims, alertId: string): Promise<AlertDetail> {
    const detail = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      if (row.aiStatus === 'PROCESSING') throw new AppError('CONFLICT', 'La IA ya está analizando esta alerta');
      if (['CANCELLED', 'UNROUTED'].includes(row.status)) throw new AppError('CONFLICT', 'Esta alerta no se analiza');
      await tx.update(alert).set({ aiStatus: 'QUEUED', aiError: null, transcription: null }).where(eq(alert.id, alertId));
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'NOTE',
        payload: { text: 'Se pidió volver a analizar con IA (transcripción y clasificación).' },
      });
      return this.reads.detail(tx, alertId);
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    const queued = await this.alertsSvc.enqueue(alertId, `alert-${alertId}-r${Date.now()}`);
    if (!queued) throw new AppError('INTERNAL', 'No se pudo encolar el análisis; intenta de nuevo en un momento');
    return detail;
  }

  /**
   * "Separar del grupo": la alerta no es la misma situación que su incidente. Queda sola y el grupo
   * anterior se recalcula. Se registra como nota en la línea de tiempo.
   */
  async detach(op: OperatorClaims, alertId: string): Promise<AlertDetail> {
    const { detail, previousPrimary } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      if (!row.incidentId) throw new AppError('CONFLICT', 'La alerta no está agrupada con otras');
      const previous = row.incidentId;
      await this.incidents.detachInTx(tx, row);
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'NOTE',
        payload: { text: 'Separada de su grupo: es otra situación.', detachedFrom: previous },
      });
      const prev = (await loadIncidentInfos(tx, [previous])).get(previous);
      return { detail: await this.reads.detail(tx, alertId), previousPrimary: prev?.primaryAlertId ?? null };
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    // El grupo del que salió cambió de tamaño: la central actualiza su tarjeta.
    if (previousPrimary && previousPrimary !== alertId) {
      const d = await this.dbs.asOperator(op.tenantId, op.sub, (tx) => this.reads.detail(tx, previousPrimary));
      this.realtime.alertUpdated(op.tenantId, d);
    }
    return detail;
  }

  /**
   * "Corregir clasificación": el operador confirma o cambia la categoría (p. ej. llamó al vecino de
   * un SOS por botón). Pasa a ser la clasificación de la alerta, la IA ya no la pisa, y queda como
   * etiqueta para medir al agente junto con lo que la IA proponía en ese momento.
   */
  async reclassify(op: OperatorClaims, alertId: string, body: ReclassifyAlert): Promise<AlertDetail> {
    const detail = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      if (!categoriesFor(row.type).includes(body.category)) {
        throw new AppError('VALIDATION_ERROR', 'La categoría no corresponde al tipo de alerta');
      }
      const subcategory = body.subcategory ?? null;
      const now = new Date();
      await tx.update(alert).set({ category: body.category, subcategory }).where(eq(alert.id, alertId));
      await this.upsertLabel(tx, row, op, { category: body.category, subcategory, classifiedBy: op.sub, classifiedAt: now });
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'RECLASSIFIED',
        payload: {
          from: row.category,
          fromSubcategory: row.subcategory,
          to: body.category,
          toSubcategory: subcategory,
          confirmed: row.category === body.category && (row.subcategory ?? null) === subcategory,
        },
      });
      return this.reads.detail(tx, alertId);
    });
    return this.afterTriageChange(op, alertId, detail);
  }

  /** "Derivado a…": instituciones a las que la central derivó el caso (reemplaza la lista anterior). */
  async refer(op: OperatorClaims, alertId: string, body: ReferAlert): Promise<AlertDetail> {
    const detail = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const row = await this.loadForUpdate(tx, alertId);
      await this.upsertLabel(tx, row, op, { agencies: body.agencies, referredBy: op.sub, referredAt: new Date() });
      await this.touch(tx, alertId);
      await this.events.record(tx, {
        alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'REFERRED',
        payload: { agencies: body.agencies, notes: body.notes ?? null },
      });
      return this.reads.detail(tx, alertId);
    });
    this.realtime.alertUpdated(op.tenantId, detail);
    return detail;
  }

  /**
   * Resultado en terreno (migración 0008), registrado por la central con lo que informa la unidad.
   * Los terminales (atendido, derivado, no se encontró nada, falsa alarma confirmada) cierran el despacho y
   * liberan la unidad; "pide apoyo" y "era otra situación" lo dejan abierto. "Era otra situación" aplica la
   * categoría que vio la unidad (manda sobre la IA y queda como clasificación de terreno). La alerta la
   * cierra el operador (resolver o, si la unidad confirmó un engaño, rechazar como aviso falso).
   */
  async recordOutcome(op: OperatorClaims, dispatchId: string, body: RecordOutcome): Promise<Dispatch> {
    const { d, detail, reclassified, closed } = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await tx.select().from(dispatch).where(eq(dispatch.id, dispatchId)).for('update').limit(1);
      if (!row) throw new AppError('NOT_FOUND', 'Despacho no encontrado');
      if (row.status === 'CANCELLED') throw new AppError('CONFLICT', 'El despacho fue cancelado');
      const alertRow = await this.loadForUpdate(tx, row.alertId);
      if (body.category && !categoriesFor(alertRow.type).includes(body.category)) {
        throw new AppError('VALIDATION_ERROR', 'La categoría no corresponde al tipo de alerta');
      }
      const close = TERMINAL_OUTCOMES.includes(body.outcome) && OPEN_DISPATCH.includes(row.status);
      const now = new Date();
      const [updated] = await tx
        .update(dispatch)
        .set({
          outcome: body.outcome,
          outcomeNote: body.notes ?? null,
          outcomeAt: now,
          outcomeBy: op.sub,
          ...(close ? { status: 'CLOSED' as const, closedAt: now } : {}),
        })
        .where(eq(dispatch.id, dispatchId))
        .returning();
      if (close) await tx.update(unit).set({ status: 'AVAILABLE' }).where(eq(unit.id, row.unitId));
      const [u] = await tx.select({ code: unit.code }).from(unit).where(eq(unit.id, row.unitId)).limit(1);

      const reclassified = body.outcome === 'DIFFERENT_SITUATION' && !!body.category;
      if (reclassified) {
        const subcategory = body.subcategory ?? null;
        await tx.update(alert).set({ category: body.category, subcategory }).where(eq(alert.id, row.alertId));
        await this.upsertLabel(tx, alertRow, op, {
          category: body.category,
          subcategory,
          classifiedBy: op.sub,
          classifiedAt: now,
          fieldCategory: body.category,
          fieldSubcategory: subcategory,
        });
      } else {
        await this.touch(tx, row.alertId);
      }
      await this.events.record(tx, {
        alertId: row.alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'FIELD_REPORT',
        payload: {
          dispatchId,
          unitCode: u?.code,
          outcome: body.outcome,
          notes: body.notes ?? null,
          category: body.category ?? null,
          subcategory: body.subcategory ?? null,
          closedDispatch: close,
        },
      });
      return {
        d: toDispatch(updated, u?.code ?? ''),
        detail: await this.reads.detail(tx, row.alertId),
        reclassified,
        closed: close,
      };
    });
    this.realtime.dispatchUpdated(op.tenantId, d);
    if (reclassified) await this.afterTriageChange(op, d.alertId, detail);
    else this.realtime.alertUpdated(op.tenantId, detail);
    if (closed) await this.emitUnit(op, d.unitId);
    return d;
  }

  /** Una fila por alerta; cada escritura guarda también lo que la IA proponía en ese momento. */
  private async upsertLabel(
    tx: Tx,
    row: AlertRow,
    op: OperatorClaims,
    set: Partial<typeof triageLabel.$inferInsert>,
  ) {
    const t = row.aiTriage;
    const snapshot = {
      aiCategory: t?.category ?? null,
      aiSubcategory: t?.subcategory ?? null,
      aiAgencies: t?.agencies.map((a) => a.agency) ?? [],
      aiVersion: t?.version ?? null,
    };
    await tx
      .insert(triageLabel)
      .values({ tenantId: op.tenantId, alertId: row.id, ...snapshot, ...set })
      .onConflictDoUpdate({ target: triageLabel.alertId, set: { ...snapshot, ...set, updatedAt: new Date() } });
  }

  /** La categoría cambia el grupo (clasificación de la situación, importancia de un reporte urbano). */
  private async afterTriageChange(op: OperatorClaims, alertId: string, detail: AlertDetail): Promise<AlertDetail> {
    if (detail.incident) {
      await this.incidents.attach(alertId).catch((e: Error) => this.logger.warn(`incidente de ${alertId}: ${e.message}`));
      detail = await this.dbs.asOperator(op.tenantId, op.sub, (tx) => this.reads.detail(tx, alertId));
    }
    this.realtime.alertUpdated(op.tenantId, detail);
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
