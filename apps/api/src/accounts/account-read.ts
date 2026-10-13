import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { RESTRICT_AT_STRIKES, type AccountLevel, type CitizenAccount } from '@guardia/shared';
import type { Tx } from '../db/db.service';
import { citizenStrike } from '../db/schema';

export function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

/** "Ana Pérez · +569•••••123": la central identifica al vecino sin mostrar el teléfono completo en listas. */
export function citizenLabel(name: string | null, phone: string): string {
  const masked = phone.length > 7 ? `${phone.slice(0, 4)}•••••${phone.slice(-3)}` : '•••';
  return name ? `${name} · ${masked}` : `Vecino ${masked}`;
}

/**
 * Estado de la cuenta del vecino por uso indebido, en todo el país (la cuenta es una sola). Corre en contexto
 * citizen (sus propias filas) o system. Los mismos umbrales que aplica la base en alert_account_check (0011).
 */
export async function loadCitizenAccount(tx: Tx, citizenId: string): Promise<CitizenAccount> {
  const strikes = await tx
    .select({ expiresAt: citizenStrike.expiresAt })
    .from(citizenStrike)
    .where(and(eq(citizenStrike.citizenId, citizenId), isNull(citizenStrike.annulledAt), gt(citizenStrike.expiresAt, sql`now()`)))
    .orderBy(desc(citizenStrike.expiresAt));
  const [block] = (await tx.execute(sql`
    SELECT b.ends_at, d.name AS tenant_name
      FROM citizen_block b
      JOIN tenant_directory d ON d.id = b.tenant_id
     WHERE b.citizen_id = ${citizenId}::uuid AND b.status = 'ACTIVE' AND (b.ends_at IS NULL OR b.ends_at > now())
     ORDER BY b.ends_at DESC NULLS FIRST
     LIMIT 1`)) as unknown as { ends_at: Date | null; tenant_name: string }[];

  const n = strikes.length;
  const level: AccountLevel = block ? 'BLOCKED' : n >= RESTRICT_AT_STRIKES ? 'RESTRICTED' : n > 0 ? 'WARNED' : 'OK';
  return {
    level,
    activeStrikes: n,
    // Ordenadas de la que vence más tarde a la más próxima: deja de estar restringida cuando vence la segunda
    // más tardía, porque desde ahí le queda una sola (si no suma otra).
    restrictedUntil: n >= RESTRICT_AT_STRIKES ? iso(strikes[RESTRICT_AT_STRIKES - 1].expiresAt) : null,
    block: block ? { endsAt: block.ends_at ? iso(block.ends_at) : null, tenantName: block.tenant_name } : null,
  };
}
