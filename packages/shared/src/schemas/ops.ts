import { z } from 'zod';
import {
  ALERT_STATUSES,
  ALERT_TYPES,
  DISPATCH_STATUSES,
  REJECT_REASONS,
  UNIT_KINDS,
  UNIT_STATUSES,
} from '../enums';
import { CursorPaginationSchema, LocationSchema, UuidSchema } from './common';

export const OpsAlertsQuerySchema = CursorPaginationSchema.extend({
  status: z
    .union([z.enum(ALERT_STATUSES), z.array(z.enum(ALERT_STATUSES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  type: z.enum(ALERT_TYPES).optional(),
  since: z.iso.datetime().optional(),
});
export type OpsAlertsQuery = z.infer<typeof OpsAlertsQuerySchema>;

export const RejectAlertSchema = z.object({
  reason: z.enum(REJECT_REASONS),
  notes: z.string().trim().max(1000).optional(),
});
export type RejectAlert = z.infer<typeof RejectAlertSchema>;

export const DispatchAlertSchema = z.object({
  unitId: UuidSchema,
  notes: z.string().trim().max(1000).optional(),
});
export type DispatchAlert = z.infer<typeof DispatchAlertSchema>;

export const UpdateDispatchSchema = z.object({
  status: z.enum(DISPATCH_STATUSES),
  notes: z.string().trim().max(1000).optional(),
});
export type UpdateDispatch = z.infer<typeof UpdateDispatchSchema>;

export const ResolveAlertSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
});
export type ResolveAlert = z.infer<typeof ResolveAlertSchema>;

export const AddNoteSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});
export type AddNote = z.infer<typeof AddNoteSchema>;

export const UnitSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  kind: z.enum(UNIT_KINDS),
  status: z.enum(UNIT_STATUSES),
  lastLocation: LocationSchema.nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type Unit = z.infer<typeof UnitSchema>;

export const CreateUnitSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{3,20}$/, 'Código en mayúsculas, dígitos y guiones'),
  kind: z.enum(UNIT_KINDS),
});
export type CreateUnit = z.infer<typeof CreateUnitSchema>;

export const UpdateUnitSchema = z.object({
  status: z.enum(UNIT_STATUSES).optional(),
  kind: z.enum(UNIT_KINDS).optional(),
  lastLocation: LocationSchema.optional(),
});
export type UpdateUnit = z.infer<typeof UpdateUnitSchema>;

export const SignedUrlSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
});
export type SignedUrl = z.infer<typeof SignedUrlSchema>;
