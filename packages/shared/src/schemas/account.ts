import { z } from 'zod';
import {
  ACCOUNT_LEVELS,
  BLOCK_DAYS,
  BLOCK_REPEAT_DAYS,
  CITIZEN_BLOCK_STATUSES,
  CITIZEN_REVIEW_STATUSES,
} from '../enums';
import { UuidSchema } from './common';

/**
 * Cuenta del vecino y uso indebido (migración 0011, docs/plan-plataforma.md §5b): restricción, bloqueo con
 * aprobación, revisión pedida por el vecino. La cuenta es una sola para todo el país.
 */

// ------------------------------------------------------------------ vecino

/** Resumen que viaja con el vecino (CitizenPublic.account): la app decide con esto qué pantallas muestra. */
export const CitizenAccountSchema = z.object({
  level: z.enum(ACCOUNT_LEVELS),
  activeStrikes: z.number().int(),
  /** Con RESTRICTED: cuándo vuelve a tener menos de 2 faltas vigentes, si no suma otra. */
  restrictedUntil: z.iso.datetime().nullable(),
  /** Con BLOCKED: hasta cuándo (null = indefinido) y qué municipio lo decidió. */
  block: z.object({ endsAt: z.iso.datetime().nullable(), tenantName: z.string() }).nullable(),
});
export type CitizenAccount = z.infer<typeof CitizenAccountSchema>;

export const REVIEW_TARGETS = ['STRIKE', 'BLOCK'] as const;
export type ReviewTarget = (typeof REVIEW_TARGETS)[number];

export const CitizenReviewSchema = z.object({
  id: UuidSchema,
  target: z.enum(REVIEW_TARGETS),
  targetId: UuidSchema,
  tenantName: z.string(),
  status: z.enum(CITIZEN_REVIEW_STATUSES),
  text: z.string(),
  /** Respuesta del municipio (siempre, al resolver). */
  response: z.string().nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type CitizenReview = z.infer<typeof CitizenReviewSchema>;

export const CitizenAccountDetailSchema = z.object({
  account: CitizenAccountSchema,
  /** Faltas vigentes, con el municipio que las puso y si ya pidió revisión. */
  strikes: z.array(
    z.object({
      id: UuidSchema,
      tenantName: z.string(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      reviewStatus: z.enum(CITIZEN_REVIEW_STATUSES).nullable(),
    }),
  ),
  /** Bloqueo vigente o propuesto (PROPOSED: el municipio lo está evaluando). */
  block: z
    .object({
      id: UuidSchema,
      tenantName: z.string(),
      status: z.enum(['PROPOSED', 'ACTIVE']),
      startsAt: z.iso.datetime().nullable(),
      endsAt: z.iso.datetime().nullable(),
      reviewStatus: z.enum(CITIZEN_REVIEW_STATUSES).nullable(),
    })
    .nullable(),
  /** Últimas revisiones pedidas, con la respuesta del municipio. */
  reviews: z.array(CitizenReviewSchema),
});
export type CitizenAccountDetail = z.infer<typeof CitizenAccountDetailSchema>;

export const CreateReviewSchema = z
  .object({
    strikeId: UuidSchema.optional(),
    blockId: UuidSchema.optional(),
    text: z.string().trim().min(10, 'Cuéntanos qué pasó en al menos 10 caracteres').max(1000),
  })
  .refine((v) => !!v.strikeId !== !!v.blockId, 'Indica una falta o un bloqueo');
export type CreateReview = z.infer<typeof CreateReviewSchema>;

// ------------------------------------------------------------------ central

/** Vecino tal como lo ve la central en estas listas: nombre (si lo dio) y teléfono enmascarado. */
const CitizenRefSchema = z.object({ id: UuidSchema, label: z.string() });

export const BlockItemSchema = z.object({
  id: UuidSchema,
  citizen: CitizenRefSchema,
  status: z.enum(CITIZEN_BLOCK_STATUSES),
  strikes: z.number().int(),
  suggestedDays: z.number().int(),
  days: z.number().int().nullable(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  proposedAt: z.iso.datetime(),
  proposedById: UuidSchema,
  proposedBy: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionNote: z.string().nullable(),
  alertId: UuidSchema.nullable(),
});
export type BlockItem = z.infer<typeof BlockItemSchema>;

export const StrikeItemSchema = z.object({
  id: UuidSchema,
  citizen: CitizenRefSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Evidencia escrita por quien rechazó. */
  note: z.string(),
  decidedBy: z.string(),
  alertId: UuidSchema,
  annulledAt: z.iso.datetime().nullable(),
  annulReason: z.string().nullable(),
});
export type StrikeItem = z.infer<typeof StrikeItemSchema>;

export const ReviewItemSchema = z.object({
  id: UuidSchema,
  citizen: CitizenRefSchema,
  target: z.enum(REVIEW_TARGETS),
  targetId: UuidSchema,
  /** "Falta del 13-10 (vence el 11-01)" o "Bloqueo hasta el 12-11". */
  targetSummary: z.string(),
  text: z.string(),
  createdAt: z.iso.datetime(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

/** Página "Cuentas" de la central (SUPERVISOR y ADMIN): lo que decide este municipio. */
export const AccountsOverviewSchema = z.object({
  proposals: z.array(BlockItemSchema),
  reviews: z.array(ReviewItemSchema),
  activeBlocks: z.array(BlockItemSchema),
  /** Faltas puestas por este municipio en los últimos 90 días (vigentes y anuladas). */
  strikes: z.array(StrikeItemSchema),
});
export type AccountsOverview = z.infer<typeof AccountsOverviewSchema>;

export const DecideBlockSchema = z
  .object({
    approve: z.boolean(),
    /** Al aprobar: 30 o 180 días, o null (indefinido: solo el administrador, por acoso o reincidencia grave). */
    days: z.union([z.literal(BLOCK_DAYS), z.literal(BLOCK_REPEAT_DAYS), z.null()]).optional(),
    note: z.string().trim().min(5, 'Escribe el motivo').max(500),
  })
  .refine((v) => !v.approve || v.days !== undefined, { message: 'Elige el plazo', path: ['days'] });
export type DecideBlock = z.infer<typeof DecideBlockSchema>;

const ReasonSchema = z.object({ reason: z.string().trim().min(5, 'Escribe el motivo').max(500) });
export const LiftBlockSchema = ReasonSchema;
export type LiftBlock = z.infer<typeof LiftBlockSchema>;
export const AnnulStrikeSchema = ReasonSchema;
export type AnnulStrike = z.infer<typeof AnnulStrikeSchema>;

export const ResolveReviewSchema = z.object({
  /** true: se acoge (anula la falta o levanta el bloqueo). false: se mantiene. */
  grant: z.boolean(),
  response: z.string().trim().min(5, 'Escribe la respuesta al vecino').max(1000),
});
export type ResolveReview = z.infer<typeof ResolveReviewSchema>;
