import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  canTransitionDispatch,
  categoriesFor,
  TERMINAL_OUTCOMES,
  type DispatchStatus,
  type FieldAlarm,
  type FieldDispatch,
  type FieldLocation,
  type FieldReport,
  type FieldState,
  type FieldStatus,
  type Panic,
  type StartFieldShift,
} from '@guardia/shared';
import { EARLY_START_MS } from '../admin/shifts.service';
import { isUniqueViolation } from '../admin/operators.service';
import { AlertReadService } from '../alerts/alert-read.service';
import { AuditService } from '../auth/audit.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { toDispatch, toUnit } from '../common/mappers';
import { DbService, type Tx } from '../db/db.service';
import { alert, dispatch, fieldAlarm, media, operator, shift, tenant, unit, type DispatchRow, type UnitRow } from '../db/schema';
import { EventsService } from '../events/events.service';
import { RateLimitService } from '../infra/rate-limit.service';
import { MediaService } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import { STATUS_TEXT } from '../ops/ops.service';
import { RealtimeService } from '../realtime/realtime.service';
import { loadAlarms } from './field-alarms';

const OPEN: DispatchStatus[] = ['ASSIGNED', 'EN_ROUTE', 'ON_SITE'];

export type FieldPhoto = { buffer: Buffer; mimetype: string; size: number };

/**
 * Terreno (migración 0012, docs/plan-plataforma.md §5c). Todo lo que hace el funcionario corre en el contexto RLS
 * `field`: su turno, su unidad y el caso al que la despacharon. Lo que se emite a la central (la ficha completa
 * del caso) se lee después del commit en contexto system y va solo a la room del municipio.
 * La unidad informa; la central cierra (RT-8): ningún informe resuelve ni rechaza la alerta.
 */
@Injectable()
export class FieldService {
  private readonly logger = new Logger(FieldService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly events: EventsService,
    private readonly media: MediaService,
    private readonly reads: AlertReadService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly rate: RateLimitService,
  ) {}

  async state(op: OperatorClaims): Promise<FieldState> {
    const st = await this.dbs.asField(op.tenantId, op.sub, async (tx) => {
      const mine = await openShift(tx, op.sub);
      const d = mine?.unitId ? await openDispatch(tx) : null;
      const [panic] = await loadAlarms(
        tx,
        and(eq(fieldAlarm.operatorId, op.sub), eq(fieldAlarm.kind, 'PANIC'), isNull(fieldAlarm.closedAt)),
        1,
      );
      const units = mine?.unitId ? [] : await tx.select().from(unit).where(eq(unit.tenantId, op.tenantId)).orderBy(asc(unit.code));
      return { mine, dispatch: d ? await this.fieldDispatch(tx, d) : null, panic: panic ?? null, units };
    });
    // Quiénes salieron con cada unidad: son otras cuentas, que el contexto field no lee; se leen aparte.
    const crew = st.units.length ? await this.crewByUnit(op.tenantId) : new Map<string, string[]>();
    return {
      shift:
        st.mine?.unitId && st.mine.unitCode && st.mine.unitKind
          ? {
              id: st.mine.id,
              startedAt: st.mine.startedAt.toISOString(),
              unit: { id: st.mine.unitId, code: st.mine.unitCode, kind: st.mine.unitKind },
            }
          : null,
      dispatch: st.dispatch,
      units: st.units.map((u) => ({ id: u.id, code: u.code, kind: u.kind, status: u.status, crew: crew.get(u.id) ?? [] })),
      panic: st.panic,
    };
  }

