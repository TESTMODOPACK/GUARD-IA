import { z } from 'zod';
import {
  AI_STATUSES,
  ALERT_CATEGORIES,
  ALERT_EVENT_KINDS,
  ALERT_SOURCES,
  ALERT_STATUSES,
  ALERT_TYPES,
  ACTOR_TYPES,
  DISPATCH_OUTCOMES,
  DISPATCH_STATUSES,
  REJECT_REASONS,
  MEDIA_KINDS,
  PRIORITIES,
  SUGGESTED_AGENCIES,
  categoriesFor,
} from '../enums';
import { LocationSchema, UuidSchema } from './common';
import { AiFlagsSchema, TriageSchema } from './ai';
import { IncidentInfoSchema } from './incident';

/**
 * Campo `meta` (JSON) del multipart de POST /v1/alerts.
 * El audio y la foto viajan como archivos en el mismo request.
 */
export const CreateAlertMetaSchema = z
  .object({
    type: z.enum(ALERT_TYPES),
    source: z.enum(ALERT_SOURCES),
    location: LocationSchema,
    accuracyM: z.number().min(0).max(10_000).optional(),
    userText: z.string().trim().max(1000).optional(),
    /** Solo para CIVIC_REPORT: la categoría que eligió el vecino en el formulario. */
    category: z.enum(ALERT_CATEGORIES).optional(),
    /** Idempotencia: la app genera un UUID por intento y lo reintenta sin duplicar. */
    clientRef: UuidSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.category && !categoriesFor(v.type).includes(v.category)) {
      ctx.addIssue({
        code: 'custom',
        path: ['category'],
        message: `La categoría ${v.category} no corresponde al tipo ${v.type}`,
      });
    }
    if (v.type === 'CIVIC_REPORT' && v.source === 'DISCREET') {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Un reporte urbano no puede ser DISCREET',
      });
    }
  });
export type CreateAlertMeta = z.infer<typeof CreateAlertMetaSchema>;

/**
 * Lo que el operador confirmó o corrigió (migración 0005, tabla triage_label): la clasificación
 * correcta y las instituciones a las que efectivamente derivó. Es también el dato con el que se
 * mide y mejora el agente de clasificación.
 */
export const TriageLabelSchema = z.object({
  category: z.enum(ALERT_CATEGORIES).nullable(),
  subcategory: z.string().nullable(),
  agencies: z.array(z.enum(SUGGESTED_AGENCIES)),
  classifiedBy: z.string().nullable(),
  classifiedAt: z.iso.datetime().nullable(),
  referredBy: z.string().nullable(),
  referredAt: z.iso.datetime().nullable(),
});
export type TriageLabel = z.infer<typeof TriageLabelSchema>;

/**
 * Dónde cae la alerta y dónde dice el vecino que ocurre (migración 0006). La central lo usa para
 * ver si corresponde a otro municipio y traspasarla.
 */
export const GeoContextSchema = z.object({
  /** Comuna del punto GPS (null si no hay comunas cargadas). */
  comuna: z.object({ cut: z.number().int(), name: z.string() }).nullable(),
  /** Comuna que nombra el vecino, si no es la del GPS; con el municipio de Guard-IA que la atiende. */
  mentioned: z
    .object({
      name: z.string(),
      cut: z.number().int().nullable(),
      tenantId: UuidSchema.nullable(),
      tenantName: z.string().nullable(),
      distanceM: z.number().int().nullable(),
    })
    .nullable(),
  /** Otros municipios de Guard-IA dentro del margen de error del GPS. */
  nearby: z.array(z.object({ tenantId: UuidSchema, tenantName: z.string(), distanceM: z.number().int() })),
});
export type GeoContext = z.infer<typeof GeoContextSchema>;

