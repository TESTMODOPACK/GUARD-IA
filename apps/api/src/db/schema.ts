import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
  PLATFORM_ACTIONS,
  PLATFORM_ROLES,
  PRIORITIES,
  SUGGESTED_AGENCIES,
  TENANT_STATUSES,
  CITIZEN_BLOCK_STATUSES,
  CITIZEN_REVIEW_STATUSES,
  FIELD_ALARM_KINDS,
  AREA_SOURCES,
  OUTCOME_VIA,
  UNIT_KINDS,
  UNIT_STATUSES,
  CONSENT_ACTIONS,
  CONSENT_PURPOSES,
  INCIDENT_NATURES,
  SECURITY_INCIDENT_STATUSES,
  SUBPROCESSOR_SERVICES,
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
export const tenantStatusEnum = pgEnum('tenant_status', TENANT_STATUSES);
export const citizenBlockStatusEnum = pgEnum('citizen_block_status', CITIZEN_BLOCK_STATUSES);
export const citizenReviewStatusEnum = pgEnum('citizen_review_status', CITIZEN_REVIEW_STATUSES);
export const outcomeViaEnum = pgEnum('outcome_via', OUTCOME_VIA);
export const fieldAlarmKindEnum = pgEnum('field_alarm_kind', FIELD_ALARM_KINDS);
export const areaSourceEnum = pgEnum('area_source', AREA_SOURCES);
export const platformRoleEnum = pgEnum('platform_role', PLATFORM_ROLES);
export const platformActionEnum = pgEnum('platform_action', PLATFORM_ACTIONS);
export const consentPurposeEnum = pgEnum('consent_purpose', CONSENT_PURPOSES);
export const consentActionEnum = pgEnum('consent_action', CONSENT_ACTIONS);
export const subprocessorServiceEnum = pgEnum('subprocessor_service', SUBPROCESSOR_SERVICES);
export const incidentNatureEnum = pgEnum('incident_nature', INCIDENT_NATURES);
export const securityIncidentStatusEnum = pgEnum('security_incident_status', SECURITY_INCIDENT_STATUSES);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  cutCode: text('cut_code'),
  timezone: text('timezone').notNull().default('America/Santiago'),
  audioRetentionDays: integer('audio_retention_days').notNull().default(90),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  // 0006_geo_routing.sql
  comunaCut: integer('comuna_cut'),
  // 0010_platform.sql: el estado manda; `active` (ACTIVE o SUSPENDED) es generada.
  status: tenantStatusEnum('status').notNull().default('ACTIVE'),
  active: boolean('active').generatedAlwaysAs(sql`status IN ('ACTIVE', 'SUSPENDED')`),
  legalName: text('legal_name'),
  rut: text('rut'),
  address: text('address'),
  techContactName: text('tech_contact_name'),
  techContactEmail: text('tech_contact_email'),
  techContactPhone: text('tech_contact_phone'),
  billingContactName: text('billing_contact_name'),
  billingContactEmail: text('billing_contact_email'),
  contractSignedAt: date('contract_signed_at', { mode: 'string' }),
  dpaSignedAt: date('dpa_signed_at', { mode: 'string' }),
  // 0014_privacy_records.sql: referencia de cada documento y evaluación de impacto.
  contractRef: text('contract_ref'),
  dpaRef: text('dpa_ref'),
  dpiaApprovedAt: date('dpia_approved_at', { mode: 'string' }),
  dpiaRef: text('dpia_ref'),
  statusReason: text('status_reason'),
  statusChangedAt: ts('status_changed_at').notNull().defaultNow(),
  goLiveAt: ts('go_live_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
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
  // 0014: oposición al análisis con IA externa y edad declarada.
  externalAi: boolean('external_ai').notNull().default(true),
  ageDeclaredAt: ts('age_declared_at'),
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
  // 0011_misuse_blocks.sql: cuenta restringida al enviarla (la fija el trigger alert_account).
  citizenRestricted: boolean('citizen_restricted').notNull().default(false),
  // 0013_areas.sql: área del municipio (la pone la base al insertar; la corrigen el agente o una persona).
  areaId: uuid('area_id'),
  areaSource: areaSourceEnum('area_source'),
  securityRelevant: boolean('security_relevant').notNull().default(false),
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
  // 0012_field.sql
  outcomeVia: outcomeViaEnum('outcome_via'),
  proposedCategory: alertCategoryEnum('proposed_category'),
  proposedSubcategory: text('proposed_subcategory'),
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
  // 0010: acciones del equipo Guard-IA en el municipio (el municipio ve "Equipo Guard-IA").
  platformActorId: uuid('platform_actor_id'),
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
  // 0012_field.sql: unidad con la que sale el funcionario de terreno.
  unitId: uuid('unit_id').references(() => unit.id),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Áreas del municipio (0013): las define el administrador municipal. */
export const area = pgTable('area', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  name: text('name').notNull(),
  receivesSos: boolean('receives_sos').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Qué área atiende cada categoría urbana (o una subcategoría). */
export const areaRule = pgTable('area_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  category: alertCategoryEnum('category').notNull(),
  subcategory: text('subcategory'),
  areaId: uuid('area_id')
    .notNull()
    .references(() => area.id),
});

export const operatorArea = pgTable(
  'operator_area',
  {
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    areaId: uuid('area_id')
      .notNull()
      .references(() => area.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
  },
  (t) => [primaryKey({ columns: [t.operatorId, t.areaId] })],
);

/** Excepción: todas las áreas ven todo (una fila por municipio que lo configuró). */
export const tenantAreaMode = pgTable('tenant_area_mode', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenant.id),
  shared: boolean('shared').notNull().default(false),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Avisos de terreno (0012): pánico, apoyo y plazos vencidos. */
export const fieldAlarm = pgTable('field_alarm', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  kind: fieldAlarmKindEnum('kind').notNull(),
  unitId: uuid('unit_id').references(() => unit.id),
  operatorId: uuid('operator_id').references(() => operator.id),
  dispatchId: uuid('dispatch_id').references(() => dispatch.id),
  alertId: uuid('alert_id').references(() => alert.id),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  accuracyM: real('accuracy_m'),
  note: text('note'),
  createdAt: ts('created_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
  closedBy: uuid('closed_by').references(() => operator.id),
  closeNote: text('close_note'),
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
  // 0010: CUT de la provincia = CUT de la comuna / 100 (generada). boundary_simple se lee con SQL crudo.
  provinciaCut: smallint('provincia_cut').generatedAlwaysAs(sql`(cut / 100)::smallint`),
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

// ------------------------------------------------------------- 0011_misuse_blocks.sql

/** Bloqueo propuesto por la 3.ª falta y decidido por otra persona (supervisor o administrador). */
export const citizenBlock = pgTable('citizen_block', {
  id: uuid('id').primaryKey().defaultRandom(),
  citizenId: uuid('citizen_id')
    .notNull()
    .references(() => citizen.id),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  alertId: uuid('alert_id').references(() => alert.id),
  status: citizenBlockStatusEnum('status').notNull().default('PROPOSED'),
  strikes: smallint('strikes').notNull(),
  suggestedDays: smallint('suggested_days').notNull(),
  days: smallint('days'),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  proposedBy: uuid('proposed_by').notNull(),
  proposedAt: ts('proposed_at').notNull().defaultNow(),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  liftedBy: uuid('lifted_by'),
  liftedAt: ts('lifted_at'),
  liftReason: text('lift_reason'),
});

/** Revisión pedida por el vecino de una falta o un bloqueo; la resuelve el municipio que sancionó. */
export const citizenReview = pgTable('citizen_review', {
  id: uuid('id').primaryKey().defaultRandom(),
  citizenId: uuid('citizen_id')
    .notNull()
    .references(() => citizen.id),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  strikeId: uuid('strike_id').references(() => citizenStrike.id),
  blockId: uuid('block_id').references(() => citizenBlock.id),
  text: text('text').notNull(),
  status: citizenReviewStatusEnum('status').notNull().default('PENDING'),
  response: text('response'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: ts('resolved_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ------------------------------------------------------------- 0010_platform.sql

export const region = pgTable('region', {
  cut: smallint('cut').primaryKey(),
  name: text('name').notNull(),
  roman: text('roman').notNull(),
  sortOrder: smallint('sort_order').notNull(),
});

export const provincia = pgTable('provincia', {
  cut: smallint('cut').primaryKey(),
  regionCut: smallint('region_cut')
    .notNull()
    .references(() => region.cut),
  name: text('name').notNull(),
});

export const tenantTestPhone = pgTable('tenant_test_phone', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  phone: text('phone').notNull(),
  label: text('label').notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const platformUser = pgTable('platform_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: platformRoleEnum('role').notNull(),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  passwordChangedAt: ts('password_changed_at'),
  totpSecretEnc: text('totp_secret_enc'),
  totpPendingEnc: text('totp_pending_enc'),
  totpEnabledAt: ts('totp_enabled_at'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: ts('locked_until'),
  active: boolean('active').notNull().default(true),
  lastLoginAt: ts('last_login_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const platformSession = pgTable('platform_session', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => platformUser.id),
  tokenHash: text('token_hash').notNull().unique(),
  startedAt: ts('started_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  replacedBy: uuid('replaced_by'),
  ip: text('ip'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const platformAuditLog = pgTable('platform_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').references(() => platformUser.id),
  action: platformActionEnum('action').notNull(),
  tenantId: uuid('tenant_id').references(() => tenant.id),
  comunaCut: integer('comuna_cut'),
  targetId: uuid('target_id'),
  reason: text('reason'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  ip: text('ip'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------- 0014_privacy_records.sql (Ley 21.719)

export const consentNotice = pgTable('consent_notice', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: text('version').notNull(),
  textHash: text('text_hash').notNull().unique(),
  body: jsonb('body').$type<Record<string, unknown>>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const consentRecord = pgTable('consent_record', {
  id: uuid('id').primaryKey().defaultRandom(),
  citizenId: uuid('citizen_id')
    .notNull()
    .references(() => citizen.id),
  noticeId: uuid('notice_id')
    .notNull()
    .references(() => consentNotice.id),
  purpose: consentPurposeEnum('purpose').notNull(),
  action: consentActionEnum('action').notNull(),
  appVersion: text('app_version'),
  platform: text('platform'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const tenantPrivacy = pgTable('tenant_privacy', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenant.id),
  contactEmail: text('contact_email').notNull(),
  contactAddress: text('contact_address'),
  dpoName: text('dpo_name'),
  dpoEmail: text('dpo_email'),
  policyUrl: text('policy_url'),
  policyVersion: text('policy_version'),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const subprocessor = pgTable('subprocessor', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  service: subprocessorServiceEnum('service').notNull(),
  country: text('country').notNull(),
  dataCategories: text('data_categories').notNull(),
  guarantee: text('guarantee'),
  inUse: boolean('in_use').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const tenantSubprocessor = pgTable('tenant_subprocessor', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  subprocessorId: uuid('subprocessor_id')
    .notNull()
    .references(() => subprocessor.id),
  authorizedAt: date('authorized_at', { mode: 'string' }).notNull(),
  authorizedBy: text('authorized_by').notNull(),
  documentRef: text('document_ref').notNull(),
  revokedAt: ts('revoked_at'),
  createdBy: uuid('created_by').references(() => platformUser.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const securityIncident = pgTable('security_incident', {
  id: uuid('id').primaryKey().defaultRandom(),
  // La pone la secuencia de la base (se muestra como INC-0001).
  number: integer('number')
    .notNull()
    .default(sql`nextval('security_incident_number_seq')`),
  detectedAt: ts('detected_at').notNull(),
  startedAt: ts('started_at'),
  detectedBy: text('detected_by').notNull(),
  nature: incidentNatureEnum('nature').notNull(),
  summary: text('summary').notNull(),
  dataCategories: text('data_categories').notNull(),
  affectedEstimate: integer('affected_estimate'),
  sensitiveData: boolean('sensitive_data').notNull().default(false),
  measures: text('measures'),
  status: securityIncidentStatusEnum('status').notNull().default('OPEN'),
  closedAt: ts('closed_at'),
  createdBy: uuid('created_by').references(() => platformUser.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const securityIncidentTenant = pgTable(
  'security_incident_tenant',
  {
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => securityIncident.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    notifiedAt: ts('notified_at').notNull().defaultNow(),
    agencyReportedAt: ts('agency_reported_at'),
    agencyRef: text('agency_ref'),
    subjectsNotifiedAt: ts('subjects_notified_at'),
    subjectsNote: text('subjects_note'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.incidentId, t.tenantId] })],
);

export const schema = {
  consentNotice,
  consentRecord,
  tenantPrivacy,
  subprocessor,
  tenantSubprocessor,
  securityIncident,
  securityIncidentTenant,
  area,
  areaRule,
  operatorArea,
  tenantAreaMode,
  fieldAlarm,
  citizenBlock,
  citizenReview,
  region,
  provincia,
  tenantTestPhone,
  platformUser,
  platformSession,
  platformAuditLog,
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
export type FieldAlarmRow = typeof fieldAlarm.$inferSelect;
export type AreaRow = typeof area.$inferSelect;
export type ShiftRow = typeof shift.$inferSelect;
export type UnitRow = typeof unit.$inferSelect;
export type CitizenRow = typeof citizen.$inferSelect;
export type OperatorRow = typeof operator.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type AlertEventRow = typeof alertEvent.$inferSelect;
export type TenantRow = typeof tenant.$inferSelect;
export type PlatformUserRow = typeof platformUser.$inferSelect;
