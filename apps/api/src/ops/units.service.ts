import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { CreateUnit, Unit, UpdateUnit } from '@guardia/shared';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { toUnit } from '../common/mappers';
import { DbService } from '../db/db.service';
import { dispatch, unit } from '../db/schema';
import { RealtimeService } from '../realtime/realtime.service';

@Injectable()
export class UnitsService {
  constructor(
    private readonly dbs: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  list(op: OperatorClaims): Promise<Unit[]> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const rows = await tx.select().from(unit).orderBy(asc(unit.code));
      return rows.map(toUnit);
    });
  }

  async create(op: OperatorClaims, body: CreateUnit): Promise<Unit> {
    const u = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [row] = await tx
        .insert(unit)
        .values({ tenantId: op.tenantId, code: body.code, kind: body.kind })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new AppError('CONFLICT', `Ya existe la unidad ${body.code}`);
      return toUnit(row);
    });
    this.realtime.unitUpdated(op.tenantId, u);
    return u;
  }

  async update(op: OperatorClaims, unitId: string, body: UpdateUnit): Promise<Unit> {
    if (body.kind && op.role === 'OPERATOR') {
      throw new AppError('FORBIDDEN', 'Solo ADMIN o SUPERVISOR cambian el tipo de unidad');
    }
    const u = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      if (body.status === 'AVAILABLE') {
        const [open] = await tx
          .select({ alertId: dispatch.alertId })
          .from(dispatch)
          .where(and(eq(dispatch.unitId, unitId), inArray(dispatch.status, ['ASSIGNED', 'EN_ROUTE', 'ON_SITE'])))
          .limit(1);
        if (open) {
          throw new AppError('CONFLICT', `La unidad tiene un despacho abierto (alerta ${open.alertId}); ciérralo primero`);
        }
      }
      const [row] = await tx
        .update(unit)
        .set({
          ...(body.status ? { status: body.status } : {}),
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.lastLocation
            ? { lastLat: body.lastLocation.lat, lastLng: body.lastLocation.lng, lastSeenAt: new Date() }
            : {}),
        })
        .where(eq(unit.id, unitId))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'Unidad no encontrada');
      return toUnit(row);
    });
    this.realtime.unitUpdated(op.tenantId, u);
    return u;
  }
}