  /** Inicia turno con una unidad: el turno programado más próximo o uno sin programar (como la central). */
  async startShift(op: OperatorClaims, body: StartFieldShift): Promise<FieldState> {
    let res: { unitRow: UnitRow; changed: boolean };
    try {
      res = await this.dbs.asField(op.tenantId, op.sub, async (tx) => {
        const [u] = await tx.select().from(unit).where(and(eq(unit.id, body.unitId), eq(unit.tenantId, op.tenantId))).limit(1);
        if (!u) throw new AppError('NOT_FOUND', 'Unidad no encontrada en este municipio');
        const open = await openShift(tx, op.sub);
        if (open?.unitId === u.id) return { unitRow: u, changed: false };
        if (open?.unitId) throw new AppError('CONFLICT', `Ya saliste con ${open.unitCode}: termina ese turno antes`);

        const now = new Date();
        let id: string;
        let planned = false;
        if (open) {
          // Turno abierto sin unidad (p. ej. iniciado antes de 0012): se le asigna la unidad.
          await tx.update(shift).set({ unitId: u.id }).where(eq(shift.id, open.id));
          id = open.id;
        } else {
          const [p] = await tx
            .select({ id: shift.id })
            .from(shift)
            .where(
              and(
                eq(shift.operatorId, op.sub),
                isNull(shift.startedAt),
                lte(shift.plannedStart, new Date(now.getTime() + EARLY_START_MS)),
                gt(shift.plannedEnd, now),
              ),
            )
            .orderBy(asc(shift.plannedStart))
            .limit(1);
          if (p) {
            await tx.update(shift).set({ startedAt: now, unitId: u.id }).where(eq(shift.id, p.id));
            id = p.id;
            planned = true;
          } else {
            [{ id }] = await tx
              .insert(shift)
              .values({ tenantId: op.tenantId, operatorId: op.sub, startedAt: now, unitId: u.id, createdBy: op.sub })
              .returning({ id: shift.id });
          }
        }
        // Una unidad fuera de servicio pasa a disponible cuando alguien sale con ella.
        let row = u;
        if (u.status === 'OFFLINE') [row] = await tx.update(unit).set({ status: 'AVAILABLE' }).where(eq(unit.id, u.id)).returning();
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'SHIFT_STARTED',
          targetId: id,
          payload: { planned, field: true, unitCode: u.code },
        });
        return { unitRow: row, changed: row.status !== u.status };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Ya tienes un turno iniciado');
      throw e;
    }
    await this.realtime.moveFieldOperator(op.sub, res.unitRow.id);
    if (res.changed) this.realtime.unitUpdated(op.tenantId, toUnit(res.unitRow));
    return this.state(op);
  }

