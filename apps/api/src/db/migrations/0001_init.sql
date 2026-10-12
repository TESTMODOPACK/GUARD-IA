-- Guard-IA · migración inicial
-- Se ejecuta con el rol dueño (DATABASE_ADMIN_URL). La API conecta como guardia_app,
-- que NO es dueño de las tablas y por lo tanto queda sujeto a RLS.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums (espejo de packages/shared/src/enums.ts)
-- ---------------------------------------------------------------------------
CREATE TYPE alert_type AS ENUM ('EMERGENCY_SOS', 'CIVIC_REPORT');
CREATE TYPE alert_source AS ENUM ('BUTTON', 'VOICE', 'DISCREET', 'FORM');
CREATE TYPE alert_category AS ENUM (
  'ROBO_ASALTO', 'VIOLENCIA_AGRESION', 'INCENDIO', 'SALUD', 'ACCIDENTE_TRANSITO', 'SOSPECHOSO', 'OTRO_EMERGENCIA',
  'BACHE', 'LUMINARIA', 'BASURA_MICROBASURAL', 'SEMAFORO', 'AREA_VERDE', 'ANIMAL', 'OTRO_URBANO'
);
CREATE TYPE priority AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE suggested_agency AS ENUM ('SEGURIDAD_MUNICIPAL', 'CARABINEROS', 'SAMU', 'BOMBEROS', 'OBRAS_ASEO');
CREATE TYPE alert_status AS ENUM ('PENDING', 'ACKNOWLEDGED', 'DISPATCHED', 'RESOLVED', 'REJECTED', 'CANCELLED', 'UNROUTED');
CREATE TYPE ai_status AS ENUM ('QUEUED', 'PROCESSING', 'DONE', 'FAILED', 'SKIPPED');
CREATE TYPE dispatch_status AS ENUM ('ASSIGNED', 'EN_ROUTE', 'ON_SITE', 'CLOSED', 'CANCELLED');
CREATE TYPE unit_status AS ENUM ('AVAILABLE', 'BUSY', 'OFFLINE');
CREATE TYPE unit_kind AS ENUM ('PATRULLA', 'MOTO', 'INSPECTOR');
CREATE TYPE operator_role AS ENUM ('ADMIN', 'SUPERVISOR', 'OPERATOR');
CREATE TYPE actor_type AS ENUM ('CITIZEN', 'OPERATOR', 'SYSTEM', 'AI');
CREATE TYPE media_kind AS ENUM ('AUDIO', 'PHOTO');
CREATE TYPE alert_event_kind AS ENUM (
  'CREATED', 'AI_PROCESSED', 'AI_FAILED', 'ACKNOWLEDGED', 'DISPATCHED', 'DISPATCH_STATUS',
  'NOTE', 'REJECTED', 'RESOLVED', 'CANCELLED', 'PUSH_SENT'
);
CREATE TYPE token_kind AS ENUM ('CITIZEN', 'OPERATOR');

