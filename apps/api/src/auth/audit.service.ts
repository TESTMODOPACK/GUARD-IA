import { Injectable } from '@nestjs/common';
import type { AuditKind } from '@guardia/shared';
import type { Tx } from '../db/db.service';
import { auditLog } from '../db/schema';

export interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  kind: AuditKind;
  targetId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Bitácora del sistema (tabla audit_log, solo inserción). Se escribe en la MISMA transacción que el
 * cambio que registra, para que no exista un cambio sin su registro ni un registro sin cambio.
 * Nunca guardar contraseñas, tokens ni datos del vecino en el payload.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      tenantId: e.tenantId,
      actorId: e.actorId,
      kind: e.kind,
      targetId: e.targetId ?? null,
      payload: e.payload ?? {},
    });
  }
}
