import { z } from 'zod';
import { CIVIC_CATEGORIES } from '../enums';
import { subcategoryFits } from './ai';
import { UuidSchema } from './common';

/**
 * Áreas municipales (migración 0013). Las define el administrador municipal: nombre, cuál recibe los SOS (una sola),
 * qué categoría (o subcategoría) de reporte urbano atiende cada una y qué cuentas pertenecen a cuál. Las categorías
 * son nacionales y fijas (las define Guard-IA); el municipio solo decide quién las atiende. Sin áreas definidas,
 * todos ven todo.
 */

export const AREA_NAME_MAX = 60;

/** Lo que basta para mostrar el área de un aviso o de una cuenta. */
export const AreaRefSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  receivesSos: z.boolean(),
});
export type AreaRef = z.infer<typeof AreaRefSchema>;

export const AreaSchema = AreaRefSchema.extend({
  active: z.boolean(),
  /** Cuentas activas que pertenecen al área. */
  members: z.number().int(),
  /** Avisos abiertos del área ahora. */
  openAlerts: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type Area = z.infer<typeof AreaSchema>;

/** Qué área atiende una categoría urbana; con subcategoría, solo esa parte (manda sobre la regla de la categoría). */
export const AreaRuleSchema = z.object({
  category: z.enum(CIVIC_CATEGORIES),
  subcategory: z.string().nullable(),
  areaId: UuidSchema,
});
export type AreaRule = z.infer<typeof AreaRuleSchema>;

/** GET /ops/areas: lo que necesita la página de administración de áreas. */
export const AreasConfigSchema = z.object({
  /** Excepción a la regla: todas las áreas ven todos los avisos. */
  shared: z.boolean(),
  areas: z.array(AreaSchema),
  rules: z.array(AreaRuleSchema),
});
export type AreasConfig = z.infer<typeof AreasConfigSchema>;

export const CreateAreaSchema = z.object({
  name: z.string().trim().min(2).max(AREA_NAME_MAX),
  receivesSos: z.boolean().optional(),
});
export type CreateArea = z.infer<typeof CreateAreaSchema>;

export const UpdateAreaSchema = z
  .object({
    name: z.string().trim().min(2).max(AREA_NAME_MAX).optional(),
    active: z.boolean().optional(),
    /** Pasar a recibir los SOS (el área que los recibía deja de hacerlo). */
    receivesSos: z.literal(true).optional(),
  })
  .refine((v) => v.name !== undefined || v.active !== undefined || v.receivesSos !== undefined, 'Nada que cambiar');
export type UpdateArea = z.infer<typeof UpdateAreaSchema>;

/**
 * Reemplaza todas las reglas del municipio. Cada categoría urbana necesita su regla general (sin subcategoría): así
 * ningún reporte queda sin área. Las de subcategoría son opcionales y deben corresponder a su categoría.
 */
export const SetAreaRulesSchema = z
  .object({ rules: z.array(AreaRuleSchema).max(200) })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const [i, r] of v.rules.entries()) {
      const key = `${r.category}/${r.subcategory ?? ''}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['rules', i], message: `Regla repetida: ${key}` });
      seen.add(key);
      if (r.subcategory && !subcategoryFits(r.category, r.subcategory)) {
        ctx.addIssue({ code: 'custom', path: ['rules', i, 'subcategory'], message: `La subcategoría no corresponde a ${r.category}` });
      }
    }
    for (const c of CIVIC_CATEGORIES) {
      if (!v.rules.some((r) => r.category === c && !r.subcategory)) {
        ctx.addIssue({ code: 'custom', path: ['rules'], message: `Falta el área de ${c}` });
      }
    }
  });
export type SetAreaRules = z.infer<typeof SetAreaRulesSchema>;

export const SetAreaModeSchema = z.object({
  shared: z.boolean(),
  reason: z.string().trim().min(5).max(300),
});
export type SetAreaMode = z.infer<typeof SetAreaModeSchema>;

/** Pasar un aviso a otra área del municipio. La decisión de una persona manda sobre la del agente. */
export const ReassignAreaSchema = z.object({
  areaId: UuidSchema,
  reason: z.string().trim().min(5).max(300),
});
export type ReassignArea = z.infer<typeof ReassignAreaSchema>;
