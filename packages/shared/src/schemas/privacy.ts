import { z } from 'zod';
import {
  ALERT_CATEGORIES,
  ALERT_EVENT_KINDS,
  ALERT_SOURCES,
  ALERT_STATUSES,
  ALERT_TYPES,
  CITIZEN_BLOCK_STATUSES,
  CITIZEN_REVIEW_STATUSES,
  MEDIA_KINDS,
} from '../enums';
import { CitizenPublicSchema } from './auth';
import { ConsentHistoryItemSchema } from './legal';
import { LocationSchema, UuidSchema } from './common';

/**
 * GET /v1/me/export — derecho de acceso (Ley 21.719): todo lo que Guard-IA guarda del vecino, en un
 * JSON descargable. Los archivos van como metadatos (no se incluye el audio); los eventos, sin datos
 * de operadores.
 */
export const CitizenExportSchema = z.object({
  exportedAt: z.iso.datetime(),
  citizen: CitizenPublicSchema.extend({ createdAt: z.iso.datetime() }),
  /** Historial de consentimientos (0014): cada aceptación o revocación, con la versión del aviso. */
  consents: z.array(ConsentHistoryItemSchema),
  /** Faltas por aviso falso (migración 0008), con la evidencia que escribió la central. */
  strikes: z.array(
    z.object({
      municipality: z.string(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      annulled: z.boolean(),
      note: z.string(),
    }),
  ),
  /** Bloqueos (0011): propuestos, decididos o levantados, con el motivo que escribió el municipio. */
  blocks: z.array(
    z.object({
      municipality: z.string(),
      status: z.enum(CITIZEN_BLOCK_STATUSES),
      proposedAt: z.iso.datetime(),
      startsAt: z.iso.datetime().nullable(),
      endsAt: z.iso.datetime().nullable(),
      decisionNote: z.string().nullable(),
    }),
  ),
  /** Revisiones que pidió el vecino y la respuesta del municipio (0011). */
  reviews: z.array(
    z.object({
      municipality: z.string(),
      target: z.enum(['STRIKE', 'BLOCK']),
      text: z.string(),
      status: z.enum(CITIZEN_REVIEW_STATUSES),
      response: z.string().nullable(),
      createdAt: z.iso.datetime(),
      resolvedAt: z.iso.datetime().nullable(),
    }),
  ),
  devices: z.array(
    z.object({
      platform: z.enum(['ios', 'android']),
      appVersion: z.string().nullable(),
      lastSeenAt: z.iso.datetime(),
    }),
  ),
  alerts: z.array(
    z.object({
      id: UuidSchema,
      type: z.enum(ALERT_TYPES),
      source: z.enum(ALERT_SOURCES),
      status: z.enum(ALERT_STATUSES),
      category: z.enum(ALERT_CATEGORIES).nullable(),
      location: LocationSchema,
      accuracyM: z.number().nullable(),
      userText: z.string().nullable(),
      transcription: z.string().nullable(),
      aiSummary: z.string().nullable(),
      createdAt: z.iso.datetime(),
      media: z.array(
        z.object({
          kind: z.enum(MEDIA_KINDS),
          mime: z.string(),
          bytes: z.number().int(),
          retentionUntil: z.iso.datetime(),
          deleted: z.boolean(),
        }),
      ),
      events: z.array(z.object({ kind: z.enum(ALERT_EVENT_KINDS), createdAt: z.iso.datetime() })),
    }),
  ),
});
export type CitizenExport = z.infer<typeof CitizenExportSchema>;

/** DELETE /v1/me — derecho de supresión: qué se hizo (la cuenta queda anonimizada, no borrada). */
export const CitizenEraseResultSchema = z.object({
  erased: z.literal(true),
  mediaPurged: z.number().int(),
});
export type CitizenEraseResult = z.infer<typeof CitizenEraseResultSchema>;
