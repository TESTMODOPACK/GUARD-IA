import { and, asc, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type {
  IncidentTenant,
  SecurityIncident,
  SubprocessorAuthorization,
  SubprocessorService,
  TenantIncident,
  TenantPrivacy,
} from '@guardia/shared';
import type { Tx } from '../db/db.service';
import {
  securityIncident,
  securityIncidentTenant,
  subprocessor,
  tenant,
  tenantPrivacy,
  tenantSubprocessor,
} from '../db/schema';

/**
 * Lecturas de Ley 21.719 (0014) que comparten la central (contexto operator, solo su municipio) y la consola
 * (contexto platform). Cada una corre dentro de la transacción de quien llama: la RLS decide qué filas ve.
 */

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export async function privacyOf(tx: Tx, tenantId: string): Promise<TenantPrivacy | null> {
  const [p] = await tx.select().from(tenantPrivacy).where(eq(tenantPrivacy.tenantId, tenantId)).limit(1);
  if (!p) return null;
  return {
    contactEmail: p.contactEmail,
    contactAddress: p.contactAddress,
    dpoName: p.dpoName,
    dpoEmail: p.dpoEmail,
    policyUrl: p.policyUrl,
    policyVersion: p.policyVersion,
    updatedAt: iso(p.updatedAt),
  };
}

/** Autorizaciones vigentes del municipio, por servicio y nombre. */
export async function authorizationsOf(tx: Tx, tenantId: string): Promise<SubprocessorAuthorization[]> {
  const rows = await tx
    .select({ a: tenantSubprocessor, s: subprocessor })
    .from(tenantSubprocessor)
    .innerJoin(subprocessor, eq(subprocessor.id, tenantSubprocessor.subprocessorId))
    .where(and(eq(tenantSubprocessor.tenantId, tenantId), isNull(tenantSubprocessor.revokedAt)))
    .orderBy(asc(subprocessor.service), asc(subprocessor.name));
  return rows.map(({ a, s }) => ({
    id: a.id,
    subprocessorId: s.id,
    key: s.key,
    name: s.name,
    service: s.service,
    country: s.country,
    inUse: s.inUse,
    authorizedAt: a.authorizedAt,
    authorizedBy: a.authorizedBy,
    documentRef: a.documentRef,
  }));
}

/** Subencargados en uso que el municipio aún no autoriza (bloquean la puesta en marcha). */
export async function missingSubprocessorsOf(
  tx: Tx,
  tenantId: string,
): Promise<{ name: string; service: SubprocessorService }[]> {
  return tx
    .select({ name: subprocessor.name, service: subprocessor.service })
    .from(subprocessor)
    .where(
      and(
        eq(subprocessor.inUse, true),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(tenantSubprocessor)
            .where(
              and(
                eq(tenantSubprocessor.subprocessorId, subprocessor.id),
                eq(tenantSubprocessor.tenantId, tenantId),
                isNull(tenantSubprocessor.revokedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(subprocessor.service), asc(subprocessor.name));
}

type IncidentRow = typeof securityIncident.$inferSelect;
type LinkRow = typeof securityIncidentTenant.$inferSelect;

function toIncidentTenant(l: LinkRow, tenantName: string): IncidentTenant {
  return {
    tenantId: l.tenantId,
    tenantName,
    notifiedAt: iso(l.notifiedAt),
    agencyReportedAt: isoOrNull(l.agencyReportedAt),
    agencyRef: l.agencyRef,
    subjectsNotifiedAt: isoOrNull(l.subjectsNotifiedAt),
    subjectsNote: l.subjectsNote,
  };
}

function incidentBase(i: IncidentRow) {
  return {
    id: i.id,
    number: i.number,
    detectedAt: iso(i.detectedAt),
    startedAt: isoOrNull(i.startedAt),
    nature: i.nature,
    summary: i.summary,
    dataCategories: i.dataCategories,
    affectedEstimate: i.affectedEstimate,
    sensitiveData: i.sensitiveData,
    measures: i.measures,
    status: i.status,
    closedAt: isoOrNull(i.closedAt),
    createdAt: iso(i.createdAt),
  };
}

/** Consola: incidentes con todos los municipios afectados (los abiertos primero). */
export async function incidentsForPlatform(tx: Tx, ids?: string[]): Promise<SecurityIncident[]> {
  const rows = await tx
    .select()
    .from(securityIncident)
    .where(ids ? inArray(securityIncident.id, ids) : undefined)
    .orderBy(desc(sql`${securityIncident.status} = 'OPEN'`), desc(securityIncident.detectedAt))
    .limit(200);
  if (rows.length === 0) return [];
  const links = await tx
    .select({ l: securityIncidentTenant, name: tenant.name })
    .from(securityIncidentTenant)
    .innerJoin(tenant, eq(tenant.id, securityIncidentTenant.tenantId))
    .where(inArray(securityIncidentTenant.incidentId, rows.map((r) => r.id)))
    .orderBy(asc(tenant.name));
  return rows.map((i) => ({
    ...incidentBase(i),
    detectedBy: i.detectedBy,
    tenants: links.filter((x) => x.l.incidentId === i.id).map((x) => toIncidentTenant(x.l, x.name)),
  }));
}

/** Central: solo los incidentes que afectan a su municipio, sin los otros municipios ni quién detectó en Guard-IA. */
export async function incidentsForTenant(tx: Tx, tenantId: string): Promise<TenantIncident[]> {
  const rows = await tx
    .select({ i: securityIncident, l: securityIncidentTenant, name: tenant.name })
    .from(securityIncidentTenant)
    .innerJoin(securityIncident, eq(securityIncident.id, securityIncidentTenant.incidentId))
    .innerJoin(tenant, eq(tenant.id, securityIncidentTenant.tenantId))
    .where(eq(securityIncidentTenant.tenantId, tenantId))
    .orderBy(desc(securityIncident.detectedAt))
    .limit(100);
  return rows.map(({ i, l, name }) => ({ ...incidentBase(i), tenant: toIncidentTenant(l, name) }));
}
