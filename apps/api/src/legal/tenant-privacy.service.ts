import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { RecordIncidentReport, TenantPrivacyOverview, UpdateTenantPrivacy } from '@guardia/shared';
import { AuditService } from '../auth/audit.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { DbService } from '../db/db.service';
import { securityIncidentTenant, tenantPrivacy } from '../db/schema';
import { authorizationsOf, incidentsForTenant, missingSubprocessorsOf, privacyOf } from './compliance.queries';

/**
 * «Privacidad» de la central (0014): el municipio es el responsable. Su administrador fija el contacto para que los
 * vecinos ejerzan sus derechos, ve qué subencargados autorizó y registra su reporte a la Agencia y el aviso a los
 * vecinos de cada incidente que Guard-IA le informó. Todo con audit_log en la misma transacción.
 */
@Injectable()
export class TenantPrivacyService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  overview(op: OperatorClaims): Promise<TenantPrivacyOverview> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => ({
      privacy: await privacyOf(tx, op.tenantId),
      subprocessors: await authorizationsOf(tx, op.tenantId),
      missingSubprocessors: await missingSubprocessorsOf(tx, op.tenantId),
      incidents: await incidentsForTenant(tx, op.tenantId),
    }));
  }

  async update(op: OperatorClaims, body: UpdateTenantPrivacy): Promise<TenantPrivacyOverview> {
    await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const values = {
        contactEmail: body.contactEmail.toLowerCase(),
        contactAddress: body.contactAddress ?? null,
        dpoName: body.dpoName ?? null,
        dpoEmail: body.dpoEmail?.toLowerCase() ?? null,
        policyUrl: body.policyUrl ?? null,
        policyVersion: body.policyVersion ?? null,
        updatedBy: op.sub,
        updatedAt: new Date(),
      };
      await tx
        .insert(tenantPrivacy)
        .values({ tenantId: op.tenantId, ...values })
        .onConflictDoUpdate({ target: tenantPrivacy.tenantId, set: values });
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'PRIVACY_CONTACT_UPDATED',
        payload: { contactEmail: values.contactEmail, dpo: !!values.dpoName, policyVersion: values.policyVersion },
      });
    });
    return this.overview(op);
  }

  async recordReport(op: OperatorClaims, incidentId: string, body: RecordIncidentReport): Promise<TenantPrivacyOverview> {
    await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const where = and(eq(securityIncidentTenant.incidentId, incidentId), eq(securityIncidentTenant.tenantId, op.tenantId));
      const [link] = await tx.select().from(securityIncidentTenant).where(where).for('update').limit(1);
      if (!link) throw new AppError('NOT_FOUND', 'Incidente no encontrado');
      const agency = body.agencyReportedAt !== undefined || body.agencyRef !== undefined;
      const subjects = body.subjectsNotifiedAt !== undefined || body.subjectsNote !== undefined;
      await tx
        .update(securityIncidentTenant)
        .set({
          ...(body.agencyReportedAt !== undefined ? { agencyReportedAt: toDate(body.agencyReportedAt) } : {}),
          ...(body.agencyRef !== undefined ? { agencyRef: body.agencyRef } : {}),
          ...(body.subjectsNotifiedAt !== undefined ? { subjectsNotifiedAt: toDate(body.subjectsNotifiedAt) } : {}),
          ...(body.subjectsNote !== undefined ? { subjectsNote: body.subjectsNote } : {}),
        })
        .where(where);
      if (agency) {
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'INCIDENT_AGENCY_REPORTED',
          targetId: incidentId,
          payload: { reportedAt: body.agencyReportedAt ?? null, ref: body.agencyRef ?? null },
        });
      }
      if (subjects) {
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'INCIDENT_SUBJECTS_NOTIFIED',
          targetId: incidentId,
          payload: { notifiedAt: body.subjectsNotifiedAt ?? null, note: body.subjectsNote ?? null },
        });
      }
    });
    return this.overview(op);
  }
}

function toDate(v: string | null | undefined): Date | null {
  return v ? new Date(v) : null;
}
