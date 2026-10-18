import { Injectable, Logger } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { CitizenEraseResult, CitizenExport } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { DbService } from '../db/db.service';
import {
  alert,
  alertEvent,
  citizen,
  citizenBlock,
  citizenReview,
  citizenStrike,
  consentNotice,
  consentRecord,
  device,
  media,
  tenant,
} from '../db/schema';
import { MediaService } from '../media/media.service';

/** Derechos ARCO del vecino (Ley 21.719): acceso (export) y supresión (anonimización). */
@Injectable()
export class PrivacyService {
  private readonly logger = new Logger(PrivacyService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly mediaSvc: MediaService,
  ) {}

  /** Todo lo del vecino, leído en su propio contexto (RLS citizen: solo ve lo suyo). */
  async export(citizenId: string): Promise<CitizenExport> {
    return this.dbs.asCitizen(citizenId, async (tx) => {
      const [c] = await tx.select().from(citizen).where(eq(citizen.id, citizenId)).limit(1);
      if (!c) throw new AppError('NOT_FOUND', 'Vecino no encontrado');
      const devices = await tx.select().from(device).where(eq(device.citizenId, citizenId));
      const alerts = await tx.select().from(alert).where(eq(alert.citizenId, citizenId)).orderBy(asc(alert.createdAt));
      const ids = alerts.map((a) => a.id);
      const files = ids.length ? await tx.select().from(media).where(inArray(media.alertId, ids)) : [];
      // Faltas por aviso falso: dato personal del vecino (derecho de acceso).
      const strikes = await tx
        .select({
          createdAt: citizenStrike.createdAt,
          expiresAt: citizenStrike.expiresAt,
          note: citizenStrike.note,
          annulledAt: citizenStrike.annulledAt,
          tenantName: tenant.name,
        })
        .from(citizenStrike)
        .innerJoin(tenant, eq(tenant.id, citizenStrike.tenantId))
        .where(eq(citizenStrike.citizenId, citizenId))
        .orderBy(asc(citizenStrike.createdAt));
      // Bloqueos y revisiones (0011): el nombre del municipio sale del directorio (0009).
      const blocks = await tx
        .select({ b: citizenBlock, municipality: sql<string>`(SELECT d.name FROM tenant_directory d WHERE d.id = ${citizenBlock.tenantId})` })
        .from(citizenBlock)
        .where(eq(citizenBlock.citizenId, citizenId))
        .orderBy(asc(citizenBlock.proposedAt));
      const reviews = await tx
        .select({ r: citizenReview, municipality: sql<string>`(SELECT d.name FROM tenant_directory d WHERE d.id = ${citizenReview.tenantId})` })
        .from(citizenReview)
        .where(eq(citizenReview.citizenId, citizenId))
        .orderBy(asc(citizenReview.createdAt));
      // Historial de consentimientos (0014): cada aceptación o revocación con la versión del aviso que vio.
      const consents = await tx
        .select({
          purpose: consentRecord.purpose,
          action: consentRecord.action,
          version: consentNotice.version,
          createdAt: consentRecord.createdAt,
        })
        .from(consentRecord)
        .innerJoin(consentNotice, eq(consentNotice.id, consentRecord.noticeId))
        .where(eq(consentRecord.citizenId, citizenId))
        .orderBy(asc(consentRecord.createdAt));
      const events = ids.length
        ? await tx
            .select({ alertId: alertEvent.alertId, kind: alertEvent.kind, createdAt: alertEvent.createdAt })
            .from(alertEvent)
            .where(inArray(alertEvent.alertId, ids))
            .orderBy(asc(alertEvent.createdAt))
        : [];

      return {
        exportedAt: new Date().toISOString(),
        citizen: {
          id: c.id,
          phone: c.phone,
          name: c.name,
          trustScore: c.trustScore,
          consentVersion: c.consentVersion,
          consentAt: c.consentAt?.toISOString() ?? null,
          externalAi: c.externalAi,
          createdAt: c.createdAt.toISOString(),
        },
        consents: consents.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
        strikes: strikes.map((st) => ({
          municipality: st.tenantName,
          createdAt: st.createdAt.toISOString(),
          expiresAt: st.expiresAt.toISOString(),
          annulled: st.annulledAt !== null,
          note: st.note,
        })),
        blocks: blocks.map(({ b, municipality }) => ({
          municipality,
          status: b.status,
          proposedAt: b.proposedAt.toISOString(),
          startsAt: b.startsAt?.toISOString() ?? null,
          endsAt: b.endsAt?.toISOString() ?? null,
          decisionNote: b.decisionNote,
        })),
        reviews: reviews.map(({ r, municipality }) => ({
          municipality,
          target: r.strikeId ? ('STRIKE' as const) : ('BLOCK' as const),
          text: r.text,
          status: r.status,
          response: r.response,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        })),
        devices: devices.map((d) => ({ platform: d.platform, appVersion: d.appVersion, lastSeenAt: d.lastSeenAt.toISOString() })),
        alerts: alerts.map((a) => ({
          id: a.id,
          type: a.type,
          source: a.source,
          status: a.status,
          category: a.category,
          location: { lat: a.lat, lng: a.lng },
          accuracyM: a.accuracyM,
          userText: a.userText,
          transcription: a.transcription,
          aiSummary: a.aiSummary,
          createdAt: a.createdAt.toISOString(),
          media: files
            .filter((m) => m.alertId === a.id)
            .map((m) => ({
              kind: m.kind,
              mime: m.mime,
              bytes: m.bytes,
              retentionUntil: m.retentionUntil.toISOString(),
              deleted: m.deletedAt !== null,
            })),
          events: events.filter((e) => e.alertId === a.id).map((e) => ({ kind: e.kind, createdAt: e.createdAt.toISOString() })),
        })),
      };
    });
  }

  /**
   * Supresión: `erase_citizen` (migración 0002) anonimiza en una sola transacción y marca el audio y
   * las fotos como vencidos. La purga de archivos va DESPUÉS del commit; si el storage falla, la purga
   * diaria los borra igual.
   */
  async erase(citizenId: string): Promise<CitizenEraseResult> {
    const marked = await this.dbs.asCitizen(citizenId, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`select erase_citizen(${citizenId}::uuid) as n`);
      return Number(rows[0]?.n ?? 0);
    });
    let purged = 0;
    try {
      purged = await this.mediaSvc.purgeExpired();
    } catch (e) {
      this.logger.warn(`supresión de ${citizenId}: purga de archivos pendiente (la diaria la reintenta): ${(e as Error).message}`);
    }
    this.logger.log(`vecino ${citizenId} anonimizado; ${marked} archivos vencidos, ${purged} purgados ahora`);
    return { erased: true, mediaPurged: purged };
  }
}
