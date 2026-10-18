import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
  AuthorizeSubprocessor,
  CreateIncident,
  CreateSubprocessor,
  SecurityIncident,
  Subprocessor,
  SubprocessorAuthorization,
  UpdateIncident,
  UpdateSubprocessor,
} from '@guardia/shared';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { securityIncident, securityIncidentTenant, subprocessor, tenant, tenantSubprocessor } from '../db/schema';
import { authorizationsOf, incidentsForPlatform } from '../legal/compliance.queries';
import { LegalService } from '../legal/legal.service';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformClaims } from './platform-tokens.service';

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}

/**
 * Ley 21.719, etapa 1 en la consola (0014). Subencargados: el catálogo de Guard-IA y la autorización escrita de cada
 * municipio (art. 15 bis); revocarla corta el envío al proveedor desde ese momento (el worker lo consulta).
 * Incidentes: registro de Guard-IA y aviso a cada municipio afectado (art. 14 sexies y 15 bis). Todo en contexto
 * platform, con platform_audit_log y, si toca un municipio, también su audit_log, en la misma transacción.
 */
@Injectable()
export class PlatformComplianceService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: PlatformAuditService,
    private readonly legal: LegalService,
  ) {}

  // ------------------------------------------------------------------ subencargados

  subprocessors(user: PlatformClaims): Promise<Subprocessor[]> {
    return this.dbs.asPlatform(user.sub, async (tx) => {
      const rows = await tx
        .select({
          s: subprocessor,
          // Calificada a mano: dentro del select, Drizzle escribe la columna como "id" y la subconsulta la tomaría como
          // ts.id.
          authorized: sql<number>`(SELECT count(*)::int FROM tenant_subprocessor ts
                                     WHERE ts.subprocessor_id = "subprocessor"."id" AND ts.revoked_at IS NULL)`,
        })
        .from(subprocessor)
        .orderBy(asc(subprocessor.service), asc(subprocessor.name));
      return rows.map(({ s, authorized }) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        service: s.service,
        country: s.country,
        dataCategories: s.dataCategories,
        guarantee: s.guarantee,
        inUse: s.inUse,
        authorizedTenants: authorized,
      }));
    });
  }

  async createSubprocessor(user: PlatformClaims, body: CreateSubprocessor, ip: string): Promise<Subprocessor[]> {
    try {
      await this.dbs.asPlatform(user.sub, async (tx) => {
        const [s] = await tx
          .insert(subprocessor)
          .values({ ...body, guarantee: body.guarantee ?? null })
          .returning({ id: subprocessor.id });
        await this.audit.record(tx, {
          actorId: user.sub,
          action: 'SUBPROCESSOR_CREATED',
          targetId: s.id,
          payload: { key: body.key, name: body.name, service: body.service, country: body.country, inUse: body.inUse },
          ip,
        });
      });
    } catch (e) {
      if (pgCode(e) === '23505') throw new AppError('CONFLICT', 'Ya existe un subencargado con esa clave');
      throw e;
    }
    this.legal.invalidate();
    return this.subprocessors(user);
  }

  async updateSubprocessor(user: PlatformClaims, id: string, body: UpdateSubprocessor, ip: string): Promise<Subprocessor[]> {
    await this.dbs.asPlatform(user.sub, async (tx) => {
      const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      const [s] = await tx.update(subprocessor).set(set).where(eq(subprocessor.id, id)).returning({ key: subprocessor.key });
      if (!s) throw new AppError('NOT_FOUND', 'Subencargado no encontrado');
      await this.audit.record(tx, { actorId: user.sub, action: 'SUBPROCESSOR_UPDATED', targetId: id, payload: { key: s.key, ...set }, ip });
    });
    this.legal.invalidate();
    return this.subprocessors(user);
  }

  /** Registra la autorización escrita del municipio. El documento lo firma el municipio; aquí queda dónde consta. */
  async authorize(user: PlatformClaims, tenantId: string, body: AuthorizeSubprocessor, ip: string): Promise<SubprocessorAuthorization[]> {
    const out = await this.dbs.asPlatform(user.sub, async (tx) => {
      await this.requireTenant(tx, tenantId);
      const [s] = await tx.select().from(subprocessor).where(eq(subprocessor.id, body.subprocessorId)).limit(1);
      if (!s) throw new AppError('NOT_FOUND', 'Subencargado no encontrado');
      const [dup] = await tx
        .select({ id: tenantSubprocessor.id })
        .from(tenantSubprocessor)
        .where(
          and(
            eq(tenantSubprocessor.tenantId, tenantId),
            eq(tenantSubprocessor.subprocessorId, s.id),
            isNull(tenantSubprocessor.revokedAt),
          ),
        )
        .limit(1);
      if (dup) throw new AppError('CONFLICT', `${s.name} ya está autorizado para este municipio`);
      const [a] = await tx
        .insert(tenantSubprocessor)
        .values({ tenantId, ...body, createdBy: user.sub })
        .returning({ id: tenantSubprocessor.id });
      const payload = { subprocessor: s.name, key: s.key, authorizedAt: body.authorizedAt, documentRef: body.documentRef };
      await this.audit.record(tx, { actorId: user.sub, action: 'SUBPROCESSOR_AUTHORIZED', tenantId, targetId: a.id, payload, ip });
      await this.audit.recordInTenant(tx, { tenantId, platformActorId: user.sub, kind: 'SUBPROCESSOR_AUTHORIZED', targetId: a.id, payload });
      return authorizationsOf(tx, tenantId);
    });
    this.legal.invalidate();
    return out;
  }

  async revoke(user: PlatformClaims, tenantId: string, authorizationId: string, ip: string): Promise<SubprocessorAuthorization[]> {
    const out = await this.dbs.asPlatform(user.sub, async (tx) => {
      const [a] = await tx
        .update(tenantSubprocessor)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(tenantSubprocessor.id, authorizationId),
            eq(tenantSubprocessor.tenantId, tenantId),
            isNull(tenantSubprocessor.revokedAt),
          ),
        )
        .returning({ subprocessorId: tenantSubprocessor.subprocessorId });
      if (!a) throw new AppError('NOT_FOUND', 'Autorización no encontrada');
      const [s] = await tx
        .select({ name: subprocessor.name, key: subprocessor.key })
        .from(subprocessor)
        .where(eq(subprocessor.id, a.subprocessorId));
      const payload = { subprocessor: s?.name ?? null, key: s?.key ?? null };
      await this.audit.record(tx, { actorId: user.sub, action: 'SUBPROCESSOR_REVOKED', tenantId, targetId: authorizationId, payload, ip });
      await this.audit.recordInTenant(tx, { tenantId, platformActorId: user.sub, kind: 'SUBPROCESSOR_REVOKED', targetId: authorizationId, payload });
      return authorizationsOf(tx, tenantId);
    });
    this.legal.invalidate();
    return out;
  }

  // ------------------------------------------------------------------ incidentes

  incidents(user: PlatformClaims): Promise<SecurityIncident[]> {
    return this.dbs.asPlatform(user.sub, (tx) => incidentsForPlatform(tx));
  }

  async createIncident(user: PlatformClaims, body: CreateIncident, ip: string): Promise<SecurityIncident> {
    return this.dbs.asPlatform(user.sub, async (tx) => {
      const { tenantIds, ...fields } = body;
      const [i] = await tx
        .insert(securityIncident)
        .values({
          ...fields,
          detectedAt: new Date(fields.detectedAt),
          startedAt: fields.startedAt ? new Date(fields.startedAt) : null,
          affectedEstimate: fields.affectedEstimate ?? null,
          measures: fields.measures ?? null,
          createdBy: user.sub,
        })
        .returning({ id: securityIncident.id, number: securityIncident.number });
      await this.audit.record(tx, {
        actorId: user.sub,
        action: 'INCIDENT_OPENED',
        targetId: i.id,
        payload: { number: i.number, nature: fields.nature, sensitiveData: fields.sensitiveData, tenants: tenantIds.length },
        ip,
      });
      for (const tenantId of new Set(tenantIds)) await this.notifyInTx(tx, user, i.id, i.number, tenantId, ip);
      const [out] = await incidentsForPlatform(tx, [i.id]);
      return out;
    });
  }

  async updateIncident(user: PlatformClaims, id: string, body: UpdateIncident, ip: string): Promise<SecurityIncident> {
    return this.dbs.asPlatform(user.sub, async (tx) => {
      const [cur] = await tx.select().from(securityIncident).where(eq(securityIncident.id, id)).for('update').limit(1);
      if (!cur) throw new AppError('NOT_FOUND', 'Incidente no encontrado');
      const set: Partial<typeof securityIncident.$inferInsert> = {};
      if (body.startedAt !== undefined) set.startedAt = body.startedAt ? new Date(body.startedAt) : null;
      if (body.summary !== undefined) set.summary = body.summary;
      if (body.dataCategories !== undefined) set.dataCategories = body.dataCategories;
      if (body.affectedEstimate !== undefined) set.affectedEstimate = body.affectedEstimate;
      if (body.sensitiveData !== undefined) set.sensitiveData = body.sensitiveData;
      if (body.measures !== undefined) set.measures = body.measures;
      if (body.status !== undefined && body.status !== cur.status) {
        if (body.status === 'CLOSED' && !(body.measures ?? cur.measures)) {
          throw new AppError('VALIDATION_ERROR', 'Para cerrar el incidente, registra las medidas adoptadas');
        }
        set.status = body.status;
        set.closedAt = body.status === 'CLOSED' ? new Date() : null;
      }
      if (set.startedAt && set.startedAt > cur.detectedAt) {
        throw new AppError('VALIDATION_ERROR', 'El inicio no puede ser posterior a la detección');
      }
      if (Object.keys(set).length === 0) throw new AppError('VALIDATION_ERROR', 'Nada que cambiar');
      await tx.update(securityIncident).set(set).where(eq(securityIncident.id, id));
      await this.audit.record(tx, {
        actorId: user.sub,
        action: 'INCIDENT_UPDATED',
        targetId: id,
        payload: { number: cur.number, fields: Object.keys(set), status: set.status ?? cur.status },
        ip,
      });
      const [out] = await incidentsForPlatform(tx, [id]);
      return out;
    });
  }

  /** Guard-IA avisa a un municipio afectado (art. 15 bis): queda en su bitácora y en su «Privacidad». */
  async notifyTenant(user: PlatformClaims, id: string, tenantId: string, ip: string): Promise<SecurityIncident> {
    return this.dbs.asPlatform(user.sub, async (tx) => {
      const [cur] = await tx
        .select({ number: securityIncident.number })
        .from(securityIncident)
        .where(eq(securityIncident.id, id))
        .limit(1);
      if (!cur) throw new AppError('NOT_FOUND', 'Incidente no encontrado');
      await this.notifyInTx(tx, user, id, cur.number, tenantId, ip);
      const [out] = await incidentsForPlatform(tx, [id]);
      return out;
    });
  }

  private async notifyInTx(tx: Tx, user: PlatformClaims, incidentId: string, number: number, tenantId: string, ip: string) {
    await this.requireTenant(tx, tenantId);
    const [link] = await tx
      .insert(securityIncidentTenant)
      .values({ incidentId, tenantId })
      .onConflictDoNothing()
      .returning({ tenantId: securityIncidentTenant.tenantId });
    if (!link) throw new AppError('CONFLICT', 'Ese municipio ya fue avisado de este incidente');
    await this.audit.record(tx, { actorId: user.sub, action: 'INCIDENT_TENANT_NOTIFIED', tenantId, targetId: incidentId, payload: { number }, ip });
    await this.audit.recordInTenant(tx, {
      tenantId,
      platformActorId: user.sub,
      kind: 'INCIDENT_NOTIFIED',
      targetId: incidentId,
      payload: { number },
    });
  }

  private async requireTenant(tx: Tx, tenantId: string) {
    const [t] = await tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.id, tenantId)).limit(1);
    if (!t) throw new AppError('NOT_FOUND', 'Municipio no encontrado');
  }
}
