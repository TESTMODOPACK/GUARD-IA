import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  SUGGESTED_AREAS,
  type AreaRef,
  type AreasConfig,
  type CreateArea,
  type SetAreaMode,
  type SetAreaRules,
  type UpdateArea,
} from '@guardia/shared';
import { isUniqueViolation } from '../admin/operators.service';
import { AuditService } from '../auth/audit.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { alert, area, areaRule, operator, operatorArea, tenantAreaMode } from '../db/schema';
import { RealtimeService } from '../realtime/realtime.service';

const OPEN = ['PENDING', 'ACKNOWLEDGED', 'DISPATCHED'] as const;

/**
 * Áreas del municipio (0013). Las define el administrador municipal (el controlador lo exige); cada cambio queda en la
 * bitácora en la misma transacción. Cuando cambia lo que ve la gente (áreas activas, cuál recibe los SOS, modo
 * compartido), los sockets de la central se reconectan para entrar a las rooms nuevas.
 */
@Injectable()
export class AreasService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  config(op: OperatorClaims): Promise<AreasConfig> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const rows = await tx.select().from(area).where(eq(area.tenantId, op.tenantId)).orderBy(asc(area.name));
      const members = await tx
        .select({ areaId: operatorArea.areaId, n: count() })
        .from(operatorArea)
        .innerJoin(operator, and(eq(operator.id, operatorArea.operatorId), eq(operator.active, true)))
        .where(eq(operatorArea.tenantId, op.tenantId))
        .groupBy(operatorArea.areaId);
      const open = await tx
        .select({ areaId: alert.areaId, n: count() })
        .from(alert)
        .where(and(eq(alert.tenantId, op.tenantId), inArray(alert.status, [...OPEN])))
        .groupBy(alert.areaId);
      const rules = await tx
        .select({ category: areaRule.category, subcategory: areaRule.subcategory, areaId: areaRule.areaId })
        .from(areaRule)
        .where(eq(areaRule.tenantId, op.tenantId))
        .orderBy(asc(areaRule.category), asc(areaRule.subcategory));
      const [mode] = await tx.select().from(tenantAreaMode).where(eq(tenantAreaMode.tenantId, op.tenantId)).limit(1);
      const m = new Map(members.map((r) => [r.areaId, r.n]));
      const o = new Map(open.map((r) => [r.areaId, r.n]));
      return {
        shared: !!mode?.shared,
        areas: rows.map((a) => ({
          id: a.id,
          name: a.name,
          receivesSos: a.receivesSos,
          active: a.active,
          members: m.get(a.id) ?? 0,
          openAlerts: o.get(a.id) ?? 0,
          createdAt: a.createdAt.toISOString(),
        })),
        rules: rules.map((r) => ({ ...r, category: r.category as AreasConfig['rules'][number]['category'] })),
      };
    });
  }

  /** Las áreas activas, para "Cambiar área" y para mostrar nombres (cualquier rol de la central). */
  refs(op: OperatorClaims): Promise<AreaRef[]> {
    return this.dbs.asOperator(op.tenantId, op.sub, (tx) =>
      tx
        .select({ id: area.id, name: area.name, receivesSos: area.receivesSos })
        .from(area)
        .where(and(eq(area.tenantId, op.tenantId), eq(area.active, true)))
        .orderBy(asc(area.name)),
    );
  }

  async create(op: OperatorClaims, body: CreateArea): Promise<AreasConfig> {
    await this.inTx(op, async (tx) => {
      // Si ninguna recibe los SOS, esta los recibe (un SOS nunca queda sin área).
      const [sos] = await tx
        .select({ id: area.id })
        .from(area)
        .where(and(eq(area.tenantId, op.tenantId), eq(area.receivesSos, true)))
        .limit(1);
      const receivesSos = body.receivesSos ?? !sos;
      if (receivesSos && sos) await tx.update(area).set({ receivesSos: false }).where(eq(area.id, sos.id));
      const [a] = await tx
        .insert(area)
        .values({ tenantId: op.tenantId, name: body.name, receivesSos, createdBy: op.sub })
        .returning();
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'AREA_CREATED',
        targetId: a.id,
        payload: { name: a.name, receivesSos },
      });
    });
    await this.realtime.reconnectOperators(op.tenantId);
    return this.config(op);
  }

  /** Las áreas que sugiere la central (SUGGESTED_AREAS) con sus categorías; solo si el municipio aún no tiene. */
  async createSuggested(op: OperatorClaims): Promise<AreasConfig> {
    await this.inTx(op, async (tx) => {
      const [{ n }] = await tx.select({ n: count() }).from(area).where(eq(area.tenantId, op.tenantId));
      if (n > 0) throw new AppError('CONFLICT', 'El municipio ya tiene áreas: créalas o edítalas una por una');
      for (const s of SUGGESTED_AREAS) {
        const [a] = await tx
          .insert(area)
          .values({ tenantId: op.tenantId, name: s.name, receivesSos: s.receivesSos, createdBy: op.sub })
          .returning({ id: area.id });
        if (s.categories.length) {
          await tx.insert(areaRule).values(s.categories.map((category) => ({ tenantId: op.tenantId, category, areaId: a.id })));
        }
      }
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'AREA_CREATED',
        payload: { suggested: SUGGESTED_AREAS.map((s) => s.name) },
      });
    });
    await this.realtime.reconnectOperators(op.tenantId);
    return this.config(op);
  }

  async update(op: OperatorClaims, id: string, body: UpdateArea): Promise<AreasConfig> {
    await this.inTx(op, async (tx) => {
      const [before] = await tx
        .select()
        .from(area)
        .where(and(eq(area.id, id), eq(area.tenantId, op.tenantId)))
        .for('update')
        .limit(1);
      if (!before) throw new AppError('NOT_FOUND', 'Área no encontrada');

      if (body.active === false && before.active) {
        if (before.receivesSos) {
          throw new AppError('CONFLICT', 'Es el área que recibe los SOS: elige otra que los reciba antes de desactivarla');
        }
        const [{ rules }] = await tx.select({ rules: count() }).from(areaRule).where(eq(areaRule.areaId, id));
        if (rules > 0) throw new AppError('CONFLICT', 'Antes de desactivarla, asigna sus categorías a otra área');
        const [{ open }] = await tx
          .select({ open: count() })
          .from(alert)
          .where(and(eq(alert.tenantId, op.tenantId), eq(alert.areaId, id), inArray(alert.status, [...OPEN])));
        if (open > 0) throw new AppError('CONFLICT', `Tiene ${open} ${open === 1 ? 'alerta abierta: pásala' : 'alertas abiertas: pásalas'} a otra área primero`);
      }
      if (body.receivesSos) {
        if (body.active === false || (!before.active && body.active !== true)) {
          throw new AppError('VALIDATION_ERROR', 'Un área desactivada no puede recibir los SOS');
        }
        await tx
          .update(area)
          .set({ receivesSos: false })
          .where(and(eq(area.tenantId, op.tenantId), eq(area.receivesSos, true), ne(area.id, id)));
      }
      const [after] = await tx
        .update(area)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.receivesSos ? { receivesSos: true } : {}),
        })
        .where(eq(area.id, id))
        .returning();
      const changes: Record<string, [unknown, unknown]> = {};
      for (const k of ['name', 'active', 'receivesSos'] as const) {
        if (before[k] !== after[k]) changes[k] = [before[k], after[k]];
      }
      if (Object.keys(changes).length) {
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'AREA_UPDATED',
          targetId: id,
          payload: { name: after.name, changes },
        });
      }
    });
    if (body.active !== undefined || body.receivesSos) await this.realtime.reconnectOperators(op.tenantId);
    return this.config(op);
  }

  /** Reemplaza todas las reglas. Rige para los reportes nuevos; los abiertos quedan en su área (se reasignan a mano). */
  async setRules(op: OperatorClaims, body: SetAreaRules): Promise<AreasConfig> {
    await this.inTx(op, async (tx) => {
      const ids = [...new Set(body.rules.map((r) => r.areaId))];
      const found = await tx
        .select({ id: area.id })
        .from(area)
        .where(and(eq(area.tenantId, op.tenantId), eq(area.active, true), inArray(area.id, ids)));
      if (found.length !== ids.length) {
        throw new AppError('VALIDATION_ERROR', 'Alguna regla apunta a un área que no existe o está desactivada');
      }
      await tx.delete(areaRule).where(eq(areaRule.tenantId, op.tenantId));
      await tx.insert(areaRule).values(
        body.rules.map((r) => ({ tenantId: op.tenantId, category: r.category, subcategory: r.subcategory ?? null, areaId: r.areaId })),
      );
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'AREA_RULES_UPDATED',
        payload: { rules: body.rules.length, bySubcategory: body.rules.filter((r) => r.subcategory).length },
      });
    });
    return this.config(op);
  }

  /** Excepción a la regla: todas las áreas ven todos los avisos (con motivo, queda en la bitácora). */
  async setMode(op: OperatorClaims, body: SetAreaMode): Promise<AreasConfig> {
    await this.inTx(op, async (tx) => {
      await tx
        .insert(tenantAreaMode)
        .values({ tenantId: op.tenantId, shared: body.shared, updatedBy: op.sub })
        .onConflictDoUpdate({
          target: tenantAreaMode.tenantId,
          set: { shared: body.shared, updatedBy: op.sub, updatedAt: sql`now()` },
        });
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'AREA_MODE_CHANGED',
        payload: { shared: body.shared, reason: body.reason },
      });
    });
    await this.realtime.reconnectOperators(op.tenantId);
    return this.config(op);
  }

  private async inTx(op: OperatorClaims, fn: (tx: Tx) => Promise<void>) {
    try {
      await this.dbs.asOperator(op.tenantId, op.sub, fn);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Ya existe un área con ese nombre');
      throw e;
    }
  }
}