-- ---------------------------------------------------------------------------
-- Contexto de sesión para RLS. La API hace SET LOCAL por transacción.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_role() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.role', true), '') $$;

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_citizen_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.citizen_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
CREATE TABLE tenant (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  slug                 text NOT NULL UNIQUE,
  cut_code             text,                                  -- código único territorial (INE)
  boundary             geography(MultiPolygon, 4326) NOT NULL,
  timezone             text NOT NULL DEFAULT 'America/Santiago',
  audio_retention_days integer NOT NULL DEFAULT 90 CHECK (audio_retention_days BETWEEN 1 AND 3650),
  settings             jsonb NOT NULL DEFAULT '{}'::jsonb,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_boundary_gix ON tenant USING GIST (boundary);

CREATE TABLE citizen (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  name            text,
  trust_score     integer NOT NULL DEFAULT 100 CHECK (trust_score BETWEEN 0 AND 100),
  consent_version text,
  consent_at      timestamptz,
  blocked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id      uuid NOT NULL REFERENCES citizen(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL UNIQUE,
  platform        text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version     text,
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_citizen_idx ON device (citizen_id);

CREATE TABLE operator (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          operator_role NOT NULL DEFAULT 'OPERATOR',
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)   -- el login es por email sin tenant; un operador pertenece a un solo municipio
);

CREATE TABLE unit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  kind          unit_kind NOT NULL DEFAULT 'PATRULLA',
  status        unit_status NOT NULL DEFAULT 'AVAILABLE',
  last_lat      double precision,
  last_lng      double precision,
  last_location geography(Point, 4326)
                GENERATED ALWAYS AS (
                  CASE WHEN last_lat IS NULL OR last_lng IS NULL THEN NULL
                       ELSE ST_SetSRID(ST_MakePoint(last_lng, last_lat), 4326)::geography END
                ) STORED,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE alert (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenant(id),                 -- NULL => UNROUTED
  citizen_id       uuid NOT NULL REFERENCES citizen(id),
  client_ref       uuid,                                       -- idempotencia por intento de la app
  type             alert_type NOT NULL,
  source           alert_source NOT NULL,
  lat              double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng              double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  location         geography(Point, 4326)
                   GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
  accuracy_m       real,
  address_hint     text,
  user_text        text,
  transcription    text,
  category         alert_category,
  priority         priority,
  suggested_agency suggested_agency,
  ai_status        ai_status NOT NULL DEFAULT 'QUEUED',
  ai_confidence    real CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1),
  ai_summary       text,
  ai_flags         jsonb,
  ai_error         text,
  status           alert_status NOT NULL DEFAULT 'PENDING',
  acknowledged_by  uuid REFERENCES operator(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (citizen_id, client_ref)
);
CREATE INDEX alert_location_gix ON alert USING GIST (location);
CREATE INDEX alert_tenant_status_created_idx ON alert (tenant_id, status, created_at DESC);
CREATE INDEX alert_citizen_created_idx ON alert (citizen_id, created_at DESC);
CREATE INDEX alert_tenant_updated_idx ON alert (tenant_id, updated_at DESC);
CREATE TRIGGER alert_updated_at BEFORE UPDATE ON alert FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id        uuid NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
  tenant_id       uuid REFERENCES tenant(id),
  kind            media_kind NOT NULL,
  storage_key     text NOT NULL UNIQUE,
  mime            text NOT NULL,
  bytes           integer NOT NULL CHECK (bytes >= 0),
  duration_s      real,
  retention_until timestamptz NOT NULL,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_alert_idx ON media (alert_id);
CREATE INDEX media_retention_idx ON media (retention_until) WHERE deleted_at IS NULL;

CREATE TABLE dispatch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id    uuid NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  unit_id     uuid NOT NULL REFERENCES unit(id),
  operator_id uuid NOT NULL REFERENCES operator(id),
  status      dispatch_status NOT NULL DEFAULT 'ASSIGNED',
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX dispatch_tenant_status_idx ON dispatch (tenant_id, status);
CREATE INDEX dispatch_alert_idx ON dispatch (alert_id);
-- Invariante en la base: una unidad tiene a lo más un despacho abierto.
CREATE UNIQUE INDEX dispatch_unit_open_uidx ON dispatch (unit_id)
  WHERE status IN ('ASSIGNED', 'EN_ROUTE', 'ON_SITE');
CREATE TRIGGER dispatch_updated_at BEFORE UPDATE ON dispatch FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alert_event (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id   uuid NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
  tenant_id  uuid REFERENCES tenant(id),
  actor_type actor_type NOT NULL,
  actor_id   uuid,
  kind       alert_event_kind NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_event_alert_idx ON alert_event (alert_id, created_at);

-- Auditoría: guardia_app no puede actualizar ni borrar eventos (REVOKE más abajo).
-- Se evita un trigger de inmutabilidad para no bloquear el ON DELETE CASCADE del dueño.

CREATE TABLE otp_code (
  phone      text PRIMARY KEY,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens rotativos (sección 11). Se guarda solo el hash.
CREATE TABLE refresh_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        token_kind NOT NULL,
  subject_id  uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_token_subject_idx ON refresh_token (subject_id, kind);

-- ---------------------------------------------------------------------------
-- Ruteo por geocerca (ADR 003). BEFORE INSERT: el ciudadano nunca elige tenant.
-- Las columnas generadas no están disponibles en BEFORE, se usa lat/lng.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION alert_route_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_point geometry := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
BEGIN
  SELECT t.id INTO NEW.tenant_id
  FROM tenant t
  WHERE t.active AND ST_Contains(t.boundary::geometry, v_point)
  ORDER BY ST_Area(t.boundary) ASC   -- si dos polígonos se solapan gana el más chico
  LIMIT 1;

  IF NEW.tenant_id IS NULL THEN
    NEW.status := 'UNROUTED';
    NEW.ai_status := 'SKIPPED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_route BEFORE INSERT ON alert FOR EACH ROW EXECUTE FUNCTION alert_route_tenant();

-- ---------------------------------------------------------------------------
-- Rol de la aplicación y permisos
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardia_app') THEN
    -- La contraseña real la fija scripts/migrate.ts con ALTER ROLE desde el entorno.
    CREATE ROLE guardia_app LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
-- Una transacción que se queda esperando (bug o cliente caído) suelta su conexión sola.
ALTER ROLE guardia_app SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE guardia_app SET statement_timeout = '10s';
ALTER ROLE guardia_app SET lock_timeout = '5s';

GRANT USAGE ON SCHEMA public TO guardia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guardia_app;
REVOKE UPDATE, DELETE ON alert_event FROM guardia_app;
REVOKE INSERT, UPDATE, DELETE ON tenant FROM guardia_app;
REVOKE DELETE ON alert FROM guardia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO guardia_app;

-- Privilegios por columna (defensa en profundidad, independiente de RLS):
-- la identidad de una alerta (quién, dónde, qué tipo, qué municipio) es inmutable para la app.
REVOKE UPDATE ON alert FROM guardia_app;
GRANT UPDATE (status, acknowledged_by, resolved_at, address_hint,
              transcription, category, priority, suggested_agency,
              ai_status, ai_confidence, ai_summary, ai_flags, ai_error)
  ON alert TO guardia_app;
-- El teléfono de un vecino no se edita por la API; sí su consentimiento, nombre, confianza y bloqueo.
REVOKE UPDATE ON citizen FROM guardia_app;
GRANT UPDATE (name, consent_version, consent_at, trust_score, blocked_at) ON citizen TO guardia_app;
-- Un despacho no cambia de alerta, tenant ni unidad.
REVOKE UPDATE ON dispatch FROM guardia_app;
GRANT UPDATE (status, notes, closed_at, operator_id) ON dispatch TO guardia_app;
-- Media: solo duración y purga.
REVOKE UPDATE ON media FROM guardia_app;
GRANT UPDATE (duration_s, deleted_at) ON media TO guardia_app;

-- ---------------------------------------------------------------------------
-- RLS. Cada tabla de operación tiene tres políticas: operator, citizen, system.
-- ---------------------------------------------------------------------------
ALTER TABLE citizen       ENABLE ROW LEVEL SECURITY;
ALTER TABLE device        ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator      ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit          ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert         ENABLE ROW LEVEL SECURITY;
ALTER TABLE media         ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch      ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_event   ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_code      ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token ENABLE ROW LEVEL SECURITY;

-- system: workers, cron y flujos de auth que ocurren antes de tener identidad.
CREATE POLICY citizen_system       ON citizen       FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY device_system        ON device        FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY operator_system      ON operator      FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY unit_system          ON unit          FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY alert_system         ON alert         FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY media_system         ON media         FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY dispatch_system      ON dispatch      FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY alert_event_system   ON alert_event   FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY otp_code_system      ON otp_code      FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY refresh_token_system ON refresh_token FOR ALL TO guardia_app USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- operator: todo lo de su tenant.
CREATE POLICY operator_operator ON operator FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY unit_operator ON unit FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY alert_operator ON alert FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY media_operator ON media FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY dispatch_operator ON dispatch FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY alert_event_operator ON alert_event FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
-- El operador ve al vecino solo si ese vecino tiene una alerta en su tenant.
CREATE POLICY citizen_operator ON citizen FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.citizen_id = citizen.id AND a.tenant_id = app_tenant_id()));
-- Y puede ajustar su trust_score (rechazo por falsa alarma). Las columnas las limita el GRANT de arriba.
CREATE POLICY citizen_operator_update ON citizen FOR UPDATE TO guardia_app
  USING (app_role() = 'operator' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.citizen_id = citizen.id AND a.tenant_id = app_tenant_id()))
  WITH CHECK (app_role() = 'operator');

-- citizen: solo lo propio. Nunca ve ni toca tenant, operadores ni unidades.
CREATE POLICY citizen_self ON citizen FOR ALL TO guardia_app
  USING (app_role() = 'citizen' AND id = app_citizen_id())
  WITH CHECK (app_role() = 'citizen' AND id = app_citizen_id());
CREATE POLICY device_citizen ON device FOR ALL TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id())
  WITH CHECK (app_role() = 'citizen' AND citizen_id = app_citizen_id());