  async endShift(op: OperatorClaims): Promise<FieldState> {
    await this.dbs.asField(op.tenantId, op.sub, async (tx) => {
      const open = await openShift(tx, op.sub);
      if (!open) throw new AppError('NOT_FOUND', 'No tienes un turno iniciado');
      if (open.unitId && (await openDispatch(tx))) {
        throw new AppError('CONFLICT', 'Tienes un despacho abierto: informa el resultado o pide a la central que lo cancele');
      }
      await tx.update(shift).set({ endedAt: new Date() }).where(eq(shift.id, open.id));
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'SHIFT_ENDED',
        targetId: open.id,
        payload: { field: true, unitCode: open.unitCode, withHandover: false },
      });
    });
    // La unidad queda como está: dejarla fuera de servicio lo decide la central (puede seguir por radio).
    await this.realtime.moveFieldOperator(op.sub, null);
    return this.state(op);
  }

  /** "Voy en camino" / "Llegué". Repetir el mismo estado no hace nada (doble toque). */
  async setStatus(op: OperatorClaims, dispatchId: string, body: FieldStatus): Promise<FieldState> {
    const r = await this.dbs.asField(op.tenantId, op.sub, async (tx) => {
      const [d] = await tx.select().from(dispatch).where(eq(dispatch.id, dispatchId)).for('update').limit(1);
      if (!d) throw new AppError('NOT_FOUND', 'Despacho no encontrado');
      if (d.status === body.status) return null;
      if (!canTransitionDispatch(d.status, body.status)) {
        throw new AppError('INVALID_TRANSITION', d.status === 'CANCELLED' ? 'La central canceló este despacho' : `No se puede pasar de ${d.status} a ${body.status}`);
      }
      const [updated] = await tx.update(dispatch).set({ status: body.status }).where(eq(dispatch.id, dispatchId)).returning();
      const unitRow = body.location ? await moveUnit(tx, d.unitId, body.location) : null;
      await touch(tx, d.alertId);
      const code = await unitCode(tx, d.unitId);
      await this.events.record(tx, {
        alertId: d.alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'DISPATCH_STATUS',
        payload: { dispatchId, status: body.status, unitCode: code, via: 'FIELD' },
      });
      return { d: updated, code, unitRow };
    });
    if (r) {
      await this.broadcast(op.tenantId, r.d, r.code, STATUS_TEXT[r.d.status]);
      if (r.unitRow) this.realtime.unitUpdated(op.tenantId, toUnit(r.unitRow));
    }
    return this.state(op);
  }

  /**
   * Informe de la unidad (RT-3, RT-4). Los resultados terminales cierran el despacho y liberan la unidad; la alerta
   * sigue abierta hasta que la central la resuelva (o la rechace, si la unidad confirmó un engaño). "Era otra
   * situación" queda como propuesta; "pide apoyo" levanta un aviso con sonido en la central.
   */
  async report(op: OperatorClaims, dispatchId: string, meta: FieldReport, photos: FieldPhoto[]): Promise<FieldState> {
    for (const p of photos) {
      if (!this.media.isAllowed('PHOTO', p.mimetype)) throw new AppError('VALIDATION_ERROR', `Formato de foto no admitido: ${p.mimetype}`);
    }
    const r = await this.dbs.asField(op.tenantId, op.sub, async (tx) => {
      const [d] = await tx.select().from(dispatch).where(eq(dispatch.id, dispatchId)).for('update').limit(1);
      if (!d) throw new AppError('NOT_FOUND', 'Despacho no encontrado');
      if (!OPEN.includes(d.status)) {
        throw new AppError('CONFLICT', d.status === 'CANCELLED' ? 'La central canceló este despacho' : 'Este despacho ya está cerrado');
      }
      const [a] = await tx.select({ type: alert.type }).from(alert).where(eq(alert.id, d.alertId)).limit(1);
      if (!a) throw new AppError('NOT_FOUND', 'Caso no encontrado');
      if (meta.category && !categoriesFor(a.type).includes(meta.category)) {
        throw new AppError('VALIDATION_ERROR', 'La categoría no corresponde al tipo de caso');
      }
      const close = TERMINAL_OUTCOMES.includes(meta.outcome);
      const proposed = meta.outcome === 'DIFFERENT_SITUATION';
      const now = new Date();
      const [updated] = await tx
        .update(dispatch)
        .set({
          outcome: meta.outcome,
          outcomeNote: meta.notes ?? null,
          outcomeAt: now,
          outcomeBy: op.sub,
          outcomeVia: 'FIELD',
          proposedCategory: proposed ? (meta.category ?? null) : null,
          proposedSubcategory: proposed ? (meta.subcategory ?? null) : null,
          ...(close ? { status: 'CLOSED' as const, closedAt: now } : {}),
        })
        .where(eq(dispatch.id, dispatchId))
        .returning();
      let unitRow: UnitRow | null = meta.location ? await moveUnit(tx, d.unitId, meta.location) : null;
      if (close) [unitRow] = await tx.update(unit).set({ status: 'AVAILABLE' }).where(eq(unit.id, d.unitId)).returning();

      if (photos.length) {
        const [t] = await tx.select({ days: tenant.audioRetentionDays }).from(tenant).where(eq(tenant.id, op.tenantId)).limit(1);
        for (const p of photos) {
          await this.media.store(tx, {
            alertId: d.alertId,
            tenantId: op.tenantId,
            kind: 'PHOTO',
            body: p.buffer,
            mime: p.mimetype,
            retentionDays: t?.days ?? 90,
          });
        }
      }
      await touch(tx, d.alertId);
      const code = await unitCode(tx, d.unitId);
      await this.events.record(tx, {
        alertId: d.alertId,
        tenantId: op.tenantId,
        actorType: 'OPERATOR',
        actorId: op.sub,
        kind: 'FIELD_REPORT',
        payload: {
          dispatchId,
          unitCode: code,
          outcome: meta.outcome,
          notes: meta.notes ?? null,
          category: meta.category ?? null,
          subcategory: meta.subcategory ?? null,
          closedDispatch: close,
          photos: photos.length,
          via: 'FIELD',
        },
      });

      let alarmId: string | null = null;
      if (meta.outcome === 'NEEDS_SUPPORT') {
        alarmId = await openAlarm(tx, {
          tenantId: op.tenantId,
          kind: 'SUPPORT',
          unitId: d.unitId,
          operatorId: op.sub,
          dispatchId,
          alertId: d.alertId,
          location: meta.location,
          note: meta.notes ?? null,
        });
        await this.events.record(tx, {
          alertId: d.alertId,
          tenantId: op.tenantId,
          actorType: 'OPERATOR',
          actorId: op.sub,
          kind: 'FIELD_ALARM',
          payload: { alarmId, kind: 'SUPPORT', unitCode: code, note: meta.notes ?? null },
        });
      }
      return { d: updated, code, unitRow, alarmId };
    });
    await this.broadcast(op.tenantId, r.d, r.code);
    if (r.unitRow) this.realtime.unitUpdated(op.tenantId, toUnit(r.unitRow));
    if (r.alarmId) await this.emitAlarm(op.tenantId, r.alarmId);
    return this.state(op);
  }

  /** Posición del teléfono (RT-5): solo con un despacho abierto; el resto del tiempo no se guarda nada. */
  async location(op: OperatorClaims, loc: FieldLocation): Promise<void> {
    await this.rate.hit(`field-loc:${op.sub}`, 30, 60, 'Demasiadas posiciones seguidas');
    const row = await this.dbs.asField(op.tenantId, op.sub, async (tx) => {
      const d = await openDispatch(tx);
      if (!d) throw new AppError('CONFLICT', 'Sin despacho abierto: la posición solo se envía durante un despacho');
      return moveUnit(tx, d.unitId, loc);
    });
    if (row) this.realtime.unitUpdated(op.tenantId, toUnit(row));
  }

  /**
   * Pánico del funcionario (RT-6): llega a la central como lo más urgente, con su posición. Funciona con o sin
   * turno; apretar de nuevo mientras no lo atienden actualiza la posición. Nunca se limita.
   */
  async panic(op: OperatorClaims, body: Panic): Promise<FieldAlarm> {
    const r = await this.dbs.asField(op.tenantId, op.sub, async (tx) => {
      const mine = await openShift(tx, op.sub);
      const d = mine?.unitId ? await openDispatch(tx) : null;
      const alarmId = await openAlarm(tx, {
        tenantId: op.tenantId,
        kind: 'PANIC',
        unitId: mine?.unitId ?? null,
        operatorId: op.sub,
        dispatchId: d?.id ?? null,
        alertId: d?.alertId ?? null,
        location: body.location,
        note: body.note ?? null,
      });
      const unitRow = body.location && mine?.unitId ? await moveUnit(tx, mine.unitId, body.location) : null;
      if (d) {
        await this.events.record(tx, {
          alertId: d.alertId,
          tenantId: op.tenantId,
          actorType: 'OPERATOR',
          actorId: op.sub,
          kind: 'FIELD_ALARM',
          payload: { alarmId, kind: 'PANIC', unitCode: mine?.unitCode ?? null },
        });
      }
      return { alarmId, unitRow };
    });
    const alarm = await this.emitAlarm(op.tenantId, r.alarmId);
    if (r.unitRow) this.realtime.unitUpdated(op.tenantId, toUnit(r.unitRow));
    this.logger.warn(`PÁNICO de terreno: operador ${op.sub}, municipio ${op.tenantId}`);
    return alarm;
  }

  // ---------------------------------------------------------------- después del commit

  /** La central recibe el despacho y la ficha al día; el vecino, el aviso de "en camino" o "en el lugar". */
  private async broadcast(tenantId: string, row: DispatchRow, code: string, text?: { title: string; body: string }) {
    const d = toDispatch(row, code);
    const detail = await this.dbs.asSystem((tx) => this.reads.detail(tx, row.alertId));
    this.realtime.dispatchUpdated(tenantId, d);
    this.realtime.alertUpdated(tenantId, detail);
    if (!text) return;
    try {
      const view = await this.dbs.asSystem((tx) => this.reads.citizenView(tx, row.alertId));
      await this.notifications.notifyAlertStatus(detail.citizenId, detail.tenantId, view, {
        title: text.title,
        body: text.body.replace('{unit}', code),
      });
    } catch (e) {
      this.logger.warn(`No se pudo notificar al vecino de ${row.alertId}: ${(e as Error).message}`);
    }
  }

  private async emitAlarm(tenantId: string, alarmId: string): Promise<FieldAlarm> {
    const [alarm] = await this.dbs.asSystem((tx) => loadAlarms(tx, eq(fieldAlarm.id, alarmId), 1));
    this.realtime.fieldAlarm(tenantId, alarm);
    return alarm;
  }

  private async crewByUnit(tenantId: string): Promise<Map<string, string[]>> {
    const rows = await this.dbs.asSystem((tx) =>
      tx
        .select({ unitId: shift.unitId, name: operator.name })
        .from(shift)
        .innerJoin(operator, eq(operator.id, shift.operatorId))
        .where(and(eq(shift.tenantId, tenantId), isNotNull(shift.unitId), isNotNull(shift.startedAt), isNull(shift.endedAt)))
        .orderBy(asc(operator.name)),
    );
    const map = new Map<string, string[]>();
    for (const r of rows) if (r.unitId) map.set(r.unitId, [...(map.get(r.unitId) ?? []), r.name]);
    return map;
  }

  /** El caso tal como lo ve la unidad: sin teléfono, nombre ni transcripción del vecino. */
  private async fieldDispatch(tx: Tx, d: DispatchRow): Promise<FieldDispatch | null> {
    const [a] = await tx.select().from(alert).where(eq(alert.id, d.alertId)).limit(1);
    if (!a) return null;
    const photos = await tx
      .select()
      .from(media)
      .where(and(eq(media.alertId, a.id), eq(media.kind, 'PHOTO'), isNull(media.deletedAt)))
      .orderBy(asc(media.createdAt));
    const t = a.aiTriage;
    return {
      id: d.id,
      status: d.status,
      notes: d.notes,
      outcome: d.outcome,
      outcomeNote: d.outcomeNote,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      alert: {
        id: a.id,
        type: a.type,
        category: a.category,
        subcategory: a.subcategory,
        priority: a.priority,
        summary: t?.summary ?? a.aiSummary,
        place: t?.location?.mentioned ?? null,
        questions: t?.questions ?? [],
        location: { lat: a.lat, lng: a.lng },
        addressHint: a.addressHint,
        createdAt: a.createdAt.toISOString(),
        photos: await this.media.toPublic(photos),
      },
    };
  }
}

