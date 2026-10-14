import { z } from 'zod';
import {
  ACTOR_TYPES,
  AI_STATUSES,
  ALERT_CATEGORIES,
  ALERT_EVENT_KINDS,
  ALERT_STATUSES,
  ALERT_TYPES,
  AUDIT_KINDS,
  CONTACT_CATEGORIES,
  OPERATOR_ROLES,
  REJECT_REASONS,
  UNIT_STATUSES,
} from '../enums';
import { CursorPaginationSchema, UuidSchema } from './common';

/**
 * Administración de la central (migración 0003): usuarios, turnos, directorio de contactos y panel
 * del administrador con la bitácora. Todo es del municipio del operador que llama (RLS).
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

// ------------------------------------------------------------------ usuarios

export const PASSWORD_MIN_LENGTH = 10;

export const OperatorAccountSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string(),
  role: z.enum(OPERATOR_ROLES),
  active: z.boolean(),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** Con la central abierta ahora (socket conectado). */
  online: z.boolean(),
  /** Con un turno iniciado y sin terminar. */
  onShift: z.boolean(),
});
export type OperatorAccount = z.infer<typeof OperatorAccountSchema>;

export const CreateOperatorSchema = z.object({
  email: z.email().max(160).transform((v) => v.toLowerCase()),
  name: z.string().trim().min(2).max(80),
  role: z.enum(OPERATOR_ROLES),
});
export type CreateOperator = z.infer<typeof CreateOperatorSchema>;

export const UpdateOperatorSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    role: z.enum(OPERATOR_ROLES).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.role !== undefined || v.active !== undefined, 'Nada que cambiar');
export type UpdateOperator = z.infer<typeof UpdateOperatorSchema>;

/** Respuesta al crear una cuenta o restablecer su contraseña: la temporal se muestra una sola vez. */
export const TemporaryPasswordSchema = z.object({
  operator: OperatorAccountSchema,
  temporaryPassword: z.string(),
});
export type TemporaryPassword = z.infer<typeof TemporaryPasswordSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH, `Mínimo ${PASSWORD_MIN_LENGTH} caracteres`).max(200),
  })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'La nueva contraseña debe ser distinta', path: ['newPassword'] });
export type ChangePassword = z.infer<typeof ChangePasswordSchema>;

// -------------------------------------------------------------------- turnos

export const ShiftSchema = z.object({
  id: UuidSchema,
  operatorId: UuidSchema,
  operatorName: z.string(),
  plannedStart: z.iso.datetime().nullable(),
  plannedEnd: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  handoverNote: z.string().nullable(),
  /** Unidad con la que sale el funcionario de terreno (0012); null para la central. */
  unitCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Shift = z.infer<typeof ShiftSchema>;

const MAX_SHIFT_MS = 24 * 3600_000;
const MAX_RANGE_MS = 62 * 24 * 3600_000;

export const ShiftsQuerySchema = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime() })
  .refine((v) => Date.parse(v.to) > Date.parse(v.from), { message: 'to debe ser posterior a from', path: ['to'] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= MAX_RANGE_MS, { message: 'Máximo 62 días', path: ['to'] });
export type ShiftsQuery = z.infer<typeof ShiftsQuerySchema>;

export const CreateShiftSchema = z
  .object({ operatorId: UuidSchema, plannedStart: z.iso.datetime(), plannedEnd: z.iso.datetime() })
  .refine((v) => Date.parse(v.plannedEnd) > Date.parse(v.plannedStart), {
    message: 'El término debe ser posterior al inicio',
    path: ['plannedEnd'],
  })
  .refine((v) => Date.parse(v.plannedEnd) - Date.parse(v.plannedStart) <= MAX_SHIFT_MS, {
    message: 'Un turno dura máximo 24 h',
    path: ['plannedEnd'],
  });
export type CreateShift = z.infer<typeof CreateShiftSchema>;

export const EndShiftSchema = z.object({ handoverNote: optionalText(2000) });
export type EndShift = z.input<typeof EndShiftSchema>;

/** Lo que ve un operador al abrir la central: su turno, la última entrega y quién está de turno. */
export const ShiftStatusSchema = z.object({
  mine: ShiftSchema.nullable(),
  /** Próximo turno programado del operador (si no tiene uno abierto). */
  next: ShiftSchema.nullable(),
  lastHandover: z.object({ note: z.string(), operatorName: z.string(), endedAt: z.iso.datetime() }).nullable(),
  onDuty: z.array(
    z.object({ operatorId: UuidSchema, name: z.string(), startedAt: z.iso.datetime(), unitCode: z.string().nullable() }),
  ),
});
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>;

// ----------------------------------------------------------------- contactos

const PhoneText = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[+0-9 ()-]+$/, 'Solo dígitos, espacios, +, ( ) y -');

