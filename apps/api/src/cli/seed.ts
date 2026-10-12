/**
 * pnpm seed  (node dist/cli/seed.js en producción) [--geojson ruta.geojson] [--name "Municipalidad de X"] [--slug x]
 *
 * Crea (idempotente) el municipio demo con su polígono, dos operadores y tres unidades.
 * Sin --geojson usa un rectángulo que cubre el Gran Santiago, suficiente para el simulador.
 * Para un municipio real: exportar el límite comunal (IDE Chile / INE) a GeoJSON y pasarlo.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { hash } from '@node-rs/argon2';
import { loadEnvFiles } from './load-env';

const DEFAULT_BOUNDARY = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-70.9, -33.7],
        [-70.45, -33.7],
        [-70.45, -33.3],
        [-70.9, -33.3],
        [-70.9, -33.7],
      ],
    ],
  ],
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadGeoJson(path: string): unknown {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const geom =
    doc.type === 'FeatureCollection' ? doc.features?.[0]?.geometry : doc.type === 'Feature' ? doc.geometry : doc;
  if (!geom) throw new Error('GeoJSON sin geometría');
  if (geom.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [geom.coordinates] };
  if (geom.type !== 'MultiPolygon') throw new Error(`Geometría ${geom.type} no soportada`);
  return geom;
}

async function main() {
  loadEnvFiles();
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('Falta DATABASE_ADMIN_URL');
  const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });

  const name = arg('name') ?? 'Municipio Demo';
  const slug = arg('slug') ?? 'demo';
  const geo = arg('geojson') ? loadGeoJson(arg('geojson')!) : DEFAULT_BOUNDARY;
  const password = process.env.SEED_OPERATOR_PASSWORD ?? 'Demo1234!';

  try {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO tenant (name, slug, boundary, settings)
      VALUES (${name}, ${slug}, ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(geo)}))::geography, '{}'::jsonb)
      ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name, boundary = EXCLUDED.boundary
      RETURNING id`;
    console.log(`[seed] tenant ${name} (${slug}) → ${t.id}`);

    const pw = await hash(password);
    const operators = [
      { email: `admin@${slug}.guardia.cl`, name: 'Administrador Demo', role: 'ADMIN' },
      { email: `operador@${slug}.guardia.cl`, name: 'Operador Demo', role: 'OPERATOR' },
    ];
    for (const o of operators) {
      await sql`
        INSERT INTO operator (tenant_id, email, password_hash, name, role)
        VALUES (${t.id}, ${o.email}, ${pw}, ${o.name}, ${o.role}::operator_role)
        ON CONFLICT (email) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, role = EXCLUDED.role`;
      console.log(`[seed] operador ${o.email} (${o.role}); contraseña = SEED_OPERATOR_PASSWORD`);
    }

    const units = [
      { code: 'PATRULLA-101', kind: 'PATRULLA' },
      { code: 'PATRULLA-102', kind: 'PATRULLA' },
      { code: 'MOTO-201', kind: 'MOTO' },
      { code: 'INSPECTOR-301', kind: 'INSPECTOR' },
    ];
    for (const u of units) {
      await sql`
        INSERT INTO unit (tenant_id, code, kind, status)
        VALUES (${t.id}, ${u.code}, ${u.kind}::unit_kind, 'AVAILABLE')
        ON CONFLICT (tenant_id, code) DO NOTHING`;
    }
    console.log(`[seed] unidades: ${units.map((u) => u.code).join(', ')}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