// ---------------------------------------------------------------- consultas (contexto field)

async function openShift(tx: Tx, operatorId: string) {
  const [row] = await tx
    .select({ id: shift.id, startedAt: shift.startedAt, unitId: shift.unitId, unitCode: unit.code, unitKind: unit.kind })
    .from(shift)
    .leftJoin(unit, eq(unit.id, shift.unitId))
    .where(and(eq(shift.operatorId, operatorId), isNotNull(shift.startedAt), isNull(shift.endedAt)))
    .limit(1);
  return row ? { ...row, startedAt: row.startedAt! } : null;
}

/** El despacho abierto de su unidad (la política dispatch_field ya limita a su unidad). */
async function openDispatch(tx: Tx): Promise<DispatchRow | null> {
  const [row] = await tx.select().from(dispatch).where(inArray(dispatch.status, OPEN)).orderBy(asc(dispatch.createdAt)).limit(1);
  return row ?? null;
}

async function moveUnit(tx: Tx, unitId: string, loc: FieldLocation): Promise<UnitRow | null> {
  const [row] = await tx
    .update(unit)
    .set({ lastLat: loc.lat, lastLng: loc.lng, lastSeenAt: new Date() })
    .where(eq(unit.id, unitId))
    .returning();
  return row ?? null;
}

