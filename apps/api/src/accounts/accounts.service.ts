import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  BLOCK_PROPOSAL_AT_STRIKES,
  RESTRICT_AT_STRIKES,
  STRIKE_ANNULLED_NOTICE,
  UNBLOCK_NOTICE,
  blockNotice,
  reviewNotice,
  type AccountLevel,
  type AccountsOverview,
  type AnnulStrike,
  type BlockItem,
  type CitizenBlockStatus,
  type DecideBlock,
  type LiftBlock,
  type ResolveReview,
} from '@guardia/shared';
import { activeStrikes } from '../alerts/alert-read.service';
import { AuditService } from '../auth/audit.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { citizen, citizenBlock, citizenReview, citizenStrike, tenant } from '../db/schema';
import { NotificationsService } from '../notifications/notifications.service';
import { citizenLabel, iso } from './account-read';

/** Lo mismo que resta un aviso falso (ops.service): anular la falta lo devuelve. */
const TRUST_RESTORED = 25;

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}

// En SQL crudo Drizzle entrega las fechas como texto: se aceptan ambas formas.
const day = (d: Date | string) =>
  new Date(d).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric' });

interface BlockRow {
  id: string;
  citizen_id: string;
  citizen_name: string | null;
  citizen_phone: string;
  status: CitizenBlockStatus;
  strikes: number;
  suggested_days: number;
  days: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  proposed_at: Date;
  proposed_by: string;
  proposed_by_name: string;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  alert_id: string | null;
}

function toBlockItem(b: BlockRow): BlockItem {
  return {
    id: b.id,
    citizen: { id: b.citizen_id, label: citizenLabel(b.citizen_name, b.citizen_phone) },
    status: b.status,
    strikes: b.strikes,
    suggestedDays: b.suggested_days,
    days: b.days,
    startsAt: b.starts_at ? iso(b.starts_at) : null,
    endsAt: b.ends_at ? iso(b.ends_at) : null,
    proposedAt: iso(b.proposed_at),
    proposedById: b.proposed_by,
    proposedBy: b.proposed_by_name,
    decidedBy: b.decided_by_name,
    decidedAt: b.decided_at ? iso(b.decided_at) : null,
    decisionNote: b.decision_note,
    alertId: b.alert_id,
  };
}

/** Nivel de la cuenta con lo que ve esta transacción (para el aviso por WS; la app relee el detalle). */
async function levelOf(tx: Tx, citizenId: string): Promise<AccountLevel> {
  const [b] = (await tx.execute(sql`
    SELECT 1 FROM citizen_block b
     WHERE b.citizen_id = ${citizenId}::uuid AND b.status = 'ACTIVE' AND (b.ends_at IS NULL OR b.ends_at > now())
     LIMIT 1`)) as unknown as unknown[];
  if (b) return 'BLOCKED';
  const n = await activeStrikes(tx, citizenId);
  return n >= RESTRICT_AT_STRIKES ? 'RESTRICTED' : n > 0 ? 'WARNED' : 'OK';
}

