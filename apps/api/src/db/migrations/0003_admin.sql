-- Administración de la central (12-10-2026): usuarios, turnos, bitácora del sistema y directorio de
-- contactos por municipio. Todo queda dentro del tenant por RLS, igual que el resto de la operación.
-- Los roles (ADMIN / SUPERVISOR / OPERATOR) los exige la API; la base garantiza el aislamiento.

-- ---------------------------------------------------------------------------
-- Usuarios: contraseña temporal obligatoria de cambiar y quién creó la cuenta.
-- ---------------------------------------------------------------------------
ALTER TABLE operator ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE operator ADD COLUMN password_changed_at timestamptz;
ALTER TABLE operator ADD COLUMN created_by uuid REFERENCES operator(id);

-- El email (identidad de login) y el tenant no se cambian desde la app.
REVOKE UPDATE ON operator FROM guardia_app;
GRANT UPDATE (name, role, active, last_login_at, password_hash, must_change_password, password_changed_at)
  ON operator TO guardia_app;

CREATE POLICY operator_operator_insert ON operator FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY operator_operator_update ON operator FOR UPDATE TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------
-- Bitácora del sistema (lo que no es un caso: accesos, usuarios, turnos, unidades, contactos).
-- Solo inserción para la app, como alert_event.
-- ---------------------------------------------------------------------------
CREATE TYPE audit_kind AS ENUM (
  'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGED',
  'OPERATOR_CREATED', 'OPERATOR_UPDATED', 'PASSWORD_RESET',
  'SHIFT_PLANNED', 'SHIFT_REMOVED', 'SHIFT_STARTED', 'SHIFT_ENDED',
  'UNIT_CREATED', 'UNIT_UPDATED',
  'CONTACT_CREATED', 'CONTACT_UPDATED', 'CONTACT_REMOVED'
);

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  actor_id   uuid REFERENCES operator(id),
  kind       audit_kind NOT NULL,
  target_id  uuid,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC, id DESC);
-- La bitácora de casos se lee por tenant y fecha (panel del administrador).
CREATE INDEX alert_event_tenant_created_idx ON alert_event (tenant_id, created_at DESC, id DESC);

REVOKE UPDATE, DELETE ON audit_log FROM guardia_app;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_system ON audit_log FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY audit_log_operator ON audit_log FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------
-- Turnos: programados (planned_*) por un supervisor y/o reales (started/ended) que marca el
-- operador. Un turno sin programar es uno que el operador inició por su cuenta.
-- ---------------------------------------------------------------------------
CREATE TABLE shift (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  operator_id   uuid NOT NULL REFERENCES operator(id),
  planned_start timestamptz,
  planned_end   timestamptz,
  started_at    timestamptz,
  ended_at      timestamptz,
  handover_note text CHECK (char_length(handover_note) <= 2000),
  created_by    uuid REFERENCES operator(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((planned_start IS NULL) = (planned_end IS NULL)),
  CHECK (planned_end > planned_start),
  CHECK (planned_start IS NOT NULL OR started_at IS NOT NULL),
  CHECK (ended_at IS NULL OR (started_at IS NOT NULL AND ended_at >= started_at))
);
-- Un operador tiene a lo más un turno abierto.
CREATE UNIQUE INDEX shift_open_uidx ON shift (operator_id) WHERE started_at IS NOT NULL AND ended_at IS NULL;
CREATE INDEX shift_tenant_planned_idx ON shift (tenant_id, planned_start);
CREATE INDEX shift_tenant_started_idx ON shift (tenant_id, started_at DESC);

REVOKE UPDATE ON shift FROM guardia_app;
GRANT UPDATE (planned_start, planned_end, started_at, ended_at, handover_note) ON shift TO guardia_app;
ALTER TABLE shift ENABLE ROW LEVEL SECURITY;
CREATE POLICY shift_system ON shift FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY shift_operator ON shift FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------
-- Directorio de contactos del municipio (comisarías, SAMU, bomberos, servicios, juntas de vecinos).
-- Exclusivo de cada tenant. Se desactiva en vez de borrar, para que la bitácora siga legible.
-- ---------------------------------------------------------------------------
CREATE TYPE contact_category AS ENUM (
  'CARABINEROS', 'PDI', 'SAMU', 'BOMBEROS', 'SALUD', 'MUNICIPAL', 'SERVICIOS_BASICOS',
  'JUNTA_VECINOS', 'EMERGENCIA_MUNICIPAL', 'OTRO'
);

CREATE TABLE contact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  category      contact_category NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  organization  text CHECK (char_length(organization) <= 120),
  phone         text NOT NULL CHECK (char_length(phone) BETWEEN 3 AND 30),
  phone_alt     text CHECK (char_length(phone_alt) <= 30),
  email         text CHECK (char_length(email) <= 160),
  sector        text CHECK (char_length(sector) <= 120),
  notes         text CHECK (char_length(notes) <= 1000),
  available_24h boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES operator(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_tenant_idx ON contact (tenant_id, active, category, sort_order);

REVOKE DELETE ON contact FROM guardia_app;
REVOKE UPDATE ON contact FROM guardia_app;
GRANT UPDATE (category, name, organization, phone, phone_alt, email, sector, notes, available_24h,
  sort_order, active, updated_at) ON contact TO guardia_app;
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_system ON contact FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY contact_operator ON contact FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
