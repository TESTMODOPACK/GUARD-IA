import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  COMUNA_SERVICE_STATUSES,
  type ComunaMap,
  type ComunaRow,
  type ComunaServiceStatus,
  type RegionDetail,
  type RegionSummary,
} from '@guardia/shared';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';

/** Ventana de "este mes" en la consola: 30 días corridos. */
const MONTH = sql`now() - interval '30 days'`;

interface ComunaSqlRow {
  cut: number;
  name: string;
  region_cut: number;
  region_name: string;
  provincia_cut: number;
  provincia_name: string;
  status: ComunaServiceStatus;
  tenant_id: string | null;
  tenant_name: string | null;
  alerts: number;
  open_alerts: number;
  unserved_sos: number;
  unserved_reports: number;
}

type RegionRow = { cut: number; name: string; roman: string; sort_order: number };
type Geometry = ComunaMap['features'][number]['geometry'];

/**
 * Comunas con el estado de su municipio y sus cifras del mes. El municipio vigente manda; si no hay uno
 * vigente pero hubo uno de baja, la comuna figura "de baja"; si nunca hubo, "disponible". Las cifras salen de
 * las funciones SECURITY DEFINER de 0010 (solo conteos).
 */
function comunaRows(where: SQL): SQL {
  return sql`
    WITH act AS (SELECT * FROM platform_tenant_activity(${MONTH})),
         uns AS (SELECT * FROM platform_unserved(${MONTH}))
    SELECT c.cut, c.name, c.region_cut, r.name AS region_name, c.provincia_cut, p.name AS provincia_name,
           COALESCE(t.status::text, 'AVAILABLE') AS status, t.id AS tenant_id, t.name AS tenant_name,
           COALESCE(act.alerts, 0)::int AS alerts, COALESCE(act.open_alerts, 0)::int AS open_alerts,
           COALESCE(uns.sos, 0)::int AS unserved_sos, COALESCE(uns.reports, 0)::int AS unserved_reports
      FROM comuna c
      JOIN region r ON r.cut = c.region_cut
      JOIN provincia p ON p.cut = c.provincia_cut
      LEFT JOIN LATERAL (
        SELECT t.id, t.name, t.status FROM tenant t
         WHERE t.comuna_cut = c.cut
         ORDER BY (t.status = 'TERMINATED'), t.status_changed_at DESC
         LIMIT 1) t ON true
      LEFT JOIN act ON act.tenant_id = t.id
      LEFT JOIN uns ON uns.comuna_cut = c.cut
     WHERE ${where}
     ORDER BY p.name, c.name`;
}

function toComunaRow(r: ComunaSqlRow): ComunaRow {
  return {
    cut: r.cut,
    name: r.name,
    regionCut: r.region_cut,
    regionName: r.region_name,
    provinciaCut: r.provincia_cut,
    provinciaName: r.provincia_name,
    status: r.status,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    alertsMonth: r.alerts,
    openAlerts: r.open_alerts,
    unservedSos: r.unserved_sos,
    unservedReports: r.unserved_reports,
  };
}

function summarize(region: RegionRow, comunas: ComunaRow[]): RegionSummary {
  const byStatus = Object.fromEntries(COMUNA_SERVICE_STATUSES.map((s) => [s, 0])) as Record<ComunaServiceStatus, number>;
  let alertsMonth = 0;
  let unservedMonth = 0;
  for (const c of comunas) {
    byStatus[c.status] += 1;
    alertsMonth += c.alertsMonth;
    unservedMonth += c.unservedSos + c.unservedReports;
  }
  return {
    cut: region.cut,
    name: region.name,
    roman: region.roman,
    sortOrder: region.sort_order,
    comunas: comunas.length,
    byStatus,
    alertsMonth,
    unservedMonth,
  };
}

