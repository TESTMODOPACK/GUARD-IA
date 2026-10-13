import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { CitizenAccountDetail, CitizenReviewStatus, CreateReview } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { DbService } from '../db/db.service';
import { citizenBlock, citizenReview, citizenStrike } from '../db/schema';
import { RateLimitService } from '../infra/rate-limit.service';
import { iso, loadCitizenAccount } from './account-read';

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}

/**
 * "Estado de tu cuenta" en la app (docs/plan-plataforma.md §5b, debido proceso): advertencias vigentes, bloqueo,
 * hasta cuándo y quién lo decidió, y la revisión que el vecino pide al municipio que lo sancionó.
 * Todo en contexto citizen: la RLS solo deja ver y pedir lo propio.
 */
@Injectable()
export class CitizenAccountService {
  constructor(
    private readonly dbs: DbService,
    private readonly rate: RateLimitService,
  ) {}

  detail(citizenId: string): Promise<CitizenAccountDetail> {
    return this.dbs.asCitizen(citizenId, async (tx) => {
      const account = await loadCitizenAccount(tx, citizenId);
      const strikes = (await tx.execute(sql`
        SELECT s.id, s.created_at, s.expires_at, d.name AS tenant_name,
               (SELECT r.status FROM citizen_review r WHERE r.strike_id = s.id ORDER BY r.created_at DESC LIMIT 1) AS review_status
          FROM citizen_strike s
          JOIN tenant_directory d ON d.id = s.tenant_id
         WHERE s.citizen_id = ${citizenId}::uuid AND s.annulled_at IS NULL AND s.expires_at > now()
         ORDER BY s.created_at DESC`)) as unknown as {
        id: string;
        created_at: Date;
        expires_at: Date;
        tenant_name: string;
        review_status: CitizenReviewStatus | null;
      }[];
      const [block] = (await tx.execute(sql`
        SELECT b.id, b.status, b.starts_at, b.ends_at, d.name AS tenant_name,
               (SELECT r.status FROM citizen_review r WHERE r.block_id = b.id ORDER BY r.created_at DESC LIMIT 1) AS review_status
          FROM citizen_block b
          JOIN tenant_directory d ON d.id = b.tenant_id
         WHERE b.citizen_id = ${citizenId}::uuid
           AND (b.status = 'PROPOSED' OR (b.status = 'ACTIVE' AND (b.ends_at IS NULL OR b.ends_at > now())))
         ORDER BY b.proposed_at DESC
         LIMIT 1`)) as unknown as {
        id: string;
        status: 'PROPOSED' | 'ACTIVE';
        starts_at: Date | null;
        ends_at: Date | null;
        tenant_name: string;
        review_status: CitizenReviewStatus | null;
      }[];
      const reviews = (await tx.execute(sql`
        SELECT r.id, r.strike_id, r.block_id, r.status, r.text, r.response, r.created_at, r.resolved_at, d.name AS tenant_name
          FROM citizen_review r
          JOIN tenant_directory d ON d.id = r.tenant_id
         WHERE r.citizen_id = ${citizenId}::uuid
         ORDER BY r.created_at DESC
         LIMIT 10`)) as unknown as {
        id: string;
        strike_id: string | null;
        block_id: string | null;
        status: CitizenReviewStatus;
        text: string;
        response: string | null;
        created_at: Date;
        resolved_at: Date | null;
        tenant_name: string;
      }[];
      return {
        account,
        strikes: strikes.map((s) => ({
          id: s.id,
          tenantName: s.tenant_name,
          createdAt: iso(s.created_at),
          expiresAt: iso(s.expires_at),
          reviewStatus: s.review_status,
        })),
        block: block
          ? {
              id: block.id,
              tenantName: block.tenant_name,
              status: block.status,
              startsAt: block.starts_at ? iso(block.starts_at) : null,
              endsAt: block.ends_at ? iso(block.ends_at) : null,
              reviewStatus: block.review_status,
            }
          : null,
        reviews: reviews.map((r) => ({
          id: r.id,
          target: r.strike_id ? 'STRIKE' : 'BLOCK',
          targetId: (r.strike_id ?? r.block_id)!,
          tenantName: r.tenant_name,
          status: r.status,
          text: r.text,
          response: r.response,
          createdAt: iso(r.created_at),
          resolvedAt: r.resolved_at ? iso(r.resolved_at) : null,
        })),
      };
    });
  }

  /** Pedir revisión de una advertencia vigente o de un bloqueo (propuesto o vigente). Una pendiente por cada uno. */
  async createReview(citizenId: string, body: CreateReview): Promise<CitizenAccountDetail> {
    await this.rate.hit(`review:${citizenId}`, 5, 86_400, 'Ya enviaste varias solicitudes hoy; la central te responderá');
    try {
      await this.dbs.asCitizen(citizenId, async (tx) => {
        let tenantId: string;
        if (body.strikeId) {
          const [s] = await tx
            .select({ tenantId: citizenStrike.tenantId })
            .from(citizenStrike)
            .where(
              and(
                eq(citizenStrike.id, body.strikeId),
                eq(citizenStrike.citizenId, citizenId),
                isNull(citizenStrike.annulledAt),
                gt(citizenStrike.expiresAt, sql`now()`),
              ),
            )
            .limit(1);
          if (!s) throw new AppError('NOT_FOUND', 'Esa advertencia ya no está vigente');
          tenantId = s.tenantId;
        } else {
          const [b] = await tx
            .select({ tenantId: citizenBlock.tenantId })
            .from(citizenBlock)
            .where(
              and(
                eq(citizenBlock.id, body.blockId!),
                eq(citizenBlock.citizenId, citizenId),
                inArray(citizenBlock.status, ['PROPOSED', 'ACTIVE']),
              ),
            )
            .limit(1);
          if (!b) throw new AppError('NOT_FOUND', 'Ese bloqueo ya no está vigente');
          tenantId = b.tenantId;
        }
        await tx.insert(citizenReview).values({
          citizenId,
          tenantId,
          strikeId: body.strikeId ?? null,
          blockId: body.blockId ?? null,
          text: body.text,
        });
      });
    } catch (e) {
      if (pgCode(e) === '23505') throw new AppError('CONFLICT', 'Ya pediste revisión de esto; la central te responderá');
      throw e;
    }
    return this.detail(citizenId);
  }
}
