import { z } from 'zod';
import {
  CONSENT_ACTIONS,
  CONSENT_PURPOSES,
  INCIDENT_NATURES,
  MIN_ACCOUNT_AGE,
  SECURITY_INCIDENT_STATUSES,
  SUBPROCESSOR_SERVICES,
} from '../enums';
import { UuidSchema } from './common';

/**
 * Ley 21.719, etapa 1 (docs/plan-ley-21719.md, migración 0014): aviso al vecino, contacto de privacidad del
 * municipio, subencargados autorizados e incidentes de seguridad.
 */

// ------------------------------------------------------------------ aviso al vecino (1.1 y 1.3)

/** Un proveedor que recibe datos del vecino, tal como se le informa (art. 14 ter). */
export const NoticeProcessorSchema = z.object({
  service: z.enum(SUBPROCESSOR_SERVICES),
  name: z.string(),
  country: z.string(),
  data: z.string(),
});
export type NoticeProcessor = z.infer<typeof NoticeProcessorSchema>;

export const NoticeSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  text: z.string(),
});
export type NoticeSection = z.infer<typeof NoticeSectionSchema>;

/**
 * GET /v1/legal/notice — primera capa del aviso (lo que la app muestra antes de aceptar). Lo arma la API con
 * buildLegalNotice y la configuración vigente, así que siempre nombra al proveedor que de verdad se usa. `hash` es el
 * SHA-256 del resto del objeto: al aceptar, la app lo devuelve y la base guarda ese texto exacto (consent_notice).
 */
export const LegalNoticeSchema = z.object({
  version: z.string(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  sections: z.array(NoticeSectionSchema),
  /** Proveedor de IA externo en uso, o null si las alertas se clasifican sin enviar datos fuera. */
  externalAi: NoticeProcessorSchema.nullable(),
  processors: z.array(NoticeProcessorSchema),
  contactEmail: z.string().nullable(),
  policyUrl: z.string().nullable(),
  minAge: z.number().int(),
});
export type LegalNotice = z.infer<typeof LegalNoticeSchema>;

export interface LegalNoticeInput {
  version: string;
  externalAi: NoticeProcessor | null;
  /** Los demás proveedores que reciben datos del vecino (SMS, avisos). */
  processors: NoticeProcessor[];
  contactEmail: string | null;
  policyUrl: string | null;
}

/**
 * Texto de la primera capa, en un solo lugar para revisarlo con asesoría legal (borrador 1, 15-10-2026). Debe decir
 * lo que el sistema hace hoy: si cambia el comportamiento, cambia el texto y sube CONSENT_VERSION.
 */
export function buildLegalNotice(input: LegalNoticeInput): Omit<LegalNotice, 'hash'> {
  const { externalAi, processors, contactEmail } = input;
  const others = processors.map((p) => `${p.name} (${p.country}): ${p.data.charAt(0).toLowerCase()}${p.data.slice(1)}.`);
  const sections: NoticeSection[] = [
    {
      key: 'controller',
      title: 'Quién trata tus datos',
      text:
        'Cada alerta la atiende la municipalidad de la comuna donde ocurre: ella es responsable de los datos de ese ' +
        'caso. Guard-IA opera la app y la plataforma por encargo de las municipalidades.' +
        (contactEmail ? ` Contacto de Guard-IA para tus datos: ${contactEmail}.` : ''),
    },
    {
      key: 'data',
      title: 'Qué datos usamos',
      text:
        'Tu teléfono, para crear la cuenta. Cuando pides ayuda o reportas: tu ubicación en ese momento, el audio, la ' +
        'foto y el texto que envíes. El modo discreto graba 15 segundos de sonido ambiente al activarse. No pedimos ' +
        'tu nombre, RUT ni correo.',
    },
    {
      key: 'purpose',
      title: 'Para qué',
      text:
        'Para que la central de tu municipalidad atienda tu alerta y envíe ayuda, y para detectar avisos falsos. ' +
        'No usamos tus datos para publicidad ni los vendemos.',
    },
    {
      key: 'ai',
      title: 'Análisis con inteligencia artificial',
      text: externalAi
        ? `El audio y el texto de tus alertas se transcriben y clasifican con ${externalAi.name} (${externalAi.country}), ` +
          'sin tu teléfono, tu nombre ni tu ubicación, para priorizar la atención. Puedes desactivarlo cuando quieras en ' +
          '«Mis datos»: la central igual atiende tus alertas.'
        : 'Tus alertas se clasifican en los servidores de Guard-IA, sin enviar su contenido a otros proveedores.',
    },
    {
      key: 'processors',
      title: 'Quién más recibe datos',
      text: others.length
        ? `${others.join(' ')} Cada proveedor trabaja por contrato y solo para esto.`
        : 'Ningún otro proveedor recibe tus datos.',
    },
    {
      key: 'retention',
      title: 'Cuánto tiempo',
      text:
        'El audio y las fotos se borran a los 90 días. El texto, la ubicación y el resultado del caso los conserva tu ' +
        'municipalidad como registro del servicio, por el plazo que ella fije.',
    },
    {
      key: 'misuse',
      title: 'Avisos falsos y prioridad',
      text:
        'Un aviso falso intencional queda registrado 90 días: con dos no puedes enviar reportes urbanos, y con tres tu ' +
        'municipalidad puede bloquear tu cuenta. Si tu historial tiene avisos falsos, un SOS puede quedar con ' +
        'prioridad media, salvo que describa un riesgo para la vida. Siempre puedes pedir revisión.',
    },
    {
      key: 'rights',
      title: 'Tus derechos',
      text:
        'Desde «Mis datos» puedes pedir copia de tus datos, oponerte al análisis con IA o borrar tu cuenta. Si no te ' +
        'responden, puedes reclamar ante la Agencia de Protección de Datos Personales.',
    },
    {
      key: 'age',
      title: 'Edad',
      text: `La app es para personas de ${MIN_ACCOUNT_AGE} años o más. Si eres menor, ante una emergencia llama al 133, 131 o 132 o pide ayuda a un adulto.`,
    },
  ];
  return {
    version: input.version,
    sections,
    externalAi,
    processors,
    contactEmail,
    policyUrl: input.policyUrl,
    minAge: MIN_ACCOUNT_AGE,
  };
}

/** Lo que muestra «Mis datos» del historial (0014). */
export const ConsentHistoryItemSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  action: z.enum(CONSENT_ACTIONS),
  version: z.string(),
  createdAt: z.iso.datetime(),
});
export type ConsentHistoryItem = z.infer<typeof ConsentHistoryItemSchema>;