/** "Ñuñoa" → "nunoa", como comuna.name_key. */
export function nameKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class TerritoryService {
  /** Geometrías simplificadas por región y nacional: no cambian salvo al recargar comunas (reiniciar la API). */
  private readonly geomCache = new Map<string, Map<number, { name: string; geometry: Geometry }>>();

  constructor(private readonly dbs: DbService) {}

  private async comunas(tx: Tx, where: SQL): Promise<ComunaRow[]> {
    const rows = (await tx.execute(comunaRows(where))) as unknown as ComunaSqlRow[];
    return rows.map(toComunaRow);
  }

  /** Las 16 regiones de norte a sur con su resumen (RF-1.1). */
  regions(userId: string): Promise<RegionSummary[]> {
    return this.dbs.asPlatform(userId, async (tx) => {
      const regions = (await tx.execute(
        sql`SELECT cut, name, roman, sort_order FROM region ORDER BY sort_order`,
      )) as unknown as RegionRow[];
      const all = await this.comunas(tx, sql`true`);
      return regions.map((r) => summarize(r, all.filter((c) => c.regionCut === r.cut)));
    });
  }

  region(userId: string, cut: number): Promise<RegionDetail> {
    return this.dbs.asPlatform(userId, async (tx) => {
      const [r] = (await tx.execute(
        sql`SELECT cut, name, roman, sort_order FROM region WHERE cut = ${cut}`,
      )) as unknown as RegionRow[];
      if (!r) throw new AppError('NOT_FOUND', 'Región no encontrada');
      const provincias = (await tx.execute(
        sql`SELECT cut, name FROM provincia WHERE region_cut = ${cut} ORDER BY name`,
      )) as unknown as { cut: number; name: string }[];
      const comunas = await this.comunas(tx, sql`c.region_cut = ${cut}`);
      return { region: summarize(r, comunas), provincias, comunas };
    });
  }

  /** Búsqueda nacional por nombre (sin tildes) o CUT (RF-1.3). */
  search(userId: string, q: string): Promise<ComunaRow[]> {
    const digits = /^\d{4,5}$/.test(q) ? Number(q) : null;
    return this.dbs.asPlatform(userId, async (tx) => {
      const where = digits !== null ? sql`c.cut = ${digits}` : sql`c.name_key LIKE ${'%' + nameKey(q) + '%'}`;
      return (await this.comunas(tx, where)).slice(0, 30);
    });
  }

  /**
   * Mapa coloreado por estado (RF-1.2). Región: límite simplificado (~300 m). Nacional: simplificado otra
   * vez a ~2 km para que el país entero pese poco.
   */
  map(userId: string, regionCut: number | null): Promise<ComunaMap> {
    return this.dbs.asPlatform(userId, async (tx) => {
      const cacheKey = regionCut === null ? 'cl' : String(regionCut);
      let geoms = this.geomCache.get(cacheKey);
      if (!geoms) {
        const g = regionCut === null ? sql`ST_SimplifyPreserveTopology(c.boundary_simple, 0.02)` : sql`c.boundary_simple`;
        const rows = (await tx.execute(sql`
          SELECT c.cut, c.name, ST_AsGeoJSON(ST_Multi(${g}), ${regionCut === null ? 3 : 4})::json AS geometry
            FROM comuna c
           WHERE ${regionCut === null ? sql`true` : sql`c.region_cut = ${regionCut}`}`)) as unknown as {
          cut: number;
          name: string;
          geometry: Geometry;
        }[];
        if (regionCut !== null && rows.length === 0) throw new AppError('NOT_FOUND', 'Región no encontrada');
        geoms = new Map(rows.map((r) => [r.cut, { name: r.name, geometry: r.geometry }]));
        this.geomCache.set(cacheKey, geoms);
      }
      const statuses = (await tx.execute(sql`
        SELECT DISTINCT ON (t.comuna_cut) t.comuna_cut AS cut, t.status::text AS status
          FROM tenant t
         WHERE t.comuna_cut IS NOT NULL
         ORDER BY t.comuna_cut, (t.status = 'TERMINATED'), t.status_changed_at DESC`)) as unknown as {
        cut: number;
        status: ComunaServiceStatus;
      }[];
      const byCut = new Map(statuses.map((s) => [s.cut, s.status]));
      return {
        type: 'FeatureCollection',
        features: [...geoms.entries()].map(([cut, g]) => ({
          type: 'Feature',
          geometry: g.geometry,
          properties: { cut, name: g.name, status: byCut.get(cut) ?? 'AVAILABLE' },
        })),
      };
    });
  }
}
