import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { CreateShift, EndShift, Shift, ShiftsQuery, ShiftStatus } from '@guardia/shared';
import { AuditService } from '../auth/audit.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { operator, shift } from '../db/schema';
import { isUniqueViolation } from './operators.service';

/** Un turno programado se puede iniciar desde 60 min antes. */
const EARLY_START_MS = 60 * 60_000;

type ShiftRow = typeof shift.$inferSelect & { operatorName: string };

/**
 * Turnos de la central: el supervisor programa (planned_*) y el operador marca inicio y término
 * (started_at / ended_at) y deja la nota de entrega para quien sigue.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  list(op: OperatorClaims, q: ShiftsQuery): Promise<Shift[]> {
    const from = new Date(q.from);
    const to = new Date(q.to);
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const rows = await selectShifts(tx)
        .where(
          and(
            sql`coalesce(${shift.plannedStart}, ${shift.startedAt}) < ${to.toISOString()}::timestamptz`,
            sql`coalesce(${shift.plannedEnd}, ${shift.endedAt}, now()) > ${from.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(sql`coalesce(${shift.plannedStart}, ${shift.startedAt})`);
      return rows.map(toShift);
    });
  }

  async create(op: OperatorClaims, body: CreateShift): Promise<Shift> {
    const start = new Date(body.plannedStart);
    const end = new Date(body.plannedEnd);
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [who] = await tx
        .select({ name: operator.name, active: operator.active })
        .from(operator)
        .where(eq(operator.id, body.operatorId))
        .limit(1);
      if (!who) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      if (!who.active) throw new AppError('CONFLICT', 'La cuenta está desactivada');
      const [overlap] = await tx
        .select({ id: shift.id })
        .from(shift)
        .where(
          and(
            eq(shift.operatorId, body.operatorId),
            isNotNull(shift.plannedStart),
            sql`${shift.plannedStart} < ${end.toISOString()}::timestamptz AND ${shift.plannedEnd} > ${start.toISOString()}::timestamptz`,
          ),
        )
        .limit(1);
      if (overlap) throw new AppError('CONFLICT', `${who.name} ya tiene un turno programado en ese horario`);

      const [r] = await tx
        .insert(shift)
        .values({ tenantId: op.tenantId, operatorId: body.operatorId, plannedStart: start, plannedEnd: end, createdBy: op.sub })
        .returning();
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'SHIFT_PLANNED',
        targetId: r.id,
        payload: { operatorId: body.operatorId, operatorName: who.name, plannedStart: body.plannedStart, plannedEnd: body.plannedEnd },
      });
      return toShift({ ...r, operatorName: who.name });
    });
  }

  async remove(op: OperatorClaims, id: string): Promise<void> {
    await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await selectShifts(tx).where(eq(shift.id, id)).limit(1);
      if (!row) throw new AppError('NOT_FOUND', 'Turno no encontrado');
      if (row.startedAt) throw new AppError('CONFLICT', 'Un turno ya iniciado no se puede eliminar');
      await tx.delete(shift).where(eq(shift.id, id));
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'SHIFT_REMOVED',
        targetId: id,
        payload: { operatorName: row.operatorName, plannedStart: row.plannedStart?.toISOString() ?? null },
      });
    });
  }

  /** Inicia el turno programado más próximo del operador o, si no hay, uno sin programar. */
  async start(op: OperatorClaims): Promise<Shift> {
    try {
      return await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
        const [open] = await tx
          .select({ id: shift.id })
          .from(shift)
          .where(and(eq(shift.operatorId, op.sub), isNotNull(shift.startedAt), isNull(shift.endedAt)))
          .limit(1);
        if (open) throw new AppError('CONFLICT', 'Ya tienes un turno iniciado');

        const now = new Date();
        const [planned] = await tx
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
        const id = planned
          ? (await tx.update(shift).set({ startedAt: now }).where(eq(shift.id, planned.id)).returning({ id: shift.id }))[0].id
          : (
              await tx
                .insert(shift)
                .values({ tenantId: op.tenantId, operatorId: op.sub, startedAt: now, createdBy: op.sub })
                .returning({ id: shift.id })
            )[0].id;
        await this.audit.record(tx, { tenantId: op.tenantId, actorId: op.sub, kind: 'SHIFT_STARTED', targetId: id, payload: { planned: !!planned } });
        const [row] = await selectShifts(tx).where(eq(shift.id, id)).limit(1);
        return toShift(row);
      });
    } catch (e) {
      // Dos pestañas iniciando a la vez: el índice único shift_open_uidx deja pasar solo una.
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Ya tienes un turno iniciado');
      throw e;
    }
  }

  async end(op: OperatorClaims, body: EndShift): Promise<Shift> {
    const note = typeof body.handoverNote === 'string' && body.handoverNote.trim() ? body.handoverNote.trim() : null;
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [r] = await tx
        .update(shift)
        .set({ endedAt: new Date(), handoverNote: note })
        .where(and(eq(shift.operatorId, op.sub), isNotNull(shift.startedAt), isNull(shift.endedAt)))
        .returning({ id: shift.id });
      if (!r) throw new AppError('NOT_FOUND', 'No tienes un turno iniciado');
      await this.audit.record(tx, { tenantId: op.tenantId, actorId: op.sub, kind: 'SHIFT_ENDED', targetId: r.id, payload: { withHandover: !!note } });
      const [row] = await selectShifts(tx).where(eq(shift.id, r.id)).limit(1);
      return toShift(row);
    });
  }

  status(op: OperatorClaims): Promise<ShiftStatus> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const now = new Date();
      const [mine] = await selectShifts(tx)
        .where(and(eq(shift.operatorId, op.sub), isNotNull(shift.startedAt), isNull(shift.endedAt)))
        .limit(1);
      const [next] = mine
        ? []
        : await selectShifts(tx)
            .where(and(eq(shift.operatorId, op.sub), isNull(shift.startedAt), gt(shift.plannedEnd, now)))
            .orderBy(asc(shift.plannedStart))
            .limit(1);
      const [last] = await selectShifts(tx)
        .where(and(isNotNull(shift.endedAt), isNotNull(shift.handoverNote)))
        .orderBy(desc(shift.endedAt))
        .limit(1);
      const onDuty = await selectShifts(tx)
        .where(and(isNotNull(shift.startedAt), isNull(shift.endedAt)))
        .orderBy(asc(shift.startedAt));
      return {
        mine: mine ? toShift(mine) : null,
        next: next ? toShift(next) : null,
        lastHandover:
          last && last.handoverNote && last.endedAt
            ? { note: last.handoverNote, operatorName: last.operatorName, endedAt: last.endedAt.toISOString() }
            : null,
        onDuty: onDuty.map((s) => ({ operatorId: s.operatorId, name: s.operatorName, startedAt: s.startedAt!.toISOString() })),
      };
    });
  }
}

function selectShifts(tx: Tx) {
  return tx
    .select({
      id: shift.id,
      tenantId: shift.tenantId,
      operatorId: shift.operatorId,
      plannedStart: shift.plannedStart,
      plannedEnd: shift.plannedEnd,
      startedAt: shift.startedAt,
      endedAt: shift.endedAt,
      handoverNote: shift.handoverNote,
      createdBy: shift.createdBy,
      createdAt: shift.createdAt,
      operatorName: operator.name,
    })
    .from(shift)
    .innerJoin(operator, eq(operator.id, shift.operatorId))
    .$dynamic();
}

function toShift(r: ShiftRow): Shift {
  return {
    id: r.id,
    operatorId: r.operatorId,
    operatorName: r.operatorName,
    plannedStart: r.plannedStart?.toISOString() ?? null,
    plannedEnd: r.plannedEnd?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    handoverNote: r.handoverNote,
    createdAt: r.createdAt.toISOString(),
  };
}