export const MediaPublicSchema = z.object({
  id: UuidSchema,
  kind: z.enum(MEDIA_KINDS),
  mime: z.string(),
  bytes: z.number().int(),
  durationS: z.number().nullable(),
  /** URL firmada de corta duración; null si el archivo ya fue purgado. */
  url: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
export type MediaPublic = z.infer<typeof MediaPublicSchema>;

export const DispatchSchema = z.object({
  id: UuidSchema,
  alertId: UuidSchema,
  unitId: UuidSchema,
  unitCode: z.string(),
  operatorId: UuidSchema,
  status: z.enum(DISPATCH_STATUSES),
  notes: z.string().nullable(),
  /** Resultado en terreno (migración 0008); null mientras nadie lo informa. */
  outcome: z.enum(DISPATCH_OUTCOMES).nullable(),
  outcomeNote: z.string().nullable(),
  outcomeAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type Dispatch = z.infer<typeof DispatchSchema>;

export const AlertEventSchema = z.object({
  id: UuidSchema,
  alertId: UuidSchema,
  actorType: z.enum(ACTOR_TYPES),
  actorId: UuidSchema.nullable(),
  kind: z.enum(ALERT_EVENT_KINDS),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

/** Resumen que viaja en listas y en `alert.created`. Sin transcripción ni media. */
export const AlertSummarySchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema.nullable(),
  citizenId: UuidSchema,
  type: z.enum(ALERT_TYPES),
  source: z.enum(ALERT_SOURCES),
  location: LocationSchema,
  accuracyM: z.number().nullable(),
  category: z.enum(ALERT_CATEGORIES).nullable(),
  /** Detalle de la categoría (SUBCATEGORIES en schemas/ai.ts); migración 0005. */
  subcategory: z.string().nullable(),
  priority: z.enum(PRIORITIES).nullable(),
  /** Primera institución sugerida (la lista completa con motivos viaja en `triage`). */
  suggestedAgency: z.enum(SUGGESTED_AGENCIES).nullable(),
  aiStatus: z.enum(AI_STATUSES),
  aiSummary: z.string().nullable(),
  status: z.enum(ALERT_STATUSES),
  hasAudio: z.boolean(),
  hasPhoto: z.boolean(),
  citizenTrustScore: z.number().int().nullable(),
  /** Grupo de alertas sobre la misma situación (migración 0004); null mientras no se agrupa. */
  incident: IncidentInfoSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AlertSummary = z.infer<typeof AlertSummarySchema>;

/** Ficha completa para GET /v1/ops/alerts/:id y para `alert.updated`. */
export const AlertDetailSchema = AlertSummarySchema.extend({
  addressHint: z.string().nullable(),
  userText: z.string().nullable(),
  transcription: z.string().nullable(),
  aiConfidence: z.number().nullable(),
  aiFlags: AiFlagsSchema.nullable(),
  aiError: z.string().nullable(),
  /** Agente de clasificación: instituciones con motivo, preguntas y reglas aplicadas. */
  triage: TriageSchema.nullable(),
  triageLabel: TriageLabelSchema.nullable(),
  geo: GeoContextSchema,
  acknowledgedBy: UuidSchema.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  citizenPhone: z.string().nullable(),
  citizenName: z.string().nullable(),
  /** Faltas vigentes del vecino por avisos falsos (en todo el país, últimos 90 días). */
  citizenStrikes: z.number().int(),
  media: z.array(MediaPublicSchema),
  dispatches: z.array(DispatchSchema),
  events: z.array(AlertEventSchema),
});
export type AlertDetail = z.infer<typeof AlertDetailSchema>;

/** Lo que ve el vecino de su propia alerta. */
export const CitizenAlertSchema = z.object({
  id: UuidSchema,
  type: z.enum(ALERT_TYPES),
  source: z.enum(ALERT_SOURCES),
  category: z.enum(ALERT_CATEGORIES).nullable(),
  status: z.enum(ALERT_STATUSES),
  tenantName: z.string().nullable(),
  /** Comuna donde está el vecino (sirve aunque su municipio no use Guard-IA). */
  comunaName: z.string().nullable(),
  /** Si la central la cerró sin despacho: por qué (la app explica cada motivo). */
  closeReason: z.enum(REJECT_REASONS).nullable(),
  /** Con closeReason FALSE_ALARM: cuántas faltas vigentes tiene ahora (1.ª, 2.ª advertencia…). */
  strikeCount: z.number().int().nullable(),
  activeDispatch: z
    .object({
      unitCode: z.string(),
      status: z.enum(DISPATCH_STATUSES),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CitizenAlert = z.infer<typeof CitizenAlertSchema>;

export const CreateAlertResponseSchema = z.object({
  alertId: UuidSchema,
  status: z.enum(ALERT_STATUSES),
  tenant: z.object({ id: UuidSchema, name: z.string() }).nullable(),
  /** Hasta cuándo (ISO) el vecino puede cancelar. */
  cancellableUntil: z.iso.datetime(),
});
export type CreateAlertResponse = z.infer<typeof CreateAlertResponseSchema>;
