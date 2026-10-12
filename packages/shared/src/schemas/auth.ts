import { z } from 'zod';
import { OPERATOR_ROLES } from '../enums';
import { PhoneSchema, UuidSchema } from './common';

export const OtpRequestSchema = z.object({
  phone: PhoneSchema,
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  phone: PhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(20),
});
export type Refresh = z.infer<typeof RefreshSchema>;

export const ConsentSchema = z.object({
  version: z.string().min(1).max(20),
});
export type Consent = z.infer<typeof ConsentSchema>;

export const DeviceUpsertSchema = z.object({
  expoPushToken: z.string().min(10).max(200),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().max(40).optional(),
});
export type DeviceUpsert = z.infer<typeof DeviceUpsertSchema>;

export const OperatorLoginSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
});
export type OperatorLogin = z.infer<typeof OperatorLoginSchema>;

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const CitizenPublicSchema = z.object({
  id: UuidSchema,
  phone: PhoneSchema,
  name: z.string().nullable(),
  trustScore: z.number().int(),
  consentVersion: z.string().nullable(),
  consentAt: z.iso.datetime().nullable(),
});
export type CitizenPublic = z.infer<typeof CitizenPublicSchema>;

export const OperatorPublicSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  tenantName: z.string(),
  email: z.email(),
  name: z.string(),
  role: z.enum(OPERATOR_ROLES),
});
export type OperatorPublic = z.infer<typeof OperatorPublicSchema>;

/** Claims del JWT de acceso. `kind` decide qué guard aplica. */
export const AccessClaimsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('citizen'),
    sub: UuidSchema,
  }),
  z.object({
    kind: z.literal('operator'),
    sub: UuidSchema,
    tenantId: UuidSchema,
    role: z.enum(OPERATOR_ROLES),
  }),
]);
export type AccessClaims = z.infer<typeof AccessClaimsSchema>;