async function unitCode(tx: Tx, unitId: string): Promise<string> {
  const [u] = await tx.select({ code: unit.code }).from(unit).where(eq(unit.id, unitId)).limit(1);
  return u?.code ?? '';
}

/** Fuerza updated_at para que el `sync` de la central incluya el caso. */
async function touch(tx: Tx, alertId: string) {
  await tx.update(alert).set({ addressHint: sql`${alert.addressHint}` }).where(eq(alert.id, alertId));
}

/**
 * Abre un aviso o, si ya hay uno abierto del mismo tipo (pánico del funcionario, apoyo del despacho), le
 * actualiza la posición. Los índices parciales únicos impiden duplicados aunque lleguen dos a la vez.
 */
async function openAlarm(
  tx: Tx,
  a: {
    tenantId: string;
    kind: 'PANIC' | 'SUPPORT';
    unitId: string | null;
    operatorId: string;
    dispatchId: string | null;
    alertId: string | null;
    location?: FieldLocation;
    note: string | null;
  },
): Promise<string> {
  const pos = a.location ? { lat: a.location.lat, lng: a.location.lng, accuracyM: a.location.accuracyM ?? null } : {};
  const sameOpen =
    a.kind === 'PANIC'
      ? and(eq(fieldAlarm.operatorId, a.operatorId), eq(fieldAlarm.kind, 'PANIC'), isNull(fieldAlarm.closedAt))
      : and(eq(fieldAlarm.dispatchId, a.dispatchId!), eq(fieldAlarm.kind, a.kind), isNull(fieldAlarm.closedAt));
  const [existing] = await tx.select({ id: fieldAlarm.id }).from(fieldAlarm).where(sameOpen).limit(1);
  if (existing) {
    if (a.location) await tx.update(fieldAlarm).set(pos).where(eq(fieldAlarm.id, existing.id));
    return existing.id;
  }
  const [row] = await tx
    .insert(fieldAlarm)
    .values({
      tenantId: a.tenantId,
      kind: a.kind,
      unitId: a.unitId,
      operatorId: a.operatorId,
      dispatchId: a.dispatchId,
      alertId: a.alertId,
      note: a.note,
      ...pos,
    })
    .returning({ id: fieldAlarm.id });
  return row.id;
}
