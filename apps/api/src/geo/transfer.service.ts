import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AUTO_TRANSFER, type TenantOption, type TransferAlert, type Triage } from '@guardia/shared';
import { AlertReadService } from '../alerts/alert-read.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { alert, dispatch } from '../db/schema';
import { IncidentsService, loadIncidentInfos } from '../incidents/incidents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { resolveMentionedComuna } from './geo.queries';

type Actor = { kind: 'system' } | { kind: 'operator'; op: OperatorClaims };

/** SQLSTATE de transfer_alert() (migración 0006) → error de la API. */
function mapTransferError(e: unknown): never {
  const err = e as { code?: string; cause?: { code?: string } };
  const code = err.code ?? err.cause?.code;
  if (code === 'P0002') throw new AppError('NOT_FOUND', 'Alerta no encontrada');
  if (code === '22023') throw new AppError('VALIDATION_ERROR', 'Municipio de destino inválido');
  if (code === '55000') throw new AppError('CONFLICT', 'Solo se traspasan alertas abiertas y sin despacho');
  if (code === '42501') throw new AppError('FORBIDDEN', 'No puedes traspasar esta alerta');
  throw e;
}

/**
 * Redirección a la municipalidad donde ocurre el hecho (migración 0006). La única vía para cambiar
 * el municipio de una alerta es transfer_alert(): la usa el agente (automático, con las condiciones
 * de AUTO_TRANSFER en shared) y la central (manual). Después del commit: la central de origen la saca
 * de su cola, la de destino la recibe como nueva y el vecino recibe aviso.
 */