/** PUT /v1/me/privacy/external-ai — oponerse (o volver a aceptar) el análisis con IA externa. */
export const ExternalAiPreferenceSchema = z.object({ enabled: z.boolean() });
export type ExternalAiPreference = z.infer<typeof ExternalAiPreferenceSchema>;

// ------------------------------------------------------------------ contacto de privacidad del municipio (1.2)

/** Un campo vacío del formulario llega como "" y se guarda como null. */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optional = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const email = z.email('Correo no válido').max(160);

export const TenantPrivacySchema = z.object({
  contactEmail: z.string(),
  contactAddress: z.string().nullable(),
  dpoName: z.string().nullable(),
  dpoEmail: z.string().nullable(),
  policyUrl: z.string().nullable(),
  policyVersion: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type TenantPrivacy = z.infer<typeof TenantPrivacySchema>;

/** PUT /v1/ops/privacy — solo el administrador municipal (el municipio es el responsable). */
export const UpdateTenantPrivacySchema = z.object({
  contactEmail: email,
  contactAddress: optional(200),
  dpoName: optional(120),
  dpoEmail: z.preprocess(blankToNull, email.nullable().optional()),
  policyUrl: z.preprocess(
    blankToNull,
    z
      .url('Dirección no válida')
      .max(300)
      .refine((v) => v.startsWith('https://'), 'La política debe estar en una dirección https')
      .nullable()
      .optional(),
  ),
  policyVersion: optional(40),
});
export type UpdateTenantPrivacy = z.infer<typeof UpdateTenantPrivacySchema>;

// ------------------------------------------------------------------ subencargados (1.4)

export const SubprocessorSchema = z.object({
  id: UuidSchema,
  key: z.string(),
  name: z.string(),
  service: z.enum(SUBPROCESSOR_SERVICES),
  country: z.string(),
  dataCategories: z.string(),
  guarantee: z.string().nullable(),
  inUse: z.boolean(),
  /** Municipios que lo tienen autorizado hoy. */
  authorizedTenants: z.number().int(),
});
export type Subprocessor = z.infer<typeof SubprocessorSchema>;

export const CreateSubprocessorSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Clave: minúsculas, números, guion o guion bajo'),
  name: z.string().trim().min(2).max(120),
  service: z.enum(SUBPROCESSOR_SERVICES),
  country: z.string().trim().min(2).max(80),
  dataCategories: z.string().trim().min(2).max(500),
  guarantee: optional(500),
  inUse: z.boolean().default(false),
});
export type CreateSubprocessor = z.infer<typeof CreateSubprocessorSchema>;

export const UpdateSubprocessorSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    service: z.enum(SUBPROCESSOR_SERVICES).optional(),
    country: z.string().trim().min(2).max(80).optional(),
    dataCategories: z.string().trim().min(2).max(500).optional(),
    guarantee: optional(500),
    inUse: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nada que cambiar');
export type UpdateSubprocessor = z.infer<typeof UpdateSubprocessorSchema>;

/** Una autorización escrita de un municipio a un subencargado (art. 15 bis). */
export const SubprocessorAuthorizationSchema = z.object({
  id: UuidSchema,
  subprocessorId: UuidSchema,
  key: z.string(),
  name: z.string(),
  service: z.enum(SUBPROCESSOR_SERVICES),
  country: z.string(),
  inUse: z.boolean(),
  authorizedAt: z.iso.date(),
  authorizedBy: z.string(),
  documentRef: z.string(),
});
export type SubprocessorAuthorization = z.infer<typeof SubprocessorAuthorizationSchema>;

