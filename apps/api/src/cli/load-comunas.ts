/**
 * pnpm --filter @guardia/api load-comunas --geojson comunas.geojson [--srid 4326] [--simplify-m 10]
 *        [--cut-prop cod_comuna] [--name-prop Comuna] [--region-prop codregion] [--region-name-prop Region]
 *
 * Carga (o actualiza) la tabla nacional de comunas (migración 0006) desde un GeoJSON público, por
 * ejemplo la División Político Administrativa de la BCN o IDE Chile convertida a GeoJSON. Idempotente:
 * se puede correr de nuevo con una versión más nueva del archivo.
 *
 * - Las propiedades se detectan solas entre los nombres habituales (CUT/cod_comuna, NOM_COM/Comuna,
 *   cod_regi/REGION…); si el archivo usa otros, indícalos con --*-prop.
 * - Si el archivo no está en WGS84 (p. ej. UTM 19S, EPSG:32719), indica --srid y PostGIS lo reproyecta.
 * - Al final enlaza cada municipio de Guard-IA con su comuna por `tenant.cut_code`.
 * Usa DATABASE_ADMIN_URL: la app (guardia_app) solo puede leer esta tabla.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { comunaKey } from '@guardia/shared';
import { loadEnvFiles } from './load-env';

loadEnvFiles();

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const CANDIDATES = {
  cut: ['cut', 'CUT', 'cut_com', 'CUT_COM', 'cod_comuna', 'COD_COMUNA', 'codigo_comuna', 'cod_com', 'COD_COM'],
  name: ['comuna', 'Comuna', 'COMUNA', 'nom_com', 'NOM_COM', 'nombre', 'NOMBRE', 'nom_comuna', 'NOM_COMUNA'],
  regionCut: ['codregion', 'cod_regi', 'COD_REGI', 'cod_region', 'COD_REGION', 'cut_reg', 'CUT_REG', 'region_cut'],
  regionName: ['Region', 'region', 'REGION', 'nom_reg', 'NOM_REG', 'nom_region', 'NOM_REGION'],
} as const;

type Feature = { properties: Record<string, unknown> | null; geometry: { type: string } | null };

function pick(props: Record<string, unknown>, explicit: string | undefined, names: readonly string[]): unknown {
  if (explicit) return props[explicit];
  for (const n of names) if (props[n] !== undefined && props[n] !== null && props[n] !== '') return props[n];
  return undefined;
}

async function main() {
  const file = arg('geojson');
  if (!file) throw new Error('Indica el archivo: --geojson comunas.geojson');
  const srid = Number(arg('srid') ?? '4326');
  // Tolerancia de simplificación en metros (0 = sin simplificar). 10 m está bajo el error típico del GPS.
  const simplifyM = Number(arg('simplify-m') ?? '0');
  if (!Number.isFinite(simplifyM) || simplifyM < 0 || simplifyM > 200) throw new Error('--simplify-m debe estar entre 0 y 200');
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('Falta DATABASE_ADMIN_URL');

  const doc = JSON.parse(readFileSync(file, 'utf8')) as { type: string; features?: Feature[] };
  if (doc.type !== 'FeatureCollection' || !doc.features?.length) throw new Error('Se esperaba un FeatureCollection con comunas');

  const rows: { cut: number; name: string; key: string; regionCut: number; regionName: string; geometry: string }[] = [];
  const skipped: string[] = [];
  for (const [i, f] of doc.features.entries()) {
    const p = f.properties ?? {};
    const cut = Number(pick(p, arg('cut-prop'), CANDIDATES.cut));
    const name = String(pick(p, arg('name-prop'), CANDIDATES.name) ?? '').trim();
    if (!Number.isInteger(cut) || cut < 1000 || cut > 99999 || !name || !f.geometry) {
      skipped.push(`#${i} (${name || 'sin nombre'}, cut ${String(cut)})`);
      continue;
    }
    // El CUT de la comuna empieza con el de la región: 13101 → región 13.
    const regionCut = Number(pick(p, arg('region-prop'), CANDIDATES.regionCut) ?? Math.floor(cut / 1000));
    const regionName = String(pick(p, arg('region-name-prop'), CANDIDATES.regionName) ?? `Región ${regionCut}`).trim();
    rows.push({ cut, name, key: comunaKey(name), regionCut, regionName, geometry: JSON.stringify(f.geometry) });
  }
  if (rows.length === 0) {
    throw new Error(`Ninguna comuna válida; revisa las propiedades (primer feature: ${JSON.stringify(doc.features[0].properties)})`);
  }

  const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      for (const r of rows) {
        // Polígono o multipolígono, en cualquier SRID → MultiPolygon WGS84 válido. Con --simplify-m se
        // simplifica en metros (UTM 19S) para que la búsqueda por comuna del trigger del SOS siga rápida.
        await tx`
          INSERT INTO comuna (cut, name, name_key, region_cut, region_name, boundary)
          VALUES (${r.cut}, ${r.name}, ${r.key}, ${r.regionCut}, ${r.regionName},
            ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(
              ST_SimplifyPreserveTopology(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(${r.geometry}), ${srid}), 32719), ${simplifyM}),
              4326)), 3))::geography)
          ON CONFLICT (cut) DO UPDATE SET name = EXCLUDED.name, name_key = EXCLUDED.name_key,
            region_cut = EXCLUDED.region_cut, region_name = EXCLUDED.region_name,
            boundary = EXCLUDED.boundary, updated_at = now()`;
      }
      // Trozos para el ruteo (migración 0007): se rehacen solo para las comunas recién cargadas.
      const cuts = rows.map((r) => r.cut);
      await tx`DELETE FROM comuna_part WHERE cut IN ${tx(cuts)}`;
      await tx`
        INSERT INTO comuna_part (cut, part)
        SELECT c.cut, ST_Subdivide(c.boundary::geometry, 256)::geography FROM comuna c WHERE c.cut IN ${tx(cuts)}`;
    });
    const linked = await sql<{ name: string; comuna: string }[]>`
      UPDATE tenant t SET comuna_cut = c.cut
        FROM comuna c
       WHERE t.comuna_cut IS NULL AND t.cut_code ~ '^[0-9]+$' AND t.cut_code::int = c.cut
      RETURNING t.name, c.name AS comuna`;
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM comuna`;
    console.log(`[comunas] ${rows.length} cargadas o actualizadas; ${n} en total en la base`);
    if (skipped.length) {
      console.log(`[comunas] ${skipped.length} omitidas (sin CUT o nombre): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}`);
    }
    for (const l of linked) console.log(`[comunas] ${l.name} → comuna ${l.comuna}`);
    const pending = await sql<{ name: string }[]>`SELECT name FROM tenant WHERE active AND comuna_cut IS NULL`;
    if (pending.length) {
      console.log(`[comunas] municipios sin comuna (fija tenant.cut_code con el CUT y vuelve a correr): ${pending.map((p) => p.name).join(', ')}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
