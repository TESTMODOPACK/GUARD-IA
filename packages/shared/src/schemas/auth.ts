import { z } from 'zod';
import { MIN_ACCOUNT_AGE, OPERATOR_ROLES, TENANT_STATUSES } from '../enums';
import { CitizenAccountSchema } from './account';
import { AreaRefSchema } from './areas';
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

/**
 * POST /v1/me/consent (0014). `noticeHash` es el del aviso que la app mostró (GET /legal/notice): la base guarda ese
 * texto exacto como prueba. `externalAi`: si acepta el análisis con IA externa (puede cambiarlo en «Mis datos»).
 */
export const ConsentSchema = z.object({
  version: z.string().min(1).max(20),
  noticeHash: z.string().regex(/^[0-9a-f]{64}$/, 'Aviso no válido'),
  externalAi: z.boolean(),
  ageConfirmed: z.literal(true, { error: `La app es para personas de ${MIN_ACCOUNT_AGE} años o más` }),
  appVersion: z.string().max(40).optional(),
  platform: z.enum(['ios', 'android', 'web']).optional(),
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
  /** Acepta el análisis con IA externa (0014). Opcional: una sesión guardada antes no lo trae. */
  externalAi: z.boolean().optional(),
  /**
   * Estado de la cuenta por uso indebido (0011). Opcional: una sesión guardada antes de 0011 no lo trae; la
   * app lo refresca con GET /me al abrir.
   */
  account: CitizenAccountSchema.optional(),
});
export type CitizenPublic = z.infer<typeof CitizenPublicSchema>;

export const OperatorPublicSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  tenantName: z.string(),
  email: z.email(),
  name: z.string(),
  role: z.enum(OPERATOR_ROLES),
  /** Cuenta nueva o contraseña restablecida: la central pide cambiarla antes de operar. */
  mustChangePassword: z.boolean(),
  /** Estado del municipio (0010): la central avisa si está suspendido. */
  tenantStatus: z.enum(TENANT_STATUSES),
  /** Áreas a las que pertenece (0013). */
  areas: z.array(AreaRefSchema).default([]),
  /** Ve todos los avisos: administrador, municipio en modo compartido o sin áreas definidas. */
  seesAll: z.boolean().default(true),
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