CREATE POLICY alert_citizen ON alert FOR ALL TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id())
  WITH CHECK (app_role() = 'citizen' AND citizen_id = app_citizen_id());
CREATE POLICY media_citizen ON media FOR ALL TO guardia_app
  USING (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.id = media.alert_id AND a.citizen_id = app_citizen_id()))
  WITH CHECK (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.id = media.alert_id AND a.citizen_id = app_citizen_id()));
CREATE POLICY alert_event_citizen ON alert_event FOR ALL TO guardia_app
  USING (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.id = alert_event.alert_id AND a.citizen_id = app_citizen_id()))
  WITH CHECK (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.id = alert_event.alert_id AND a.citizen_id = app_citizen_id()));
-- El vecino necesita leer el despacho activo de su alerta (código de unidad y estado).
CREATE POLICY dispatch_citizen ON dispatch FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.id = dispatch.alert_id AND a.citizen_id = app_citizen_id()));
-- Y el nombre del municipio que atiende: tenant es de solo lectura para todos.
-- (tenant no tiene RLS; guardia_app solo tiene SELECT sobre ella.)

-- unit visible para el vecino solo a través del join de dispatch (código). Se expone por la API, no por RLS.
CREATE POLICY unit_citizen ON unit FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM dispatch d JOIN alert a ON a.id = d.alert_id
    WHERE d.unit_id = unit.id AND a.citizen_id = app_citizen_id()));