/**
 * Página "Cuentas" de la central (SUPERVISOR y ADMIN; docs/plan-plataforma.md §5b): bloqueos por aprobar,
 * revisiones pendientes, bloqueos vigentes y faltas recientes del municipio. Dos personas para bloquear (la
 * base lo exige: citizen_block_two_people_chk). Cada decisión escribe audit_log en la misma transacción y avisa
 * al vecino después del commit (reglas 5 y 10).
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  overview(op: OperatorClaims): Promise<AccountsOverview> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const T = sql`${op.tenantId}::uuid`;
      const blocks = (await tx.execute(sql`
        SELECT b.id, b.citizen_id, c.name AS citizen_name, c.phone AS citizen_phone, b.status, b.strikes,
               b.suggested_days, b.days, b.starts_at, b.ends_at, b.proposed_at, b.proposed_by,
               p.name AS proposed_by_name, x.name AS decided_by_name, b.decided_at, b.decision_note, b.alert_id
          FROM citizen_block b
          JOIN citizen c ON c.id = b.citizen_id
          JOIN operator p ON p.id = b.proposed_by
          LEFT JOIN operator x ON x.id = b.decided_by
         WHERE b.tenant_id = ${T}
           AND (b.status = 'PROPOSED' OR (b.status = 'ACTIVE' AND (b.ends_at IS NULL OR b.ends_at > now())))
         ORDER BY b.proposed_at`)) as unknown as BlockRow[];
      const reviews = (await tx.execute(sql`
        SELECT r.id, r.citizen_id, c.name AS citizen_name, c.phone AS citizen_phone, r.strike_id, r.block_id, r.text,
               r.created_at, s.created_at AS strike_at, s.expires_at AS strike_expires, bl.status AS block_status,
               bl.ends_at AS block_ends
          FROM citizen_review r
          JOIN citizen c ON c.id = r.citizen_id
          LEFT JOIN citizen_strike s ON s.id = r.strike_id
          LEFT JOIN citizen_block bl ON bl.id = r.block_id
         WHERE r.tenant_id = ${T} AND r.status = 'PENDING'
         ORDER BY r.created_at`)) as unknown as {
        id: string;
        citizen_id: string;
        citizen_name: string | null;
        citizen_phone: string;
        strike_id: string | null;
        block_id: string | null;
        text: string;
        created_at: Date;
        strike_at: Date | null;
        strike_expires: Date | null;
        block_status: CitizenBlockStatus | null;
        block_ends: Date | null;
      }[];
      const strikes = (await tx.execute(sql`
        SELECT s.id, s.citizen_id, c.name AS citizen_name, c.phone AS citizen_phone, s.created_at, s.expires_at,
               s.note, o.name AS decided_by_name, s.alert_id, s.annulled_at, s.annul_reason
          FROM citizen_strike s
          JOIN citizen c ON c.id = s.citizen_id
          JOIN operator o ON o.id = s.decided_by
         WHERE s.tenant_id = ${T} AND s.created_at > now() - interval '90 days'
         ORDER BY s.created_at DESC
         LIMIT 200`)) as unknown as {
        id: string;
        citizen_id: string;
        citizen_name: string | null;
        citizen_phone: string;
        created_at: Date;
        expires_at: Date;
        note: string;
        decided_by_name: string;
        alert_id: string;
        annulled_at: Date | null;
        annul_reason: string | null;
      }[];
      return {
        proposals: blocks.filter((b) => b.status === 'PROPOSED').map(toBlockItem),
        activeBlocks: blocks.filter((b) => b.status === 'ACTIVE').map(toBlockItem),
        reviews: reviews.map((r) => ({
          id: r.id,
          citizen: { id: r.citizen_id, label: citizenLabel(r.citizen_name, r.citizen_phone) },
          target: r.strike_id ? 'STRIKE' : 'BLOCK',
          targetId: (r.strike_id ?? r.block_id)!,
          targetSummary: r.strike_id
            ? `Advertencia del ${day(r.strike_at!)} (vence el ${day(r.strike_expires!)})`
            : r.block_status === 'PROPOSED'
              ? 'Propuesta de bloqueo (aún sin decidir)'
              : r.block_ends
                ? `Bloqueo hasta el ${day(r.block_ends)}`
                : 'Bloqueo sin plazo',
          text: r.text,
          createdAt: iso(r.created_at),
        })),
        strikes: strikes.map((s) => ({
          id: s.id,
          citizen: { id: s.citizen_id, label: citizenLabel(s.citizen_name, s.citizen_phone) },
          createdAt: iso(s.created_at),
          expiresAt: iso(s.expires_at),
          note: s.note,
          decidedBy: s.decided_by_name,
          alertId: s.alert_id,
          annulledAt: s.annulled_at ? iso(s.annulled_at) : null,
          annulReason: s.annul_reason,
        })),
      };
    });
  }

  /** Aprobar (30 días, 6 meses o, solo el administrador, sin plazo) o descartar una propuesta de bloqueo. */
  async decideBlock(op: OperatorClaims, id: string, body: DecideBlock): Promise<AccountsOverview> {
    if (body.approve && body.days === null && op.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Solo el administrador municipal puede bloquear sin plazo');
    }
    let done: { citizenId: string; days: number | null; tenantName: string; level: AccountLevel } | null = null;
    try {
      done = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
        const [b] = await tx
          .select()
          .from(citizenBlock)
          .where(and(eq(citizenBlock.id, id), eq(citizenBlock.tenantId, op.tenantId)))
          .for('update')
          .limit(1);
        if (!b) throw new AppError('NOT_FOUND', 'Propuesta no encontrada');
        if (b.status !== 'PROPOSED') throw new AppError('CONFLICT', 'Esta propuesta ya fue decidida');
        if (b.proposedBy === op.sub) {
          throw new AppError('FORBIDDEN', 'Quien propone el bloqueo no lo decide: debe hacerlo otra persona');
        }
        const now = new Date();
        const days = body.approve ? (body.days ?? null) : null;
        await tx
          .update(citizenBlock)
          .set(
            body.approve
              ? {
                  status: 'ACTIVE',
                  days,
                  startsAt: now,
                  endsAt: days ? new Date(now.getTime() + days * 86_400_000) : null,
                  decidedBy: op.sub,
                  decidedAt: now,
                  decisionNote: body.note,
                }
              : { status: 'DISMISSED', decidedBy: op.sub, decidedAt: now, decisionNote: body.note },
          )
          .where(eq(citizenBlock.id, id));
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: body.approve ? 'CITIZEN_BLOCKED' : 'CITIZEN_BLOCK_DISMISSED',
          targetId: id,
          payload: { citizenId: b.citizenId, days, note: body.note },
        });
        const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, op.tenantId)).limit(1);
        return { citizenId: b.citizenId, days, tenantName: t?.name ?? 'Tu municipalidad', level: await levelOf(tx, b.citizenId) };
      });
    } catch (e) {
      if (pgCode(e) === '23514') throw new AppError('FORBIDDEN', 'Quien propone el bloqueo no lo decide');
      throw e;
    }
    if (body.approve && done) {
      await this.notifications.notifyAccount(done.citizenId, done.level, blockNotice(done.days, done.tenantName));
    }
    return this.overview(op);
  }

  async liftBlock(op: OperatorClaims, id: string, body: LiftBlock): Promise<AccountsOverview> {
    const r = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const citizenId = await this.liftInTx(tx, op, id, body.reason);
      return { citizenId, level: await levelOf(tx, citizenId) };
    });
    await this.notifications.notifyAccount(r.citizenId, r.level, UNBLOCK_NOTICE);
    return this.overview(op);
  }

  async annulStrike(op: OperatorClaims, id: string, body: AnnulStrike): Promise<AccountsOverview> {
    const r = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const citizenId = await this.annulInTx(tx, op, id, body.reason);
      return { citizenId, level: await levelOf(tx, citizenId) };
    });
    await this.notifications.notifyAccount(r.citizenId, r.level, STRIKE_ANNULLED_NOTICE);
    return this.overview(op);
  }

  /** Acoger (anula la falta o levanta / descarta el bloqueo) o mantener; siempre con respuesta al vecino. */
  async resolveReview(op: OperatorClaims, id: string, body: ResolveReview): Promise<AccountsOverview> {
    const r = await this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [rv] = await tx
        .select()
        .from(citizenReview)
        .where(and(eq(citizenReview.id, id), eq(citizenReview.tenantId, op.tenantId), eq(citizenReview.status, 'PENDING')))
        .for('update')
        .limit(1);
      if (!rv) throw new AppError('NOT_FOUND', 'Revisión no encontrada o ya resuelta');
      const reason = `Revisión acogida: ${body.response}`.slice(0, 500);
      if (body.grant && rv.strikeId) {
        const [s] = await tx.select({ annulledAt: citizenStrike.annulledAt }).from(citizenStrike).where(eq(citizenStrike.id, rv.strikeId)).limit(1);
        if (s && !s.annulledAt) await this.annulInTx(tx, op, rv.strikeId, reason);
      }
      if (body.grant && rv.blockId) {
        const [b] = await tx.select().from(citizenBlock).where(eq(citizenBlock.id, rv.blockId)).for('update').limit(1);
        if (b?.status === 'ACTIVE') await this.liftInTx(tx, op, b.id, reason);
        if (b?.status === 'PROPOSED') {
          if (b.proposedBy === op.sub) throw new AppError('FORBIDDEN', 'Quien propuso el bloqueo no resuelve esta revisión');
          await tx
            .update(citizenBlock)
            .set({ status: 'DISMISSED', decidedBy: op.sub, decidedAt: new Date(), decisionNote: reason })
            .where(eq(citizenBlock.id, b.id));
          await this.audit.record(tx, {
            tenantId: op.tenantId,
            actorId: op.sub,
            kind: 'CITIZEN_BLOCK_DISMISSED',
            targetId: b.id,
            payload: { citizenId: b.citizenId, note: reason },
          });
        }
      }
      await tx
        .update(citizenReview)
        .set({ status: body.grant ? 'GRANTED' : 'DENIED', response: body.response, resolvedBy: op.sub, resolvedAt: new Date() })
        .where(eq(citizenReview.id, id));
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'REVIEW_RESOLVED',
        targetId: id,
        payload: { citizenId: rv.citizenId, grant: body.grant, target: rv.strikeId ? 'STRIKE' : 'BLOCK' },
      });
      return { citizenId: rv.citizenId, level: await levelOf(tx, rv.citizenId) };
    });
    await this.notifications.notifyAccount(r.citizenId, r.level, reviewNotice(body.grant, body.response));
    return this.overview(op);
  }

  private async liftInTx(tx: Tx, op: OperatorClaims, blockId: string, reason: string): Promise<string> {
    const [b] = await tx
      .update(citizenBlock)
      .set({ status: 'LIFTED', liftedBy: op.sub, liftedAt: new Date(), liftReason: reason })
      .where(and(eq(citizenBlock.id, blockId), eq(citizenBlock.tenantId, op.tenantId), eq(citizenBlock.status, 'ACTIVE')))
      .returning({ citizenId: citizenBlock.citizenId });
    if (!b) throw new AppError('NOT_FOUND', 'No hay un bloqueo vigente con ese identificador');
    await this.audit.record(tx, {
      tenantId: op.tenantId,
      actorId: op.sub,
      kind: 'CITIZEN_UNBLOCKED',
      targetId: blockId,
      payload: { citizenId: b.citizenId, reason },
    });
    return b.citizenId;
  }

  /**
   * Anula una falta de este municipio: devuelve la confianza y, si el vecino ya no llega a 3 faltas, descarta
   * sola la propuesta de bloqueo abierta (salvo que la haya propuesto quien anula: dos personas).
   */
  private async annulInTx(tx: Tx, op: OperatorClaims, strikeId: string, reason: string): Promise<string> {
    const [s] = await tx
      .update(citizenStrike)
      .set({ annulledAt: new Date(), annulledBy: op.sub, annulReason: reason })
      .where(and(eq(citizenStrike.id, strikeId), eq(citizenStrike.tenantId, op.tenantId), isNull(citizenStrike.annulledAt)))
      .returning({ citizenId: citizenStrike.citizenId });
    if (!s) throw new AppError('NOT_FOUND', 'La falta no existe o ya fue anulada');
    await tx
      .update(citizen)
      .set({ trustScore: sql`least(100, ${citizen.trustScore} + ${TRUST_RESTORED})` })
      .where(eq(citizen.id, s.citizenId));
    await this.audit.record(tx, {
      tenantId: op.tenantId,
      actorId: op.sub,
      kind: 'STRIKE_ANNULLED',
      targetId: strikeId,
      payload: { citizenId: s.citizenId, reason },
    });
    if ((await activeStrikes(tx, s.citizenId)) < BLOCK_PROPOSAL_AT_STRIKES) {
      const dismissed = await tx
        .update(citizenBlock)
        .set({ status: 'DISMISSED', decidedBy: op.sub, decidedAt: new Date(), decisionNote: 'Falta anulada: ya no hay 3 vigentes' })
        .where(
          and(
            eq(citizenBlock.citizenId, s.citizenId),
            eq(citizenBlock.tenantId, op.tenantId),
            eq(citizenBlock.status, 'PROPOSED'),
            ne(citizenBlock.proposedBy, op.sub),
          ),
        )
        .returning({ id: citizenBlock.id });
      for (const d of dismissed) {
        await this.audit.record(tx, {
          tenantId: op.tenantId,
          actorId: op.sub,
          kind: 'CITIZEN_BLOCK_DISMISSED',
          targetId: d.id,
          payload: { citizenId: s.citizenId, note: 'Falta anulada' },
        });
      }
    }
    this.logger.log(`falta ${strikeId} anulada por ${op.sub}`);
    return s.citizenId;
  }
}
