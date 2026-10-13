import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACTOR_TYPES,
  AI_STATUSES,
  ALERT_CATEGORIES,
  ALERT_EVENT_KINDS,
  ALERT_SOURCES,
  ALERT_STATUSES,
  ALERT_TYPES,
  AUDIT_KINDS,
  CONTACT_CATEGORIES,
  DISPATCH_OUTCOMES,
  DISPATCH_STATUSES,
  MEDIA_KINDS,
  OPERATOR_ROLES,
  PRIORITIES,
  SUGGESTED_AGENCIES,
  UNIT_KINDS,
  UNIT_STATUSES,
  type SuggestedAgency,
  type Triage,
} from '@guardia/shared';

/**
 * Espejo tipado de 0001_init.sql para consultas con Drizzle.
 * Las columnas geography generadas (alert.location, unit.last_location) y
 * tenant.boundary se consultan con SQL crudo donde hacen falta; no se declaran aquí.
 * La fuente de verdad del esquema es el SQL; este archivo no genera migraciones.
 */

export const alertTypeEnum = pgEnum('alert_type', ALERT_TYPES);
export const alertSourceEnum = pgEnum('alert_source', ALERT_SOURCES);
export const alertCategoryEnum = pgEnum('alert_category', ALERT_CATEGORIES);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const suggestedAgencyEnum = pgEnum('suggested_agency', SUGGESTED_AGENCIES);
export const alertStatusEnum = pgEnum('alert_status', ALERT_STATUSES);
export const aiStatusEnum = pgEnum('ai_status', AI_STATUSES);
export const dispatchStatusEnum = pgEnum('dispatch_status', DISPATCH_STATUSES);
export const dispatchOutcomeEnum = pgEnum('dispatch_outcome', DISPATCH_OUTCOMES);
export const unitStatusEnum = pgEnum('unit_status', UNIT_STATUSES);
export const unitKindEnum = pgEnum('unit_kind', UNIT_KINDS);
export const operatorRoleEnum = pgEnum('operator_role', OPERATOR_ROLES);
export const actorTypeEnum = pgEnum('actor_type', ACTOR_TYPES);
export const mediaKindEnum = pgEnum('media_kind', MEDIA_KINDS);
export const alertEventKindEnum = pgEnum('alert_event_kind', ALERT_EVENT_KINDS);
export const tokenKindEnum = pgEnum('token_kind', ['CITIZEN', 'OPERATOR']);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  cutCode: text('cut_code'),
  timezone: text('timezone').notNull().default('America/Santiago'),
  audioRetentionDays: integer('audio_retention_days').notNull().default(90),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  // 0006_geo_routing.sql
  comunaCut: integer('comuna_cut'),
});

export const citizen = pgTable('citizen', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  name: text('name'),
  trustScore: integer('trust_score').notNull().default(100),
  consentVersion: text('consent_version'),
  consentAt: ts('consent_at'),
  blockedAt: ts('blocked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const device = pgTable('device', {
  id: uuid('id').primaryKey().defaultRandom(),
  citizenId: uuid('citizen_id')
    .notNull()
    .references(() => citizen.id, { onDelete: 'cascade' }),
  expoPushToken: text('expo_push_token').notNull().unique(),
  platform: text('platform').$type<'ios' | 'android'>().notNull(),
  appVersion: text('app_version'),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
});

export const operator = pgTable('operator', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: operatorRoleEnum('role').notNull().default('OPERATOR'),
  active: boolean('active').notNull().default(true),
  lastLoginAt: ts('last_login_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  // 0003_admin.sql
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  passwordChangedAt: ts('password_changed_at'),
  createdBy: uuid('created_by'),
});

