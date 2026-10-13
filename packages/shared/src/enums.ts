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

export const OPERATOR_ROLES = ['ADMIN', 'SUPERVISOR', 'OPERATOR'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

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
