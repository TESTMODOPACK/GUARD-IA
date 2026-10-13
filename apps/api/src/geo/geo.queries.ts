import { sql } from 'drizzle-orm';
import { NEAR_BOUNDARY_MIN_M, comunaKey, type GeoContext } from '@guardia/shared';
import type { Tx } from '../db/db.service';
import type { AlertRow } from '../db/schema';

/**
 * Consultas de georreferencia (migración 0006). Reciben la transacción ya contextualizada; `comuna`
 * es referencia nacional (sin RLS) y `tenant` se lee solo por id y nombre.
 */

const point = (row: Pick<AlertRow, 'lat' | 'lng'>) => sql`ST_SetSRID(ST_MakePoint(${row.lng}, ${row.lat}), 4326)::geography`;

/** Igual que comunaKey() de shared, en SQL, para comparar con el nombre del municipio. */
// Los demás municipios se leen por tenant_directory (0009): la RLS de tenant solo deja ver el propio.
const TENANT_KEY = sql.raw(String.raw`btrim(regexp_replace(regexp_replace(regexp_replace(
  translate(lower(t.name), 'áéíóúüñ', 'aeiouun'),
  '^(i\.?\s*)?(ilustre\s+)?(municipalidad|comuna|municipio)\s+de\s+', ''),
  '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'))`);

export interface MentionedComuna {
  name: string;
  cut: number | null;
  tenantId: string | null;
  tenantName: string | null;
  /** Distancia del GPS del vecino a esa comuna (0 si está dentro). */
  distanceM: number | null;
}

/**
 * La comuna que nombra el vecino y el municipio de Guard-IA que la atiende. Primero en la tabla
 * nacional de comunas (la más cercana si el nombre se repite); si no está cargada, por el nombre del
 * municipio. Null si no se reconoce.
 */
export async function resolveMentionedComuna(
  tx: Tx,
  name: string,
  row: Pick<AlertRow, 'lat' | 'lng'>,
): Promise<MentionedComuna | null> {
  const key = comunaKey(name);
  if (key.length < 2) return null;
  // Distancia por los trozos (migración 0007) y solo hasta 50 km: las comunas australes tienen
  // cientos de miles de vértices. Más lejos que eso la distancia queda null ("lejos").
  const [c] = (await tx.execute(sql`
    SELECT c.cut, c.name, t.id AS tenant_id, t.name AS tenant_name,
           (SELECT round(min(ST_Distance(p.part, ${point(row)})))::int
              FROM comuna_part p
             WHERE p.cut = c.cut AND ST_DWithin(p.part, ${point(row)}, 50000)) AS distance_m
      FROM comuna c
      LEFT JOIN tenant_directory t ON t.comuna_cut = c.cut AND t.active
     WHERE c.name_key = ${key}
     ORDER BY distance_m NULLS LAST
     LIMIT 1`)) as unknown as {
    cut: number;
    name: string;
    tenant_id: string | null;
    tenant_name: string | null;
    distance_m: number | null;
  }[];
  if (c) return { name: c.name, cut: c.cut, tenantId: c.tenant_id, tenantName: c.tenant_name, distanceM: c.distance_m };

  const [t] = (await tx.execute(sql`
    SELECT t.id, t.name, round(ST_Distance(t.boundary, ${point(row)}))::int AS distance_m
      FROM tenant_directory t
     WHERE t.active AND ${TENANT_KEY} = ${key}
     LIMIT 1`)) as unknown as { id: string; name: string; distance_m: number }[];
  return t ? { name, cut: null, tenantId: t.id, tenantName: t.name, distanceM: t.distance_m } : null;
}

/** Otros municipios de Guard-IA dentro del margen de error del GPS (vecino en el límite comunal). */
export async function nearbyTenants(tx: Tx, row: Pick<AlertRow, 'lat' | 'lng' | 'accuracyM' | 'tenantId'>) {
  const margin = Math.max(NEAR_BOUNDARY_MIN_M, Math.min(2000, row.accuracyM ?? 0));
  // Municipios enlazados a una comuna: por los trozos de la comuna (rápido). Sin comuna: por su polígono.
  const rows = (await tx.execute(sql`
    WITH near AS (
      SELECT p.cut, min(ST_Distance(p.part, ${point(row)})) AS d
        FROM comuna_part p
       WHERE ST_DWithin(p.part, ${point(row)}, ${margin})
       GROUP BY p.cut
    ), candidates AS (
      SELECT t.id, near.d FROM near JOIN tenant_directory t ON t.comuna_cut = near.cut AND t.active
      UNION ALL
      SELECT t.id, ST_Distance(t.boundary, ${point(row)})
        FROM tenant_directory t
       WHERE t.active AND t.comuna_cut IS NULL AND ST_DWithin(t.boundary, ${point(row)}, ${margin})
    )
    SELECT t.id, t.name, round(min(c.d))::int AS distance_m
      FROM candidates c JOIN tenant_directory t ON t.id = c.id
     WHERE t.id IS DISTINCT FROM ${row.tenantId}::uuid
     GROUP BY t.id, t.name
     ORDER BY distance_m
     LIMIT 3`)) as unknown as { id: string; name: string; distance_m: number }[];
  return rows.map((r) => ({ tenantId: r.id, tenantName: r.name, distanceM: r.distance_m }));
}

export async function comunaName(tx: Tx, cut: number | null): Promise<string | null> {
  if (cut === null) return null;
  const [c] = (await tx.execute(sql`SELECT name FROM comuna WHERE cut = ${cut}`)) as unknown as { name: string }[];
  return c?.name ?? null;
}

/** Contexto geográfico de la ficha: comuna del GPS, comuna mencionada (si es otra) y vecinos. */
export async function geoContext(tx: Tx, row: AlertRow): Promise<GeoContext> {
  const name = await comunaName(tx, row.comunaCut);
  const said = row.aiTriage?.location?.comuna ?? null;
  let mentioned: MentionedComuna | null = null;
  if (said) {
    const m = await resolveMentionedComuna(tx, said, row);
    // Si nombra su propia comuna no hay nada que avisar.
    const same = m && ((m.cut !== null && m.cut === row.comunaCut) || (m.tenantId !== null && m.tenantId === row.tenantId));
    mentioned = same ? null : (m ?? { name: said, cut: null, tenantId: null, tenantName: null, distanceM: null });
  }
  return {
    comuna: row.comunaCut !== null && name ? { cut: row.comunaCut, name } : null,
    mentioned,
    nearby: await nearbyTenants(tx, row),
  };
}
