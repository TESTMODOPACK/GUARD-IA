import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { OperatorRole } from '@guardia/shared';
import { DbService } from '../db/db.service';
import { operator, tenant } from '../db/schema';

export interface OperatorStatus {
  tenantId: string;
  role: OperatorRole;
  active: boolean;
  mustChangePassword: boolean;
}

const TTL_MS = 30_000;

/**
 * Estado vigente de un operador para el guard. El access token del operador dura 12 h: sin esta
 * consulta, desactivar una cuenta o bajarle el rol no tendría efecto hasta que venza. La caché de
 * 30 s acota el costo (una consulta por operador cada 30 s) y quien cambia el estado la invalida
 * al confirmar, así que en esta réplica el efecto es inmediato y en otras, a lo más 30 s.
 */
@Injectable()
export class OperatorStatusService {
  private readonly cache = new Map<string, { at: number; value: OperatorStatus | null }>();

  constructor(private readonly dbs: DbService) {}

  async get(operatorId: string): Promise<OperatorStatus | null> {
    const hit = this.cache.get(operatorId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.dbs.asSystem(async (tx) => {
      const [o] = await tx
        .select({
          tenantId: operator.tenantId,
          role: operator.role,
          active: operator.active,
          mustChangePassword: operator.mustChangePassword,
          tenantStatus: tenant.status,
        })
        .from(operator)
        .innerJoin(tenant, eq(tenant.id, operator.tenantId))
        .where(eq(operator.id, operatorId))
        .limit(1);
      if (!o) return null;
      const { tenantStatus, ...rest } = o;
      // Municipio dado de baja (0010): sus cuentas dejan de entrar como si estuvieran desactivadas.
      return { ...rest, active: rest.active && tenantStatus !== 'TERMINATED' };
    });
    this.cache.set(operatorId, { at: Date.now(), value });
    return value;
  }

  /** Llamar DESPUÉS del commit que cambió la cuenta. */
  invalidate(operatorId: string): void {
    this.cache.delete(operatorId);
  }

  /** Tras cambiar el estado de un municipio: afecta a todas sus cuentas. */
  invalidateAll(): void {
    this.cache.clear();
  }
}
