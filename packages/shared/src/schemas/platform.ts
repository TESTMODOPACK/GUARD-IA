import { z } from 'zod';
import {
  COMUNA_SERVICE_STATUSES,
  PLATFORM_ACTIONS,
  PLATFORM_ROLES,
  READINESS_KEYS,
  TENANT_STATUSES,
} from '../enums';
import { PhoneSchema, UuidSchema } from './common';

/**
 * Consola de plataforma (migración 0010, docs/plan-plataforma.md fase P1): el equipo Guard-IA ve las
 * comunas por región, da de alta municipios, los activa, suspende o da de baja y crea su administrador.
 * Nunca ve vecinos, alertas ni casos: solo metadatos y cifras.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

// ------------------------------------------------------------------ RUT

/** Normaliza "69.070.100-7" o "690701007" a "69070100-7". No valida el dígito. */
export function normalizeRut(raw: string): string {
  const clean = raw.replace(/[.\s-]/g, '').toUpperCase();
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

/** Dígito verificador (módulo 11) de un RUT ya normalizado. */
export function isValidRut(rut: string): boolean {
  const m = /^(\d{7,8})-([\dK])$/.exec(rut);
  if (!m) return false;
  let sum = 0;
  let factor = 2;
  for (let i = m[1].length - 1; i >= 0; i--) {
    sum += Number(m[1][i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const rest = 11 - (sum % 11);
  const dv = rest === 11 ? '0' : rest === 10 ? 'K' : String(rest);
  return dv === m[2];
}

export const RutSchema = z
  .string()
  .trim()
  .min(8)
  .max(12)
  .transform(normalizeRut)
  .refine(isValidRut, 'RUT inválido');

// ------------------------------------------------------------------ ingreso

/** La consola exige más que la central: quien entra ve todos los municipios. */
export const PLATFORM_PASSWORD_MIN_LENGTH = 12;

export const PlatformLoginSchema = z.object({
  email: z.email().max(160).transform((v) => v.toLowerCase()),
  password: z.string().min(8).max(200),
});
export type PlatformLogin = z.infer<typeof PlatformLoginSchema>;

/**
 * Paso 1 correcto: la consola pide el código. `enroll` es el primer ingreso (o tras un restablecimiento):
 * la clave se muestra una sola vez para cargarla en la app de autenticación.
 */
export const PlatformLoginStepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('totp'), challengeToken: z.string() }),
  z.object({
    step: z.literal('enroll'),
    challengeToken: z.string(),
    /** Clave en base32, para escribirla a mano en la app de autenticación. */
    secret: z.string(),
    otpauthUri: z.string(),
  }),
]);
export type PlatformLoginStep = z.infer<typeof PlatformLoginStepSchema>;

export const PlatformTotpSchema = z.object({
  challengeToken: z.string().min(20).max(2000),
  code: z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
});
export type PlatformTotp = z.infer<typeof PlatformTotpSchema>;

export const PlatformUserPublicSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string(),
  role: z.enum(PLATFORM_ROLES),
  mustChangePassword: z.boolean(),
});
export type PlatformUserPublic = z.infer<typeof PlatformUserPublicSchema>;

export const PlatformSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  user: PlatformUserPublicSchema,
});
export type PlatformSession = z.infer<typeof PlatformSessionSchema>;

export const PlatformChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z
      .string()
      .min(PLATFORM_PASSWORD_MIN_LENGTH, `Mínimo ${PLATFORM_PASSWORD_MIN_LENGTH} caracteres`)
      .max(200),
  })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'La nueva contraseña debe ser distinta', path: ['newPassword'] });
export type PlatformChangePassword = z.infer<typeof PlatformChangePasswordSchema>;

// ------------------------------------------------------------------ regiones y comunas

export const RegionSummarySchema = z.object({
  cut: z.number().int(),
  name: z.string(),
  roman: z.string(),
  sortOrder: z.number().int(),
  comunas: z.number().int(),
  /** Comunas por estado de su municipio; `AVAILABLE` = sin Guard-IA. */
  byStatus: z.record(z.enum(COMUNA_SERVICE_STATUSES), z.number().int()),
  alertsMonth: z.number().int(),
  /** SOS y reportes desde comunas sin servicio en los últimos 30 días. */
  unservedMonth: z.number().int(),
});
export type RegionSummary = z.infer<typeof RegionSummarySchema>;

