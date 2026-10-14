/**
 * Enums del dominio. Los valores coinciden 1:1 con los tipos ENUM de PostgreSQL
 * definidos en apps/api/src/db/migrations/0001_init.sql.
 */

export const ALERT_TYPES = ['EMERGENCY_SOS', 'CIVIC_REPORT'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SOURCES = ['BUTTON', 'VOICE', 'DISCREET', 'FORM'] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

export const EMERGENCY_CATEGORIES = [
  'ROBO_ASALTO',
  'VIOLENCIA_AGRESION',
  'INCENDIO',
  'SALUD',
  'ACCIDENTE_TRANSITO',
  'SOSPECHOSO',
  'OTRO_EMERGENCIA',
] as const;
export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number];

export const CIVIC_CATEGORIES = [
  'BACHE',
  'LUMINARIA',
  'BASURA_MICROBASURAL',
  'SEMAFORO',
  'AREA_VERDE',
  'ANIMAL',
  'OTRO_URBANO',
] as const;
export type CivicCategory = (typeof CIVIC_CATEGORIES)[number];

export const ALERT_CATEGORIES = [...EMERGENCY_CATEGORIES, ...CIVIC_CATEGORIES] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SUGGESTED_AGENCIES = [
  'SEGURIDAD_MUNICIPAL',
  'CARABINEROS',
  'SAMU',
  'BOMBEROS',
  'OBRAS_ASEO',
  /** Migración 0005: investigación de delitos ya ocurridos, drogas, personas desaparecidas. */
  'PDI',
] as const;
export type SuggestedAgency = (typeof SUGGESTED_AGENCIES)[number];

export const ALERT_STATUSES = [
  'PENDING',
  'ACKNOWLEDGED',
  'DISPATCHED',
  'RESOLVED',
  'REJECTED',
  'CANCELLED',
  'UNROUTED',
] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const AI_STATUSES = ['QUEUED', 'PROCESSING', 'DONE', 'FAILED', 'SKIPPED'] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

