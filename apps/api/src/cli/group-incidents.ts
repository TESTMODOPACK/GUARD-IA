/**
 * pnpm --filter @guardia/api group-incidents   (node dist/cli/group-incidents.js en producción)
 * Agrupa en incidentes las alertas abiertas que existían antes de la migración 0004 (o que
 * quedaron sin grupo porque la agrupación falló). Idempotente: se puede correr las veces que sea.
 */
import { and, asc, inArray, isNotNull, isNull } from 'drizzle-orm';
import { validateEnv } from '../config/env';
import { DbService } from '../db/db.service';
import { alert } from '../db/schema';
import { IncidentsService } from '../incidents/incidents.service';
import { loadEnvFiles } from './load-env';

async function main() {
  loadEnvFiles();
  const dbs = new DbService(validateEnv(process.env));
  const incidents = new IncidentsService(dbs);
  try {
    // Por orden de llegada: la primera de cada situación abre el incidente, las siguientes se suman.
    const pending = await dbs.asSystem((tx) =>
      tx
        .select({ id: alert.id })
        .from(alert)
        .where(
          and(isNull(alert.incidentId), isNotNull(alert.tenantId), inArray(alert.status, ['PENDING', 'ACKNOWLEDGED', 'DISPATCHED'])),
        )
        .orderBy(asc(alert.createdAt)),
    );
    let joined = 0;
    for (const { id } of pending) {
      const r = await incidents.attach(id);
      if (r?.joined) joined++;
    }
    console.log(`[incidentes] ${pending.length} alertas agrupadas; ${joined} se sumaron a un incidente existente`);
  } finally {
    await dbs.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