export const ComunaRowSchema = z.object({
  cut: z.number().int(),
  name: z.string(),
  regionCut: z.number().int(),
  regionName: z.string(),
  provinciaCut: z.number().int(),
  provinciaName: z.string(),
  status: z.enum(COMUNA_SERVICE_STATUSES),
  tenantId: UuidSchema.nullable(),
  tenantName: z.string().nullable(),
  alertsMonth: z.number().int(),
  openAlerts: z.number().int(),
  unservedSos: z.number().int(),
  unservedReports: z.number().int(),
});
export type ComunaRow = z.infer<typeof ComunaRowSchema>;

export const RegionDetailSchema = z.object({
  region: RegionSummarySchema,
  provincias: z.array(z.object({ cut: z.number().int(), name: z.string() })),
  comunas: z.array(ComunaRowSchema),
});
export type RegionDetail = z.infer<typeof RegionDetailSchema>;

export const ComunaSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
});
export type ComunaSearchQuery = z.infer<typeof ComunaSearchQuerySchema>;

/** GeoJSON para el mapa: una feature por comuna con su estado (geometría simplificada). */
export interface ComunaMapFeature {
  type: 'Feature';
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
  properties: { cut: number; name: string; status: (typeof COMUNA_SERVICE_STATUSES)[number] };
}
export interface ComunaMap {
  type: 'FeatureCollection';
  features: ComunaMapFeature[];
}

// ------------------------------------------------------------------ municipios

export const ReadinessItemSchema = z.object({
  key: z.enum(READINESS_KEYS),
  count: z.number().int(),
  required: z.number().int(),
  ok: z.boolean(),
});
export type ReadinessItem = z.infer<typeof ReadinessItemSchema>;

export const TenantAdminSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string(),
  active: z.boolean(),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type TenantAdmin = z.infer<typeof TenantAdminSchema>;

export const TestPhoneSchema = z.object({
  id: UuidSchema,
  phone: PhoneSchema,
  label: z.string(),
  createdAt: z.iso.datetime(),
});
export type TestPhone = z.infer<typeof TestPhoneSchema>;

export const TenantListItemSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  status: z.enum(TENANT_STATUSES),
  comunaCut: z.number().int().nullable(),
  comunaName: z.string().nullable(),
  regionCut: z.number().int().nullable(),
  regionName: z.string().nullable(),
  statusChangedAt: z.iso.datetime(),
  goLiveAt: z.iso.datetime().nullable(),
  alertsMonth: z.number().int(),
  openAlerts: z.number().int(),
});
export type TenantListItem = z.infer<typeof TenantListItemSchema>;

export const TenantDetailSchema = TenantListItemSchema.extend({
  legalName: z.string().nullable(),
  rut: z.string().nullable(),
  address: z.string().nullable(),
  techContactName: z.string().nullable(),
  techContactEmail: z.string().nullable(),
  techContactPhone: z.string().nullable(),
  billingContactName: z.string().nullable(),
  billingContactEmail: z.string().nullable(),
  provinciaName: z.string().nullable(),
  statusReason: z.string().nullable(),
  contractSignedAt: z.iso.date().nullable(),
  dpaSignedAt: z.iso.date().nullable(),
  audioRetentionDays: z.number().int(),
  createdAt: z.iso.datetime(),
  sosMonth: z.number().int(),
  readiness: z.object({ ready: z.boolean(), items: z.array(ReadinessItemSchema) }),
  /** Estados a los que puede pasar ahora (TENANT_TRANSITIONS). */
  transitions: z.array(z.enum(TENANT_STATUSES)),
  admins: z.array(TenantAdminSchema),
  testPhones: z.array(TestPhoneSchema),
});
export type TenantDetail = z.infer<typeof TenantDetailSchema>;

const profileInput = {
  legalName: optionalText(160),
  rut: RutSchema.nullable().optional(),
  address: optionalText(200),
  techContactName: optionalText(120),
  techContactEmail: z.email().max(160).nullable().optional(),
  techContactPhone: optionalText(30),
  billingContactName: optionalText(120),
  billingContactEmail: z.email().max(160).nullable().optional(),
};