export const DISPATCH_STATUSES = ['ASSIGNED', 'EN_ROUTE', 'ON_SITE', 'CLOSED', 'CANCELLED'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export const UNIT_STATUSES = ['AVAILABLE', 'BUSY', 'OFFLINE'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export const UNIT_KINDS = ['PATRULLA', 'MOTO', 'INSPECTOR'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/**
 * FIELD (migración 0012): funcionario de terreno. Entra con su propia cuenta a /terreno, elige su unidad al
 * iniciar turno y solo ve el caso al que despacharon su unidad (contexto RLS `field`).
 */
export const OPERATOR_ROLES = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'FIELD'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];
/** Quienes trabajan en la central (todo /ops salvo /ops/field). */
export const CENTRAL_ROLES: readonly OperatorRole[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];

export const ACTOR_TYPES = ['CITIZEN', 'OPERATOR', 'SYSTEM', 'AI'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const MEDIA_KINDS = ['AUDIO', 'PHOTO'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Motivo de rechazo (viaja en el evento REJECTED). Solo FALSE_ALARM (engaño intencional) cuenta como
 * falta del vecino; ACCIDENTAL y MISREPORTED (buena fe) se agregaron para no sancionar errores.
 */
export const REJECT_REASONS = ['FALSE_ALARM', 'DUPLICATE', 'OUT_OF_SCOPE', 'TEST', 'OTHER', 'ACCIDENTAL', 'MISREPORTED'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Faltas por aviso falso: vencen a los 90 días (docs/plan-plataforma.md §5b). */
export const STRIKE_WINDOW_DAYS = 90;

/**
 * Escalera de uso indebido (migración 0011; la base aplica los mismos umbrales en alert_account_check).
 * 2 faltas vigentes: cuenta restringida (SOS en prioridad media, sin reportes urbanos). 3: propuesta de
 * bloqueo para el supervisor. Bloqueo de 30 días; 6 meses si ya cumplió uno en el último año.
 */
export const RESTRICT_AT_STRIKES = 2;
export const BLOCK_PROPOSAL_AT_STRIKES = 3;
export const BLOCK_DAYS = 30;
export const BLOCK_REPEAT_DAYS = 180;
export const BLOCK_DURATIONS = [BLOCK_DAYS, BLOCK_REPEAT_DAYS] as const;

/** Estado de la cuenta del vecino, de menor a mayor. */
export const ACCOUNT_LEVELS = ['OK', 'WARNED', 'RESTRICTED', 'BLOCKED'] as const;
export type AccountLevel = (typeof ACCOUNT_LEVELS)[number];

/** Tipo citizen_block_status (0011). */
export const CITIZEN_BLOCK_STATUSES = ['PROPOSED', 'ACTIVE', 'DISMISSED', 'LIFTED', 'EXPIRED'] as const;
export type CitizenBlockStatus = (typeof CITIZEN_BLOCK_STATUSES)[number];

/** Tipo citizen_review_status (0011). */
export const CITIZEN_REVIEW_STATUSES = ['PENDING', 'GRANTED', 'DENIED'] as const;
export type CitizenReviewStatus = (typeof CITIZEN_REVIEW_STATUSES)[number];

/**
 * Lo que informa la unidad al llegar (migración 0008). Los terminales cierran el despacho y liberan la
 * unidad; "pide apoyo" y "era otra situación" lo dejan abierto.
 */
export const DISPATCH_OUTCOMES = [
  'RESOLVED_ON_SITE',
  'REFERRED',
  'NEEDS_SUPPORT',
  'NOT_FOUND',
  'DIFFERENT_SITUATION',
  'FALSE_ALARM_CONFIRMED',
] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];
export const TERMINAL_OUTCOMES: readonly DispatchOutcome[] = ['RESOLVED_ON_SITE', 'REFERRED', 'NOT_FOUND', 'FALSE_ALARM_CONFIRMED'];
/** Quién informó el resultado (0012): la central con lo que dijo la unidad por radio, o la unidad desde /terreno. */
export const OUTCOME_VIA = ['CENTRAL', 'FIELD'] as const;
export type OutcomeVia = (typeof OUTCOME_VIA)[number];

/**
 * Avisos de terreno a la central (0012, tipo field_alarm_kind): pánico del funcionario, pedido de apoyo y los
 * plazos vencidos (no marcó "en camino" a tiempo, o lleva demasiado sin dar noticias).
 */
export const FIELD_ALARM_KINDS = ['PANIC', 'SUPPORT', 'LATE', 'NO_NEWS'] as const;
export type FieldAlarmKind = (typeof FIELD_ALARM_KINDS)[number];

/**
 * Plazos de terreno (RT-7, docs/plan-plataforma.md §5c). Solo corren para unidades con un funcionario de terreno
 * en turno: una unidad que se maneja por radio la actualiza la central.
 */
export const FIELD_DEADLINES = {
  /** Despachada y sin "en camino". */
  assignedSeconds: 120,
  /** En camino y sin "llegué". */
  enRouteMinutes: 20,
  /** En el lugar y sin informar nada. */
  onSiteMinutes: 30,
} as const;

/** Fotos por informe de terreno y cada cuánto manda su posición el teléfono con un despacho abierto. */
export const FIELD_PHOTOS_MAX = 3;
export const FIELD_LOCATION_EVERY_MS = 15_000;

/** Bitácora del sistema (migración 0003, tipo audit_kind). */
export const AUDIT_KINDS = [
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_CHANGED',
  'OPERATOR_CREATED',
  'OPERATOR_UPDATED',
  'PASSWORD_RESET',
  'SHIFT_PLANNED',
  'SHIFT_REMOVED',
  'SHIFT_STARTED',
  'SHIFT_ENDED',
  'UNIT_CREATED',
  'UNIT_UPDATED',
  'CONTACT_CREATED',
  'CONTACT_UPDATED',
  'CONTACT_REMOVED',
  /** Migración 0006: una alerta pasó a otro municipio (automático por el agente o manual). */
  'ALERT_TRANSFERRED',
  /** Migración 0010: la plataforma activó, suspendió o dio de baja el municipio. */
  'TENANT_STATUS_CHANGED',
  /** Migración 0011: uso indebido (bloqueos, faltas anuladas, revisiones). */
  'CITIZEN_BLOCKED',
  'CITIZEN_BLOCK_DISMISSED',
  'CITIZEN_UNBLOCKED',
  'STRIKE_ANNULLED',
  'REVIEW_RESOLVED',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** Directorio de contactos del municipio (migración 0003, tipo contact_category). */
export const CONTACT_CATEGORIES = [
  'CARABINEROS',
  'PDI',
  'SAMU',
  'BOMBEROS',
  'SALUD',
  'MUNICIPAL',
  'SERVICIOS_BASICOS',
  'JUNTA_VECINOS',
  'EMERGENCIA_MUNICIPAL',
  'OTRO',
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

export const ALERT_EVENT_KINDS = [
  'CREATED',
  'AI_PROCESSED',
  'AI_FAILED',
  'ACKNOWLEDGED',
  'DISPATCHED',
  'DISPATCH_STATUS',
  'NOTE',
  'REJECTED',
  'RESOLVED',
  'CANCELLED',
  'PUSH_SENT',
  /** Migración 0005: el operador corrigió o confirmó la clasificación. */
  'RECLASSIFIED',
  /** Migración 0005: el operador registró a qué instituciones derivó el caso. */
  'REFERRED',
  /** Migración 0006: la alerta pasó a otro municipio. */
  'TRANSFERRED',
  /** Migración 0008: resultado informado desde terreno (por radio o, después, desde la unidad). */
  'FIELD_REPORT',
  /** Migración 0012: aviso de terreno ligado al caso (pánico, apoyo, plazo vencido). */
  'FIELD_ALARM',
] as const;
export type AlertEventKind = (typeof ALERT_EVENT_KINDS)[number];

/** Categoría permitida según tipo de alerta. */
export function categoriesFor(type: AlertType): readonly AlertCategory[] {
  return type === 'EMERGENCY_SOS' ? EMERGENCY_CATEGORIES : CIVIC_CATEGORIES;
}

/** Transiciones válidas de la alerta (sección 5 del documento de Fase 0). */
export const ALERT_TRANSITIONS: Record<AlertStatus, readonly AlertStatus[]> = {
  PENDING: ['ACKNOWLEDGED', 'DISPATCHED', 'REJECTED', 'CANCELLED', 'RESOLVED'],
  ACKNOWLEDGED: ['DISPATCHED', 'REJECTED', 'RESOLVED'],
  /** ACKNOWLEDGED solo cuando se cancela el último despacho abierto (lo hace el servidor). */
  /** REJECTED: la unidad confirmó en terreno que era una falsa alarma (migración 0008). */
  DISPATCHED: ['RESOLVED', 'ACKNOWLEDGED', 'REJECTED'],
  RESOLVED: [],
  REJECTED: [],
  CANCELLED: [],
  UNROUTED: [],
};

export const DISPATCH_TRANSITIONS: Record<DispatchStatus, readonly DispatchStatus[]> = {
  ASSIGNED: ['EN_ROUTE', 'ON_SITE', 'CLOSED', 'CANCELLED'],
  EN_ROUTE: ['ON_SITE', 'CLOSED', 'CANCELLED'],
  ON_SITE: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canTransitionAlert(from: AlertStatus, to: AlertStatus): boolean {
  return ALERT_TRANSITIONS[from].includes(to);
}

export function canTransitionDispatch(from: DispatchStatus, to: DispatchStatus): boolean {
  return DISPATCH_TRANSITIONS[from].includes(to);
}

// ------------------------------------------------------------------ plataforma (migración 0010)

/** Estado del municipio en Guard-IA (tipo tenant_status). */
export const TENANT_STATUSES = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** Espejo de set_tenant_status() en la base, que es quien decide. */
export const TENANT_TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  ONBOARDING: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: [],
};

/** Estado de una comuna en la consola: sin municipio en Guard-IA, o el estado de su municipio. */
export const COMUNA_SERVICE_STATUSES = ['AVAILABLE', ...TENANT_STATUSES] as const;
export type ComunaServiceStatus = (typeof COMUNA_SERVICE_STATUSES)[number];

/** Roles del equipo Guard-IA (tipo platform_role). */
export const PLATFORM_ROLES = ['SUPERADMIN', 'IMPLEMENTATION', 'FINANCE', 'SUPPORT'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Bitácora de plataforma (tipo platform_action). */
export const PLATFORM_ACTIONS = [
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'LOCKED',
  'TOTP_ENROLLED',
  'PASSWORD_CHANGED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_RESET',
  'TENANT_CREATED',
  'TENANT_UPDATED',
  'TENANT_STATUS_CHANGED',
  'TENANT_ADMIN_CREATED',
  'TENANT_ADMIN_RESET',
  'TEST_PHONE_ADDED',
  'TEST_PHONE_REMOVED',
] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

/** Lista de puesta en marcha (tenant_readiness() en la base fija los mínimos). */
export const READINESS_KEYS = [
  'ADMIN_READY',
  'OPERATORS',
  'CONTACT_CARABINEROS',
  'CONTACT_SAMU',
  'CONTACT_BOMBEROS',
  'CONTACT_MUNICIPAL',
  'UNITS',
  'SHIFTS_FIRST_WEEK',
  'CONTRACT_SIGNED',
  'DPA_SIGNED',
  'E2E_TEST',
] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];