export const unit = pgTable('unit', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  code: text('code').notNull(),
  kind: unitKindEnum('kind').notNull().default('PATRULLA'),
  status: unitStatusEnum('status').notNull().default('AVAILABLE'),
  lastLat: doublePrecision('last_lat'),
  lastLng: doublePrecision('last_lng'),
  lastSeenAt: ts('last_seen_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const alert = pgTable('alert', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenant.id),
  citizenId: uuid('citizen_id')
    .notNull()
    .references(() => citizen.id),
  clientRef: uuid('client_ref'),
  type: alertTypeEnum('type').notNull(),
  source: alertSourceEnum('source').notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  accuracyM: real('accuracy_m'),
  addressHint: text('address_hint'),
  userText: text('user_text'),
  transcription: text('transcription'),
  category: alertCategoryEnum('category'),
  priority: priorityEnum('priority'),
  suggestedAgency: suggestedAgencyEnum('suggested_agency'),
  aiStatus: aiStatusEnum('ai_status').notNull().default('QUEUED'),
  aiConfidence: real('ai_confidence'),
  aiSummary: text('ai_summary'),
  aiFlags: jsonb('ai_flags').$type<Record<string, boolean>>(),
  aiError: text('ai_error'),
  status: alertStatusEnum('status').notNull().default('PENDING'),
  acknowledgedBy: uuid('acknowledged_by').references(() => operator.id),
  resolvedAt: ts('resolved_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  // 0004_incidents.sql
  incidentId: uuid('incident_id'),
  // 0005_triage.sql
  subcategory: text('subcategory'),
  aiTriage: jsonb('ai_triage').$type<Triage>(),
  // 0006_geo_routing.sql (la fija el trigger de ruteo; la app no la cambia)
  comunaCut: integer('comuna_cut'),
  // 0009_hardening.sql: orden de la cola (HIGH 0, MEDIUM 1, LOW 2, sin prioridad 1), con índice.
  priorityRank: smallint('priority_rank').generatedAlwaysAs(
    sql`CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 1 END`,
  ),
});

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertId: uuid('alert_id')
    .notNull()
    .references(() => alert.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references(() => tenant.id),
  kind: mediaKindEnum('kind').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  mime: text('mime').notNull(),
  bytes: integer('bytes').notNull(),
  durationS: real('duration_s'),
  retentionUntil: ts('retention_until').notNull(),
  deletedAt: ts('deleted_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const dispatch = pgTable('dispatch', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertId: uuid('alert_id')
    .notNull()
    .references(() => alert.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  unitId: uuid('unit_id')
    .notNull()
    .references(() => unit.id),
  operatorId: uuid('operator_id')
    .notNull()
    .references(() => operator.id),
  status: dispatchStatusEnum('status').notNull().default('ASSIGNED'),
  notes: text('notes'),
  // 0008_misuse_field.sql
  outcome: dispatchOutcomeEnum('outcome'),
  outcomeNote: text('outcome_note'),
  outcomeAt: ts('outcome_at'),
  outcomeBy: uuid('outcome_by').references(() => operator.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
});

export const alertEvent = pgTable('alert_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertId: uuid('alert_id')
    .notNull()
    .references(() => alert.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references(() => tenant.id),
  actorType: actorTypeEnum('actor_type').notNull(),
  actorId: uuid('actor_id'),
  kind: alertEventKindEnum('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const otpCode = pgTable('otp_code', {
  // 0009_hardening.sql: llave uuid; el teléfono queda único.
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  codeHash: text('code_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const refreshToken = pgTable('refresh_token', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: tokenKindEnum('kind').notNull(),
  // 0009_hardening.sql: dueño con FK real; subject_id es generado (COALESCE de los dos).
  citizenId: uuid('citizen_id').references(() => citizen.id, { onDelete: 'cascade' }),
  operatorId: uuid('operator_id').references(() => operator.id, { onDelete: 'cascade' }),
  subjectId: uuid('subject_id')
    .notNull()
    .generatedAlwaysAs(sql`COALESCE(citizen_id, operator_id)`),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  replacedBy: uuid('replaced_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------- 0003_admin.sql

export const auditKindEnum = pgEnum('audit_kind', AUDIT_KINDS);
export const contactCategoryEnum = pgEnum('contact_category', CONTACT_CATEGORIES);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  actorId: uuid('actor_id'),
  kind: auditKindEnum('kind').notNull(),
  targetId: uuid('target_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const shift = pgTable('shift', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  operatorId: uuid('operator_id')
    .notNull()
    .references(() => operator.id),
  plannedStart: ts('planned_start'),
  plannedEnd: ts('planned_end'),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
  handoverNote: text('handover_note'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const contact = pgTable('contact', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  category: contactCategoryEnum('category').notNull(),
  name: text('name').notNull(),
  organization: text('organization'),
  phone: text('phone').notNull(),
  phoneAlt: text('phone_alt'),
  email: text('email'),
  sector: text('sector'),
  notes: text('notes'),
  available24h: boolean('available_24h').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ------------------------------------------------------------- 0004_incidents.sql

/** Grupo de alertas sobre la misma situación. `location` (geography generada) se usa con SQL crudo. */
export const incident = pgTable('incident', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  type: alertTypeEnum('type').notNull(),
  category: alertCategoryEnum('category'),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  alertCount: integer('alert_count').notNull().default(1),
  citizenCount: integer('citizen_count').notNull().default(1),
  recurrenceCount: integer('recurrence_count').notNull().default(0),
  importance: integer('importance').notNull().default(0),
  importanceReasons: text('importance_reasons').array().notNull().default([]),
  firstAlertAt: ts('first_alert_at').notNull(),
  lastAlertAt: ts('last_alert_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ------------------------------------------------------------- 0005_triage.sql

/** Clasificación y derivación que registró la central (una fila por alerta), con lo que dijo la IA. */
export const triageLabel = pgTable('triage_label', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  alertId: uuid('alert_id')
    .notNull()
    .unique()
    .references(() => alert.id, { onDelete: 'cascade' }),
  category: alertCategoryEnum('category'),
  subcategory: text('subcategory'),
  agencies: suggestedAgencyEnum('agencies').array().$type<SuggestedAgency[]>().notNull().default([]),
  aiCategory: alertCategoryEnum('ai_category'),
  aiSubcategory: text('ai_subcategory'),
  aiAgencies: suggestedAgencyEnum('ai_agencies').array().$type<SuggestedAgency[]>().notNull().default([]),
  aiVersion: text('ai_version'),
  classifiedBy: uuid('classified_by').references(() => operator.id),
  classifiedAt: ts('classified_at'),
  referredBy: uuid('referred_by').references(() => operator.id),
  referredAt: ts('referred_at'),
  // 0008_misuse_field.sql
  fieldCategory: alertCategoryEnum('field_category'),
  fieldSubcategory: text('field_subcategory'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
export type TriageLabelRow = typeof triageLabel.$inferSelect;

// ------------------------------------------------------------- 0006_geo_routing.sql

/** Comunas de Chile (referencia nacional, solo lectura). `boundary` se consulta con SQL crudo. */
export const comuna = pgTable('comuna', {
  cut: integer('cut').primaryKey(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  regionCut: integer('region_cut').notNull(),
  regionName: text('region_name').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ------------------------------------------------------------- 0008_misuse_field.sql

/** Falta de un vecino por aviso falso intencional; vence a los 90 días, se anula (no se borra). */
export const citizenStrike = pgTable('citizen_strike', {
  id: uuid('id').primaryKey().defaultRandom(),
  citizenId: uuid('citizen_id')
    .notNull()
    .references(() => citizen.id),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  alertId: uuid('alert_id')
    .notNull()
    .unique()
    .references(() => alert.id, { onDelete: 'cascade' }),
  note: text('note').notNull(),
  decidedBy: uuid('decided_by')
    .notNull()
    .references(() => operator.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  annulledAt: ts('annulled_at'),
  annulledBy: uuid('annulled_by').references(() => operator.id),
  annulReason: text('annul_reason'),
});

export const schema = {
  tenant,
  citizenStrike,
  comuna,
  incident,
  triageLabel,
  auditLog,
  shift,
  contact,
  citizen,
  device,
  operator,
  unit,
  alert,
  media,
  dispatch,
  alertEvent,
  otpCode,
  refreshToken,
};
export type Schema = typeof schema;

export type AlertRow = typeof alert.$inferSelect;
export type DispatchRow = typeof dispatch.$inferSelect;
export type UnitRow = typeof unit.$inferSelect;
export type CitizenRow = typeof citizen.$inferSelect;
export type OperatorRow = typeof operator.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type AlertEventRow = typeof alertEvent.$inferSelect;
export type TenantRow = typeof tenant.$inferSelect;