export const ContactSchema = z.object({
  id: UuidSchema,
  category: z.enum(CONTACT_CATEGORIES),
  name: z.string(),
  organization: z.string().nullable(),
  phone: z.string(),
  phoneAlt: z.string().nullable(),
  email: z.string().nullable(),
  sector: z.string().nullable(),
  notes: z.string().nullable(),
  available24h: z.boolean(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ContactInputSchema = z.object({
  category: z.enum(CONTACT_CATEGORIES),
  name: z.string().trim().min(2).max(120),
  organization: optionalText(120),
  phone: PhoneText,
  phoneAlt: z
    .union([PhoneText, z.literal('')])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  email: z
    .union([z.email().max(160), z.literal('')])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  sector: optionalText(120),
  notes: optionalText(1000),
  available24h: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(100),
});
export type ContactInput = z.input<typeof ContactInputSchema>;
export type ContactInputParsed = z.output<typeof ContactInputSchema>;

export const UpdateContactSchema = ContactInputSchema.partial().extend({ active: z.boolean().optional() });
export type UpdateContact = z.input<typeof UpdateContactSchema>;
export type UpdateContactParsed = z.output<typeof UpdateContactSchema>;

export const ContactsQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ContactsQuery = z.output<typeof ContactsQuerySchema>;

// --------------------------------------------------------------------- panel

export const ADMIN_RANGES = ['24h', '7d', '30d'] as const;
export type AdminRange = (typeof ADMIN_RANGES)[number];

export const AdminOverviewQuerySchema = z.object({ range: z.enum(ADMIN_RANGES).default('7d') });
export type AdminOverviewQuery = z.output<typeof AdminOverviewQuerySchema>;

const countsOf = <T extends readonly [string, ...string[]]>(values: T) => z.record(z.enum(values), z.number().int());

export const AdminOverviewSchema = z.object({
  range: z.enum(ADMIN_RANGES),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  /** Tamaño de cada barra de la serie. */
  bucket: z.enum(['hour', 'day']),
  now: z.object({
    open: z.object({ PENDING: z.number().int(), ACKNOWLEDGED: z.number().int(), DISPATCHED: z.number().int() }),
    oldestPendingSeconds: z.number().int().nullable(),
    units: countsOf(UNIT_STATUSES),
    operatorsOnline: z.number().int(),
    operatorsOnShift: z.number().int(),
  }),
  totals: z.object({
    sos: z.number().int(),
    civic: z.number().int(),
    byStatus: countsOf(ALERT_STATUSES),
  }),
  series: z.array(z.object({ bucket: z.iso.datetime(), sos: z.number().int(), civic: z.number().int() })),
  byCategory: z.array(z.object({ category: z.enum(ALERT_CATEGORIES), count: z.number().int() })),
  /** Tiempos en segundos desde que entra la alerta (mediana y percentil 90). */
  response: z.array(
    z.object({
      type: z.enum(ALERT_TYPES),
      acknowledged: z.number().int(),
      ackP50: z.number().nullable(),
      ackP90: z.number().nullable(),
      dispatchP50: z.number().nullable(),
      resolveP50: z.number().nullable(),
    }),
  ),
  rejections: z.array(z.object({ reason: z.enum(REJECT_REASONS), count: z.number().int() })),
  ai: countsOf(AI_STATUSES),
  operators: z.array(
    z.object({
      id: UuidSchema,
      name: z.string(),
      role: z.enum(OPERATOR_ROLES),
      online: z.boolean(),
      onShift: z.boolean(),
      lastLoginAt: z.iso.datetime().nullable(),
      acks: z.number().int(),
      dispatches: z.number().int(),
      resolves: z.number().int(),
      rejects: z.number().int(),
      notes: z.number().int(),
    }),
  ),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

export const ACTIVITY_SOURCES = ['cases', 'system'] as const;

export const ActivityQuerySchema = CursorPaginationSchema.extend({
  source: z.enum(ACTIVITY_SOURCES).default('cases'),
});
export type ActivityQuery = z.output<typeof ActivityQuerySchema>;

export const CaseActivitySchema = z.object({
  id: UuidSchema,
  createdAt: z.iso.datetime(),
  kind: z.enum(ALERT_EVENT_KINDS),
  actorType: z.enum(ACTOR_TYPES),
  actorName: z.string().nullable(),
  alertId: UuidSchema,
  alertType: z.enum(ALERT_TYPES),
  category: z.enum(ALERT_CATEGORIES).nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type CaseActivity = z.infer<typeof CaseActivitySchema>;

export const SystemActivitySchema = z.object({
  id: UuidSchema,
  createdAt: z.iso.datetime(),
  kind: z.enum(AUDIT_KINDS),
  actorName: z.string().nullable(),
  targetId: UuidSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type SystemActivity = z.infer<typeof SystemActivitySchema>;

export type ActivityPage<T> = { items: T[]; nextCursor: string | null };