@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly reads: AlertReadService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly incidents: IncidentsService,
  ) {}

  /** Municipios de Guard-IA a los que se puede traspasar (todos los activos menos el propio). */
  tenantOptions(op: OperatorClaims): Promise<TenantOption[]> {
    // tenant_directory (0009): la RLS de tenant solo deja ver el municipio propio.
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) =>
      (await tx.execute(sql`
        SELECT id, name FROM tenant_directory
         WHERE active AND id <> ${op.tenantId}::uuid
         ORDER BY name`)) as unknown as TenantOption[],
    );
  }

  transferByOperator(op: OperatorClaims, alertId: string, body: TransferAlert) {
    return this.run({ kind: 'operator', op }, alertId, body.tenantId, body.reason, false);
  }

  /**
   * Lo llama el worker después de clasificar. Traspasa solo si el vecino nombra una comuna atendida
   * por otro municipio de Guard-IA, el hecho ocurre lejos de él o está en el límite, la alerta sigue
   * nueva y la central de destino tiene alguien conectado. Devuelve true si la traspasó (y ya emitió).
   */
  async maybeAutoTransfer(alertId: string, triage: Triage): Promise<boolean> {
    const said = triage.location?.comuna;
    if (!said) return false;
    const plan = await this.dbs.asSystem(async (tx) => {
      const [row] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
      if (!row?.tenantId || row.status !== 'PENDING') return null;
      const [d] = await tx.select({ id: dispatch.id }).from(dispatch).where(eq(dispatch.alertId, alertId)).limit(1);
      if (d) return null;
      const m = await resolveMentionedComuna(tx, said, row);
      if (!m?.tenantId || !m.tenantName || m.tenantId === row.tenantId) return null;
      const onBoundary = m.distanceM !== null && m.distanceM <= AUTO_TRANSFER.maxDistanceM;
      if (!triage.location.elsewhere && !onBoundary) return null;
      return { to: m.tenantId, toName: m.tenantName, comuna: m.name, onBoundary };
    });
    if (!plan) return false;

    // Nunca dejar un SOS sin nadie que lo vea: si la otra central está vacía, se queda y se sugiere.
    const online = await this.realtime.connectedOperatorIds(plan.to);
    if (online.size === 0) {
      this.logger.warn(`alerta ${alertId}: ocurre en ${plan.comuna}, pero ${plan.toName} no tiene operadores conectados; no se traspasa`);
      return false;
    }
    const reason = `El vecino indica que ocurre en ${plan.comuna}${plan.onBoundary ? ' (está en el límite comunal)' : ' (lejos de donde está)'}`;
    try {
      await this.run({ kind: 'system' }, alertId, plan.to, reason, true);
      return true;
    } catch (e) {
      // La central de origen la tomó mientras tanto (55000) u otro error: se queda donde está.
      this.logger.warn(`alerta ${alertId}: traspaso automático a ${plan.toName} no se hizo: ${(e as Error).message}`);
      return false;
    }
  }

  private async run(actor: Actor, alertId: string, toTenantId: string, reason: string, auto: boolean) {
    const exec = async (tx: Tx) => {
      const [before] = await tx
        .select({ incidentId: alert.incidentId, citizenId: alert.citizenId })
        .from(alert)
        .where(eq(alert.id, alertId))
        .limit(1);
      const actorId = actor.kind === 'operator' ? actor.op.sub : null;
      const rows = (await tx.execute(
        sql`select transfer_alert(${alertId}::uuid, ${toTenantId}::uuid, ${actorId}::uuid, ${reason}, ${auto}) as from_tenant`,
      )) as unknown as { from_tenant: string }[];
      const [to] = (await tx.execute(sql`SELECT name FROM tenant_directory WHERE id = ${toTenantId}::uuid`)) as unknown as {
        name: string;
      }[];
      return {
        fromTenantId: rows[0].from_tenant,
        oldIncident: before?.incidentId ?? null,
        citizenId: before?.citizenId ?? null,
        toName: to?.name ?? '',
      };
    };
    let r: Awaited<ReturnType<typeof exec>>;
    try {
      r =
        actor.kind === 'system'
          ? await this.dbs.asSystem(exec)
          : await this.dbs.asOperator(actor.op.tenantId, actor.op.sub, exec);
    } catch (e) {
      mapTransferError(e);
    }

    // Después del commit (regla 5). El grupo de origen pierde un reporte; en destino se agrupa de nuevo.
    const oldIncident = r.oldIncident;
    if (oldIncident) {
      const primary = await this.dbs
        .asSystem(async (tx) => {
          await this.incidents.recompute(tx, oldIncident);
          return (await loadIncidentInfos(tx, [oldIncident])).get(oldIncident)?.primaryAlertId ?? null;
        })
        .catch((e: Error) => {
          this.logger.warn(`incidente ${oldIncident}: ${e.message}`);
          return null;
        });
      if (primary) {
        const d = await this.dbs.asSystem((tx) => this.reads.detail(tx, primary)).catch(() => null);
        if (d) this.realtime.alertUpdated(r.fromTenantId, d);
      }
    }
    await this.incidents.attach(alertId).catch((e: Error) => this.logger.warn(`incidente de ${alertId}: ${e.message}`));

    this.realtime.alertTransferred(r.fromTenantId, { alertId, toTenantId, toTenantName: r.toName, auto, reason });
    const summary = await this.dbs.asSystem(async (tx) => {
      const [row] = await tx.select().from(alert).where(eq(alert.id, alertId)).limit(1);
      return this.reads.summary(tx, row);
    });
    this.realtime.alertCreated(toTenantId, summary);
    this.logger.log(`alerta ${alertId} traspasada ${auto ? 'por el agente' : 'por la central'} a ${r.toName}: ${reason}`);

    if (r.citizenId) {
      try {
        const view = await this.dbs.asSystem((tx) => this.reads.citizenView(tx, alertId));
        await this.notifications.notifyAlertStatus(r.citizenId, toTenantId, view, {
          title: 'Tu alerta fue derivada',
          body: `La atiende la central de ${r.toName}, donde ocurre el hecho.`,
        });
      } catch (e) {
        this.logger.warn(`No se pudo avisar al vecino del traspaso de ${alertId}: ${(e as Error).message}`);
      }
    }
    return { alertId, fromTenantId: r.fromTenantId, toTenantId, toTenantName: r.toName };
  }
}

/** Global: lo usan el worker IA (traspaso automático) y la central (manual). */
@Global()
@Module({ providers: [TransferService], exports: [TransferService] })
export class GeoModule {}