/** Alta desde una comuna (RF-3.1). El nombre por defecto es "Municipalidad de <comuna>". */
export const CreateTenantSchema = z.object({
  comunaCut: z.number().int().min(1000).max(99999),
  name: z.string().trim().min(2).max(120).optional(),
  ...profileInput,
});
export type CreateTenant = z.infer<typeof CreateTenantSchema>;

export const UpdateTenantSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    audioRetentionDays: z.number().int().min(1).max(3650).optional(),
    contractSignedAt: z.iso.date().nullable().optional(),
    dpaSignedAt: z.iso.date().nullable().optional(),
    ...profileInput,
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nada que cambiar');
export type UpdateTenant = z.infer<typeof UpdateTenantSchema>;

/**
 * Activar, suspender o dar de baja. Se confirma escribiendo el nombre de la comuna (o del municipio, si
 * no tiene comuna) y siempre con motivo: queda en ambas bitácoras.
 */
export const ChangeTenantStatusSchema = z.object({
  status: z.enum(TENANT_STATUSES),
  reason: z.string().trim().min(5, 'Escribe el motivo').max(500),
  confirmName: z.string().trim().min(2).max(120),
});
export type ChangeTenantStatus = z.infer<typeof ChangeTenantStatusSchema>;

export const CreateTenantAdminSchema = z.object({
  email: z.email().max(160).transform((v) => v.toLowerCase()),
  name: z.string().trim().min(2).max(80),
});
export type CreateTenantAdmin = z.infer<typeof CreateTenantAdminSchema>;

/** La contraseña temporal se muestra una sola vez; quien la recibe la cambia al entrar. */
export const TenantAdminPasswordSchema = z.object({
  admin: TenantAdminSchema,
  temporaryPassword: z.string(),
});
export type TenantAdminPassword = z.infer<typeof TenantAdminPasswordSchema>;

export const TestPhoneInputSchema = z.object({
  phone: PhoneSchema,
  label: z.string().trim().min(2).max(80),
});
export type TestPhoneInput = z.infer<typeof TestPhoneInputSchema>;

// ------------------------------------------------------------------ bitácora

export const PlatformAuditEntrySchema = z.object({
  id: UuidSchema,
  createdAt: z.iso.datetime(),
  action: z.enum(PLATFORM_ACTIONS),
  actorName: z.string().nullable(),
  tenantId: UuidSchema.nullable(),
  tenantName: z.string().nullable(),
  comunaCut: z.number().int().nullable(),
  targetId: UuidSchema.nullable(),
  reason: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
});
export type PlatformAuditEntry = z.infer<typeof PlatformAuditEntrySchema>;

export const PlatformAuditQuerySchema = z.object({
  tenantId: UuidSchema.optional(),
  /** `createdAt|id` de la última fila vista. */
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PlatformAuditQuery = z.infer<typeof PlatformAuditQuerySchema>;

export type PlatformAuditPage = { items: PlatformAuditEntry[]; nextCursor: string | null };

// ------------------------------------------------------------------ usuarios de plataforma

export const PlatformUserAccountSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string(),
  role: z.enum(PLATFORM_ROLES),
  active: z.boolean(),
  mustChangePassword: z.boolean(),
  totpEnabled: z.boolean(),
  lockedUntil: z.iso.datetime().nullable(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PlatformUserAccount = z.infer<typeof PlatformUserAccountSchema>;

export const CreatePlatformUserSchema = z.object({
  email: z.email().max(160).transform((v) => v.toLowerCase()),
  name: z.string().trim().min(2).max(120),
  role: z.enum(PLATFORM_ROLES),
});
export type CreatePlatformUser = z.infer<typeof CreatePlatformUserSchema>;

export const UpdatePlatformUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    role: z.enum(PLATFORM_ROLES).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.role !== undefined || v.active !== undefined, 'Nada que cambiar');
export type UpdatePlatformUser = z.infer<typeof UpdatePlatformUserSchema>;

/** Alta o restablecimiento: contraseña temporal (una vez) y segundo factor por enrolar en el próximo ingreso. */
export const PlatformUserPasswordSchema = z.object({
  user: PlatformUserAccountSchema,
  temporaryPassword: z.string(),
});
export type PlatformUserPassword = z.infer<typeof PlatformUserPasswordSchema>;