export const AuthorizeSubprocessorSchema = z.object({
  subprocessorId: UuidSchema,
  authorizedAt: z.iso.date(),
  authorizedBy: z.string().trim().min(2, 'Quién firmó por el municipio').max(120),
  documentRef: z.string().trim().min(2, 'Dónde consta la autorización').max(200),
});
export type AuthorizeSubprocessor = z.infer<typeof AuthorizeSubprocessorSchema>;

// ------------------------------------------------------------------ incidentes de seguridad (1.5)

export const IncidentTenantSchema = z.object({
  tenantId: UuidSchema,
  tenantName: z.string(),
  notifiedAt: z.iso.datetime(),
  agencyReportedAt: z.iso.datetime().nullable(),
  agencyRef: z.string().nullable(),
  subjectsNotifiedAt: z.iso.datetime().nullable(),
  subjectsNote: z.string().nullable(),
});
export type IncidentTenant = z.infer<typeof IncidentTenantSchema>;

export const SecurityIncidentSchema = z.object({
  id: UuidSchema,
  /** Se muestra como INC-0001 (incidentCode). */
  number: z.number().int(),
  detectedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  detectedBy: z.string(),
  nature: z.enum(INCIDENT_NATURES),
  summary: z.string(),
  dataCategories: z.string(),
  affectedEstimate: z.number().int().nullable(),
  sensitiveData: z.boolean(),
  measures: z.string().nullable(),
  status: z.enum(SECURITY_INCIDENT_STATUSES),
  closedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  tenants: z.array(IncidentTenantSchema),
});
export type SecurityIncident = z.infer<typeof SecurityIncidentSchema>;

export function incidentCode(n: number): string {
  return `INC-${String(n).padStart(4, '0')}`;
}

const instant = z.iso.datetime({ offset: true });

export const CreateIncidentSchema = z
  .object({
    detectedAt: instant,
    startedAt: instant.nullable().optional(),
    detectedBy: z.string().trim().min(2).max(120),
    nature: z.enum(INCIDENT_NATURES),
    summary: z.string().trim().min(10, 'Describe qué pasó y sus efectos').max(2000),
    dataCategories: z.string().trim().min(2, 'Qué datos se vieron afectados').max(500),
    affectedEstimate: z.number().int().min(0).nullable().optional(),
    sensitiveData: z.boolean().default(false),
    measures: optional(2000),
    tenantIds: z.array(UuidSchema).max(400).default([]),
  })
  .refine((v) => !v.startedAt || new Date(v.startedAt) <= new Date(v.detectedAt), {
    path: ['startedAt'],
    message: 'El inicio no puede ser posterior a la detección',
  });
export type CreateIncident = z.infer<typeof CreateIncidentSchema>;

export const UpdateIncidentSchema = z
  .object({
    startedAt: instant.nullable().optional(),
    summary: z.string().trim().min(10).max(2000).optional(),
    dataCategories: z.string().trim().min(2).max(500).optional(),
    affectedEstimate: z.number().int().min(0).nullable().optional(),
    sensitiveData: z.boolean().optional(),
    measures: optional(2000),
    status: z.enum(SECURITY_INCIDENT_STATUSES).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nada que cambiar');
export type UpdateIncident = z.infer<typeof UpdateIncidentSchema>;

/** POST /v1/platform/incidents/:id/tenants — Guard-IA avisa a un municipio afectado (art. 15 bis). */
export const NotifyIncidentTenantSchema = z.object({ tenantId: UuidSchema });
export type NotifyIncidentTenant = z.infer<typeof NotifyIncidentTenantSchema>;

/** La central registra su reporte a la Agencia (art. 14 sexies) o el aviso a los vecinos, o por qué no correspondía. */
export const RecordIncidentReportSchema = z
  .object({
    agencyReportedAt: instant.nullable().optional(),
    agencyRef: optional(200),
    subjectsNotifiedAt: instant.nullable().optional(),
    subjectsNote: optional(1000),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nada que registrar');
export type RecordIncidentReport = z.infer<typeof RecordIncidentReportSchema>;

/** Un incidente visto desde la central: sin quién lo detectó en Guard-IA ni los otros municipios afectados. */
export const TenantIncidentSchema = SecurityIncidentSchema.omit({ tenants: true, detectedBy: true }).extend({
  tenant: IncidentTenantSchema,
});
export type TenantIncident = z.infer<typeof TenantIncidentSchema>;

/** GET /v1/ops/privacy — lo que la central ve de su municipio en «Privacidad». */
export const TenantPrivacyOverviewSchema = z.object({
  privacy: TenantPrivacySchema.nullable(),
  subprocessors: z.array(SubprocessorAuthorizationSchema),
  /** Subencargados en uso que el municipio aún no autoriza. */
  missingSubprocessors: z.array(z.object({ name: z.string(), service: z.enum(SUBPROCESSOR_SERVICES) })),
  incidents: z.array(TenantIncidentSchema),
});
export type TenantPrivacyOverview = z.infer<typeof TenantPrivacyOverviewSchema>;
