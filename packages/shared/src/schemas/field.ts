import { z } from 'zod';
import {
  ALERT_CATEGORIES,
  ALERT_TYPES,
  DISPATCH_OUTCOMES,
  DISPATCH_STATUSES,
  FIELD_ALARM_KINDS,
  PRIORITIES,
  UNIT_KINDS,
  UNIT_STATUSES,
} from '../enums';
import { subcategoryFits } from './ai';
import { MediaPublicSchema } from './alert';
import { LocationSchema, UuidSchema } from './common';

/**
 * Terreno (migración 0012, docs/plan-plataforma.md §5c): lo que usa la página /terreno de la central en el
 * teléfono del funcionario y los avisos que llegan a la central. El funcionario solo ve el caso al que
 * despacharon su unidad: categoría, resumen, lugar y preguntas sugeridas; nunca el teléfono, el nombre ni la
 * transcripción del vecino.
 */

export const FieldLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Precisión que informa el teléfono, en metros. */
  accuracyM: z.number().min(0).max(100_000).optional(),
});
export type FieldLocation = z.infer<typeof FieldLocationSchema>;

export const StartFieldShiftSchema = z.object({ unitId: UuidSchema });
export type StartFieldShift = z.infer<typeof StartFieldShiftSchema>;

/** "Voy en camino" y "Llegué": la unidad solo avanza; cancelar o cerrar sigue siendo de la central. */
export const FieldStatusSchema = z.object({
  status: z.enum(['EN_ROUTE', 'ON_SITE']),
  location: FieldLocationSchema.optional(),
});
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

/**
 * Campo `meta` (JSON) del multipart de POST /ops/field/dispatches/:id/report; las fotos viajan como `photo`.
 * Mismas reglas que el resultado que registra la central, pero "era otra situación" queda como propuesta.
 */
export const FieldReportSchema = z
  .object({
    outcome: z.enum(DISPATCH_OUTCOMES),
    notes: z.string().trim().max(1000).optional(),
    category: z.enum(ALERT_CATEGORIES).optional(),
    subcategory: z.string().nullable().optional(),
    location: FieldLocationSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === 'DIFFERENT_SITUATION' && !v.category) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'Indica qué situación encontraste' });
    }
    if (v.category && !subcategoryFits(v.category, v.subcategory)) {
      ctx.addIssue({ code: 'custom', path: ['subcategory'], message: `La subcategoría no corresponde a ${v.category}` });
    }
    if (v.outcome === 'FALSE_ALARM_CONFIRMED' && (v.notes?.length ?? 0) < 10) {
      ctx.addIssue({ code: 'custom', path: ['notes'], message: 'Describe qué comprobaste (mínimo 10 caracteres)' });
    }
    if (v.outcome === 'NEEDS_SUPPORT' && (v.notes?.length ?? 0) < 3) {
      ctx.addIssue({ code: 'custom', path: ['notes'], message: 'Di qué apoyo necesitas' });
    }
  });
export type FieldReport = z.infer<typeof FieldReportSchema>;

export const PanicSchema = z.object({
  location: FieldLocationSchema.optional(),
  note: z.string().trim().max(300).optional(),
});
export type Panic = z.infer<typeof PanicSchema>;

export const AckFieldAlarmSchema = z.object({ note: z.string().trim().max(300).optional() });
export type AckFieldAlarm = z.infer<typeof AckFieldAlarmSchema>;

/** Aviso de terreno: lo ve la central (banner con sonido) y, si es su pánico, el propio funcionario. */
export const FieldAlarmSchema = z.object({
  id: UuidSchema,
  kind: z.enum(FIELD_ALARM_KINDS),
  unitId: UuidSchema.nullable(),
  unitCode: z.string().nullable(),
  /** Funcionario que lo envió (pánico, apoyo); null en los plazos vencidos. */
  operatorId: UuidSchema.nullable(),
  operatorName: z.string().nullable(),
  dispatchId: UuidSchema.nullable(),
  alertId: UuidSchema.nullable(),
  location: LocationSchema.nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Atendido en la central, o cerrado solo porque la unidad volvió a dar noticias. */
  closedAt: z.iso.datetime().nullable(),
  closedByName: z.string().nullable(),
});
export type FieldAlarm = z.infer<typeof FieldAlarmSchema>;

/** El caso tal como lo ve la unidad. */
export const FieldDispatchSchema = z.object({
  id: UuidSchema,
  status: z.enum(DISPATCH_STATUSES),
  notes: z.string().nullable(),
  outcome: z.enum(DISPATCH_OUTCOMES).nullable(),
  outcomeNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  alert: z.object({
    id: UuidSchema,
    type: z.enum(ALERT_TYPES),
    category: z.enum(ALERT_CATEGORIES).nullable(),
    subcategory: z.string().nullable(),
    priority: z.enum(PRIORITIES).nullable(),
    /** Resumen de la IA (sin datos del vecino). */
    summary: z.string().nullable(),
    /** Calle o referencia que nombró el vecino. */
    place: z.string().nullable(),
    questions: z.array(z.string()),
    location: LocationSchema,
    addressHint: z.string().nullable(),
    createdAt: z.iso.datetime(),
    /** Fotos del caso (las del vecino en un reporte urbano y las que sube la unidad). */
    photos: z.array(MediaPublicSchema),
  }),
});
export type FieldDispatch = z.infer<typeof FieldDispatchSchema>;

export const FieldUnitOptionSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  kind: z.enum(UNIT_KINDS),
  status: z.enum(UNIT_STATUSES),
  /** Funcionarios de terreno que ya salieron con esta unidad. */
  crew: z.array(z.string()),
});
export type FieldUnitOption = z.infer<typeof FieldUnitOptionSchema>;

/** GET /ops/field/state: todo lo que necesita /terreno para dibujarse. */
export const FieldStateSchema = z.object({
  shift: z
    .object({
      id: UuidSchema,
      startedAt: z.iso.datetime(),
      unit: z.object({ id: UuidSchema, code: z.string(), kind: z.enum(UNIT_KINDS) }),
    })
    .nullable(),
  dispatch: FieldDispatchSchema.nullable(),
  /** Unidades para elegir al iniciar turno (vacío con un turno abierto). */
  units: z.array(FieldUnitOptionSchema),
  /** Pánico propio aún sin atender en la central. */
  panic: FieldAlarmSchema.nullable(),
});
export type FieldState = z.infer<typeof FieldStateSchema>;
