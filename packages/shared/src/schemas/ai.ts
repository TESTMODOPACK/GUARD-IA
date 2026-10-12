import { z } from 'zod';
import { ALERT_CATEGORIES, PRIORITIES, SUGGESTED_AGENCIES } from '../enums';
import { AiFlagsSchema } from './alert';

/** Salida estricta del clasificador (sección 8 del documento de Fase 0). */
export const AiClassificationSchema = z.object({
  category: z.enum(ALERT_CATEGORIES),
  priority: z.enum(PRIORITIES),
  suggested_agency: z.enum(SUGGESTED_AGENCIES),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(200),
  flags: AiFlagsSchema,
});
export type AiClassification = z.infer<typeof AiClassificationSchema>;

/**
 * JSON Schema equivalente, en el formato `strict` de OpenAI
 * (todas las propiedades requeridas y additionalProperties=false).
 * Se mantiene a mano para que el contrato sea explícito y auditable.
 */
export const AI_CLASSIFICATION_JSON_SCHEMA = {
  name: 'alert_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'priority', 'suggested_agency', 'confidence', 'summary', 'flags'],
    properties: {
      category: { type: 'string', enum: [...ALERT_CATEGORIES] },
      priority: { type: 'string', enum: [...PRIORITIES] },
      suggested_agency: { type: 'string', enum: [...SUGGESTED_AGENCIES] },
      confidence: { type: 'number' },
      summary: { type: 'string' },
      flags: {
        type: 'object',
        additionalProperties: false,
        required: [
          'possible_false_alarm',
          'weapon_mentioned',
          'people_injured',
          'minor_involved',
          'language_other_than_spanish',
        ],
        properties: {
          possible_false_alarm: { type: 'boolean' },
          weapon_mentioned: { type: 'boolean' },
          people_injured: { type: 'boolean' },
          minor_involved: { type: 'boolean' },
          language_other_than_spanish: { type: 'boolean' },
        },
      },
    },
  },
} as const;
