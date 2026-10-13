import { z } from 'zod';

export const UuidSchema = z.uuid();

/** Teléfono en formato E.164, por ejemplo +56912345678. */
export const PhoneSchema = z.e164();

export const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type Location = z.infer<typeof LocationSchema>;

export const CursorPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type CursorPagination = z.infer<typeof CursorPaginationSchema>;

/** Formato de error de la API: { code, message, details? }. */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'CONSENT_REQUIRED',
  'ALERT_OUT_OF_COVERAGE',
  'INVALID_TRANSITION',
  'CANCEL_WINDOW_EXPIRED',
  'UNIT_UNAVAILABLE',
  'MEDIA_TOO_LARGE',
  'PASSWORD_CHANGE_REQUIRED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
