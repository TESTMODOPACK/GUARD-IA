-- Consola de plataforma (13-10-2026), fase P1 de docs/plan-plataforma.md.
--
-- 1. Regiones y provincias de Chile (DPA 2023 de SUBDERE) como referencia nacional; la comuna gana su
--    provincia (el CUT de la provincia es el de la comuna dividido por 100) y un límite simplificado para
--    los mapas de la consola.
-- 2. Estado del municipio (`tenant.status`) en vez de `active`, que queda como columna generada para que
--    el ruteo, el traspaso y el directorio sigan leyendo lo mismo:
--      ONBOARDING  en implementación: solo los teléfonos de prueba llegan a la central;
--      ACTIVE      recibe todo;
--      SUSPENDED   recibe todo (el SOS nunca se corta); la API limita lo no crítico;
--      TERMINATED  de baja: las alertas nuevas quedan fuera de cobertura.
--    Las transiciones y la lista de puesta en marcha se validan en la base (set_tenant_status).
-- 3. Usuarios de plataforma (equipo Guard-IA) con segundo factor TOTP, sesiones propias y bitácora de
--    plataforma de solo inserción.
-- 4. Contexto RLS nuevo `platform`: ve municipios, comunas y sus propias tablas; de las cuentas del
--    municipio solo ve las de administrador (las crea y restablece); no ve alertas, vecinos ni casos. Las
--    cifras (alertas por municipio, demanda no atendida, puesta en marcha) salen de funciones SECURITY
--    DEFINER que devuelven solo conteos.
--
-- Desde 0009 los privilegios por defecto no otorgan nada: cada tabla nueva declara sus GRANT.

-- ---------------------------------------------------------------------------------------- 1
CREATE TABLE region (
  cut        smallint PRIMARY KEY CHECK (cut BETWEEN 1 AND 16),
  name       text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 80),
  roman      text NOT NULL UNIQUE CHECK (roman ~ '^[IVX]{1,5}$'),
  -- De norte a sur, como se recorre el país.
  sort_order smallint NOT NULL UNIQUE CHECK (sort_order BETWEEN 1 AND 16)
);
INSERT INTO region (cut, name, roman, sort_order) VALUES
  (15, 'Arica y Parinacota', 'XV', 1),
  (1, 'Tarapacá', 'I', 2),
  (2, 'Antofagasta', 'II', 3),
  (3, 'Atacama', 'III', 4),
  (4, 'Coquimbo', 'IV', 5),
  (5, 'Valparaíso', 'V', 6),
  (13, 'Metropolitana de Santiago', 'XIII', 7),
  (6, 'Libertador General Bernardo O''Higgins', 'VI', 8),
  (7, 'Maule', 'VII', 9),
  (16, 'Ñuble', 'XVI', 10),
  (8, 'Biobío', 'VIII', 11),
  (9, 'La Araucanía', 'IX', 12),
  (14, 'Los Ríos', 'XIV', 13),
  (10, 'Los Lagos', 'X', 14),
  (11, 'Aysén del General Carlos Ibáñez del Campo', 'XI', 15),
  (12, 'Magallanes y de la Antártica Chilena', 'XII', 16);

CREATE TABLE provincia (
  cut        smallint PRIMARY KEY CHECK (cut BETWEEN 11 AND 169),
  region_cut smallint NOT NULL REFERENCES region(cut),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  CHECK (cut / 10 = region_cut)
);
CREATE INDEX provincia_region_idx ON provincia (region_cut);
INSERT INTO provincia (cut, region_cut, name) VALUES
  (11, 1, 'Iquique'), (14, 1, 'Tamarugal'),
  (21, 2, 'Antofagasta'), (22, 2, 'El Loa'), (23, 2, 'Tocopilla'),
  (31, 3, 'Copiapó'), (32, 3, 'Chañaral'), (33, 3, 'Huasco'),
  (41, 4, 'Elqui'), (42, 4, 'Choapa'), (43, 4, 'Limarí'),
  (51, 5, 'Valparaíso'), (52, 5, 'Isla de Pascua'), (53, 5, 'Los Andes'), (54, 5, 'Petorca'),
  (55, 5, 'Quillota'), (56, 5, 'San Antonio'), (57, 5, 'San Felipe de Aconcagua'), (58, 5, 'Marga Marga'),
  (61, 6, 'Cachapoal'), (62, 6, 'Cardenal Caro'), (63, 6, 'Colchagua'),
  (71, 7, 'Talca'), (72, 7, 'Cauquenes'), (73, 7, 'Curicó'), (74, 7, 'Linares'),
  (81, 8, 'Concepción'), (82, 8, 'Arauco'), (83, 8, 'Biobío'),
  (91, 9, 'Cautín'), (92, 9, 'Malleco'),
  (101, 10, 'Llanquihue'), (102, 10, 'Chiloé'), (103, 10, 'Osorno'), (104, 10, 'Palena'),
  (111, 11, 'Coihaique'), (112, 11, 'Aisén'), (113, 11, 'Capitán Prat'), (114, 11, 'General Carrera'),
  (121, 12, 'Magallanes'), (122, 12, 'Antártica Chilena'), (123, 12, 'Tierra del Fuego'), (124, 12, 'Última Esperanza'),
  (131, 13, 'Santiago'), (132, 13, 'Cordillera'), (133, 13, 'Chacabuco'), (134, 13, 'Maipo'), (135, 13, 'Melipilla'),
  (136, 13, 'Talagante'),
  (141, 14, 'Valdivia'), (142, 14, 'Ranco'),
  (151, 15, 'Arica'), (152, 15, 'Parinacota'),
  (161, 16, 'Diguillín'), (162, 16, 'Itata'), (163, 16, 'Punilla');

-- Límite para mapas: sin las islas de menos de 2 km² (Magallanes y Aysén tienen miles) y simplificado a
-- ~300 m. El polígono completo sigue en `boundary` y el ruteo usa `comuna_part`.
CREATE FUNCTION comuna_simplify(g geography) RETURNS geometry
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    (SELECT ST_Multi(ST_SimplifyPreserveTopology(ST_Collect(d.geom), 0.003))
       FROM ST_Dump(g::geometry) d
      WHERE ST_Area(d.geom::geography) > 2e6),
    ST_Multi(ST_SimplifyPreserveTopology(g::geometry, 0.003)))
$$;

ALTER TABLE comuna ADD CONSTRAINT comuna_region_fk FOREIGN KEY (region_cut) REFERENCES region(cut);
ALTER TABLE comuna ADD COLUMN provincia_cut smallint GENERATED ALWAYS AS ((cut / 100)::smallint) STORED
  REFERENCES provincia(cut);
ALTER TABLE comuna ADD COLUMN boundary_simple geometry(MultiPolygon, 4326)
  GENERATED ALWAYS AS (comuna_simplify(boundary)) STORED;
CREATE INDEX comuna_region_idx ON comuna (region_cut);
CREATE INDEX comuna_provincia_idx ON comuna (provincia_cut);

REVOKE ALL ON region, provincia FROM guardia_app;
GRANT SELECT ON region, provincia TO guardia_app;

-- ---------------------------------------------------------------------------------------- 2
CREATE TYPE tenant_status AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

DROP VIEW tenant_directory;
DROP INDEX tenant_comuna_uidx;
DROP INDEX tenant_cut_code_uidx;

-- Los municipios existentes conservan lo que tenían: activos → ACTIVE, inactivos → TERMINATED (no rutean).
-- El valor por defecto es ACTIVE para los que se crean por línea de comandos (seed, tests); la consola
-- crea siempre en ONBOARDING (create_tenant).
ALTER TABLE tenant ADD COLUMN status tenant_status NOT NULL DEFAULT 'ACTIVE';
UPDATE tenant SET status = CASE WHEN active THEN 'ACTIVE'::tenant_status ELSE 'TERMINATED'::tenant_status END;
ALTER TABLE tenant DROP COLUMN active;
ALTER TABLE tenant ADD COLUMN active boolean GENERATED ALWAYS AS (status IN ('ACTIVE', 'SUSPENDED')) STORED;

ALTER TABLE tenant
  ADD COLUMN legal_name            text CHECK (char_length(legal_name) BETWEEN 2 AND 160),
  ADD COLUMN rut                   text CHECK (rut ~ '^[0-9]{7,8}-[0-9K]$'),
  ADD COLUMN address               text CHECK (char_length(address) <= 200),
  ADD COLUMN tech_contact_name     text CHECK (char_length(tech_contact_name) <= 120),
  ADD COLUMN tech_contact_email    text CHECK (char_length(tech_contact_email) <= 160),
  ADD COLUMN tech_contact_phone    text CHECK (char_length(tech_contact_phone) <= 30),
  ADD COLUMN billing_contact_name  text CHECK (char_length(billing_contact_name) <= 120),
  ADD COLUMN billing_contact_email text CHECK (char_length(billing_contact_email) <= 160),
  -- Hasta que existan los contratos (P4), la consola marca la fecha de firma del contrato y del anexo de
  -- tratamiento de datos (Ley 21.719): son requisito para activar.
  ADD COLUMN contract_signed_at    date,
  ADD COLUMN dpa_signed_at         date,
  ADD COLUMN status_reason         text CHECK (char_length(status_reason) <= 500),
  ADD COLUMN status_changed_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN go_live_at            timestamptz,
  ADD COLUMN updated_at            timestamptz NOT NULL DEFAULT now();

-- Un municipio vigente por comuna; uno de baja no impide volver a contratar.
CREATE UNIQUE INDEX tenant_comuna_uidx ON tenant (comuna_cut) WHERE comuna_cut IS NOT NULL AND status <> 'TERMINATED';
CREATE UNIQUE INDEX tenant_cut_code_uidx ON tenant (cut_code) WHERE cut_code IS NOT NULL AND status <> 'TERMINATED';
CREATE INDEX tenant_status_idx ON tenant (status);
CREATE TRIGGER tenant_updated_at BEFORE UPDATE ON tenant FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE VIEW tenant_directory WITH (security_barrier) AS
  SELECT id, name, comuna_cut, active, boundary FROM tenant;
REVOKE ALL ON tenant_directory FROM PUBLIC;
GRANT SELECT ON tenant_directory TO guardia_app;

GRANT SELECT (status, active, legal_name, rut, address, tech_contact_name, tech_contact_email, tech_contact_phone,
  billing_contact_name, billing_contact_email, contract_signed_at, dpa_signed_at, status_reason, status_changed_at,
  go_live_at, updated_at) ON tenant TO guardia_app;
-- Ficha del municipio: la edita la plataforma (RLS). El estado solo cambia con set_tenant_status y el alta
-- solo con create_tenant: ni status ni boundary tienen privilegio de escritura.
GRANT UPDATE (name, audio_retention_days, legal_name, rut, address, tech_contact_name, tech_contact_email,
  tech_contact_phone, billing_contact_name, billing_contact_email, contract_signed_at, dpa_signed_at, updated_at)
  ON tenant TO guardia_app;

-- Teléfonos de prueba del modo implementación (RF-3.4). Son de funcionarios, no de vecinos.
CREATE TABLE tenant_test_phone (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  phone      text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  label      text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);

-- ---------------------------------------------------------------------------------------- 3
CREATE TYPE platform_role AS ENUM ('SUPERADMIN', 'IMPLEMENTATION', 'FINANCE', 'SUPPORT');

CREATE TABLE platform_user (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL UNIQUE
                       CHECK (email = lower(email) AND char_length(email) BETWEEN 5 AND 160 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  role                 platform_role NOT NULL,
  password_hash        text NOT NULL CHECK (char_length(password_hash) BETWEEN 20 AND 200),
  must_change_password boolean NOT NULL DEFAULT true,
  password_changed_at  timestamptz,
  -- Secreto TOTP cifrado por la API (AES-256-GCM con PLATFORM_ENCRYPTION_KEY); la base nunca lo ve en claro.
  totp_secret_enc      text CHECK (char_length(totp_secret_enc) <= 200),
  -- Secreto propuesto durante el enrolamiento, antes de confirmar el primer código.
  totp_pending_enc     text CHECK (char_length(totp_pending_enc) <= 200),
  totp_enabled_at      timestamptz,
  -- Último paso de 30 s aceptado: un código no sirve dos veces.
  totp_last_step       bigint,
  failed_attempts      integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 1000),
  locked_until         timestamptz,
  active               boolean NOT NULL DEFAULT true,
  last_login_at        timestamptz,
  created_by           uuid REFERENCES platform_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((totp_enabled_at IS NULL) = (totp_secret_enc IS NULL))
);
CREATE TRIGGER platform_user_updated_at BEFORE UPDATE ON platform_user FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenant_test_phone ADD CONSTRAINT tenant_test_phone_created_by_fk
  FOREIGN KEY (created_by) REFERENCES platform_user(id);

-- Refresh de la consola: rota en cada uso; `started_at` se hereda para el límite absoluto de la sesión.
CREATE TABLE platform_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES platform_user(id),
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  started_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES platform_session(id),
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > started_at)
);
CREATE INDEX platform_session_user_idx ON platform_session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX platform_session_expires_idx ON platform_session (expires_at);

CREATE TYPE platform_action AS ENUM (
  'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'LOCKED', 'TOTP_ENROLLED', 'PASSWORD_CHANGED',
  'USER_CREATED', 'USER_UPDATED', 'USER_RESET',
  'TENANT_CREATED', 'TENANT_UPDATED', 'TENANT_STATUS_CHANGED',
  'TENANT_ADMIN_CREATED', 'TENANT_ADMIN_RESET',
  'TEST_PHONE_ADDED', 'TEST_PHONE_REMOVED'
);

CREATE TABLE platform_audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid REFERENCES platform_user(id),
  action     platform_action NOT NULL,
  tenant_id  uuid REFERENCES tenant(id),
  comuna_cut integer REFERENCES comuna(cut),
  target_id  uuid,
  reason     text CHECK (char_length(reason) <= 500),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_created_idx ON platform_audit_log (created_at DESC, id DESC);
CREATE INDEX platform_audit_tenant_idx ON platform_audit_log (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX platform_audit_actor_idx ON platform_audit_log (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

-- La bitácora del municipio registra lo que la plataforma hace en él (RF-4.3): actor de plataforma, que el
-- municipio ve como "Equipo Guard-IA" (no lee platform_user).
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'TENANT_STATUS_CHANGED';
ALTER TABLE audit_log ADD COLUMN platform_actor_id uuid REFERENCES platform_user(id);
ALTER TABLE audit_log ADD CONSTRAINT audit_log_one_actor_chk CHECK (actor_id IS NULL OR platform_actor_id IS NULL);

REVOKE ALL ON tenant_test_phone, platform_user, platform_session, platform_audit_log FROM guardia_app;
GRANT SELECT, INSERT, DELETE ON tenant_test_phone TO guardia_app;
GRANT SELECT ON platform_user TO guardia_app;
-- INSERT por tabla y no por columna: Drizzle nombra todas las columnas (con DEFAULT) y Postgres exige el
-- privilegio de cada columna nombrada. Quién inserta lo limita la RLS (system y platform).
GRANT INSERT ON platform_user TO guardia_app;
GRANT UPDATE (name, role, active, password_hash, must_change_password, password_changed_at, totp_secret_enc,
  totp_pending_enc, totp_enabled_at, totp_last_step, failed_attempts, locked_until, last_login_at, updated_at)
  ON platform_user TO guardia_app;
GRANT SELECT, INSERT, DELETE ON platform_session TO guardia_app;
GRANT UPDATE (revoked_at, replaced_by) ON platform_session TO guardia_app;
GRANT SELECT, INSERT ON platform_audit_log TO guardia_app;

-- ---------------------------------------------------------------------------------------- 4
ALTER TABLE tenant_test_phone ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_platform ON tenant FOR SELECT TO guardia_app USING (app_role() = 'platform');
CREATE POLICY tenant_platform_update ON tenant FOR UPDATE TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');

CREATE POLICY tenant_test_phone_system ON tenant_test_phone FOR SELECT TO guardia_app USING (app_role() = 'system');
CREATE POLICY tenant_test_phone_platform ON tenant_test_phone FOR ALL TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');

-- El ingreso (antes de tener identidad) corre en contexto system, como el del operador.
CREATE POLICY platform_user_system ON platform_user FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY platform_user_platform ON platform_user FOR ALL TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');

CREATE POLICY platform_session_system ON platform_session FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY platform_audit_system ON platform_audit_log FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY platform_audit_platform ON platform_audit_log FOR ALL TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');

-- Cuentas del municipio: la plataforma solo ve, crea y restablece administradores.
CREATE POLICY operator_platform_select ON operator FOR SELECT TO guardia_app
  USING (app_role() = 'platform' AND role = 'ADMIN');
CREATE POLICY operator_platform_insert ON operator FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'platform' AND role = 'ADMIN' AND created_by IS NULL);
CREATE POLICY operator_platform_update ON operator FOR UPDATE TO guardia_app
  USING (app_role() = 'platform' AND role = 'ADMIN') WITH CHECK (app_role() = 'platform' AND role = 'ADMIN');

CREATE POLICY audit_log_platform ON audit_log FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'platform' AND actor_id IS NULL AND platform_actor_id IS NOT NULL);

-- Demanda no atendida: alertas sin municipio por fecha.
CREATE INDEX alert_unrouted_idx ON alert (created_at) WHERE tenant_id IS NULL;

-- ---------------------------------------------------------------------------------------- funciones
-- Ruteo (0007) más el estado: ONBOARDING solo recibe a sus teléfonos de prueba.
CREATE OR REPLACE FUNCTION alert_route_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
  v_phone text;
BEGIN
  -- Regla 3: el vecino nunca elige municipio ni comuna; lo que venga en el INSERT se descarta.
  NEW.tenant_id := NULL;
  NEW.comuna_cut := NULL;
  SELECT c.phone INTO v_phone FROM citizen c WHERE c.id = NEW.citizen_id;

  SELECT p.cut INTO NEW.comuna_cut FROM comuna_part p WHERE ST_Covers(p.part, v_point) LIMIT 1;
  IF NEW.comuna_cut IS NULL THEN
    SELECT p.cut INTO NEW.comuna_cut
      FROM comuna_part p
     WHERE ST_DWithin(p.part, v_point, 50)
     ORDER BY ST_Distance(p.part, v_point)
     LIMIT 1;
  END IF;

  IF NEW.comuna_cut IS NOT NULL THEN
    SELECT t.id INTO NEW.tenant_id
      FROM tenant t
     WHERE t.comuna_cut = NEW.comuna_cut
       AND (t.active OR (t.status = 'ONBOARDING' AND EXISTS (
             SELECT 1 FROM tenant_test_phone tp WHERE tp.tenant_id = t.id AND tp.phone = v_phone)))
     LIMIT 1;
  END IF;
  IF NEW.tenant_id IS NULL THEN
    SELECT t.id INTO NEW.tenant_id
      FROM tenant t
     WHERE t.comuna_cut IS NULL AND ST_Covers(t.boundary, v_point)
       AND (t.active OR (t.status = 'ONBOARDING' AND EXISTS (
             SELECT 1 FROM tenant_test_phone tp WHERE tp.tenant_id = t.id AND tp.phone = v_phone)))
     ORDER BY ST_Area(t.boundary) ASC   -- si dos polígonos se solapan gana el más chico
     LIMIT 1;
  END IF;

  IF NEW.tenant_id IS NULL THEN
    NEW.status := 'UNROUTED';
    NEW.ai_status := 'SKIPPED';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION require_platform() RETURNS void
  LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF app_role() IS DISTINCT FROM 'platform' AND app_role() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'solo la plataforma' USING ERRCODE = '42501';
  END IF;
END $$;

-- Alta desde una comuna (RF-3.1): toma el límite oficial; siempre en implementación.
CREATE FUNCTION create_tenant(p_comuna integer, p_name text, p_slug text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM require_platform();
  INSERT INTO tenant (name, slug, cut_code, comuna_cut, boundary, status)
  SELECT p_name, p_slug, lpad(c.cut::text, 5, '0'), c.cut, c.boundary, 'ONBOARDING'
    FROM comuna c WHERE c.cut = p_comuna
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'comuna % no existe', p_comuna USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END $$;

-- Lista de puesta en marcha (RF-3.2). Los mínimos viven aquí y la API los muestra tal cual.
CREATE FUNCTION tenant_readiness(p_tenant uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_items jsonb;
BEGIN
  PERFORM require_platform();
  WITH counts(key, n, required) AS (
    VALUES
      ('ADMIN_READY', (SELECT count(*) FROM operator o WHERE o.tenant_id = p_tenant AND o.role = 'ADMIN'
                         AND o.active AND NOT o.must_change_password), 1),
      ('OPERATORS', (SELECT count(*) FROM operator o WHERE o.tenant_id = p_tenant AND o.role <> 'ADMIN'
                       AND o.active), 2),
      ('CONTACT_CARABINEROS', (SELECT count(*) FROM contact c WHERE c.tenant_id = p_tenant AND c.active
                                 AND c.category = 'CARABINEROS'), 1),
      ('CONTACT_SAMU', (SELECT count(*) FROM contact c WHERE c.tenant_id = p_tenant AND c.active
                          AND c.category = 'SAMU'), 1),
      ('CONTACT_BOMBEROS', (SELECT count(*) FROM contact c WHERE c.tenant_id = p_tenant AND c.active
                              AND c.category = 'BOMBEROS'), 1),
      ('CONTACT_MUNICIPAL', (SELECT count(*) FROM contact c WHERE c.tenant_id = p_tenant AND c.active
                               AND c.category IN ('EMERGENCIA_MUNICIPAL', 'MUNICIPAL')), 1),
      ('UNITS', (SELECT count(*) FROM unit u WHERE u.tenant_id = p_tenant), 1),
      ('SHIFTS_FIRST_WEEK', (SELECT count(*) FROM shift s WHERE s.tenant_id = p_tenant
                               AND s.planned_start >= date_trunc('day', now())
                               AND s.planned_start < date_trunc('day', now()) + interval '8 days'), 1),
      ('CONTRACT_SIGNED', (SELECT count(*) FROM tenant t WHERE t.id = p_tenant AND t.contract_signed_at IS NOT NULL), 1),
      ('DPA_SIGNED', (SELECT count(*) FROM tenant t WHERE t.id = p_tenant AND t.dpa_signed_at IS NOT NULL), 1),
      -- Prueba de extremo a extremo: un SOS desde un teléfono de prueba, despachado y resuelto.
      ('E2E_TEST', (SELECT count(*) FROM alert a
                      JOIN citizen ci ON ci.id = a.citizen_id
                      JOIN tenant_test_phone tp ON tp.tenant_id = a.tenant_id AND tp.phone = ci.phone
                     WHERE a.tenant_id = p_tenant AND a.type = 'EMERGENCY_SOS' AND a.status = 'RESOLVED'
                       AND EXISTS (SELECT 1 FROM dispatch d WHERE d.alert_id = a.id)), 1)
  )
  SELECT jsonb_agg(jsonb_build_object('key', key, 'count', n, 'required', required, 'ok', n >= required))
    INTO v_items FROM counts;
  RETURN jsonb_build_object(
    'items', v_items,
    'ready', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) AS e(item) WHERE NOT (e.item->>'ok')::boolean));
END $$;

-- Cambio de estado (RF-3.3, 3.5, 3.6). Devuelve el estado anterior. Errores:
--   P0002 no existe · 55000 transición no permitida · GIA01 puesta en marcha incompleta ·
--   GIA02 baja con alertas abiertas.
CREATE FUNCTION set_tenant_status(p_tenant uuid, p_status tenant_status, p_reason text) RETURNS tenant_status
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from tenant_status;
  v_open integer;
BEGIN
  PERFORM require_platform();
  SELECT status INTO v_from FROM tenant WHERE id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'municipio % no existe', p_tenant USING ERRCODE = 'P0002';
  END IF;
  IF NOT ((v_from = 'ONBOARDING' AND p_status IN ('ACTIVE', 'TERMINATED'))
       OR (v_from = 'ACTIVE' AND p_status IN ('SUSPENDED', 'TERMINATED'))
       OR (v_from = 'SUSPENDED' AND p_status IN ('ACTIVE', 'TERMINATED'))) THEN
    RAISE EXCEPTION 'no se puede pasar de % a %', v_from, p_status USING ERRCODE = '55000';
  END IF;
  IF v_from = 'ONBOARDING' AND p_status = 'ACTIVE' AND NOT (tenant_readiness(p_tenant)->>'ready')::boolean THEN
    RAISE EXCEPTION 'la lista de puesta en marcha está incompleta' USING ERRCODE = 'GIA01';
  END IF;
  IF p_status = 'TERMINATED' THEN
    SELECT count(*) INTO v_open FROM alert
     WHERE tenant_id = p_tenant AND status IN ('PENDING', 'ACKNOWLEDGED', 'DISPATCHED');
    IF v_open > 0 THEN
      RAISE EXCEPTION '% alertas abiertas', v_open USING ERRCODE = 'GIA02', DETAIL = v_open::text;
    END IF;
  END IF;
  UPDATE tenant
     SET status = p_status,
         status_reason = p_reason,
         status_changed_at = now(),
         go_live_at = CASE WHEN p_status = 'ACTIVE' THEN COALESCE(go_live_at, now()) ELSE go_live_at END
   WHERE id = p_tenant;
  RETURN v_from;
END $$;

-- Cifras para la consola: solo conteos, nunca filas de alertas.
CREATE FUNCTION platform_tenant_activity(p_since timestamptz)
  RETURNS TABLE (tenant_id uuid, alerts bigint, sos bigint, open_alerts bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_platform();
  RETURN QUERY
    SELECT a.tenant_id,
           count(*) FILTER (WHERE a.created_at >= p_since),
           count(*) FILTER (WHERE a.created_at >= p_since AND a.type = 'EMERGENCY_SOS'),
           count(*) FILTER (WHERE a.status IN ('PENDING', 'ACKNOWLEDGED', 'DISPATCHED'))
      FROM alert a
     WHERE a.tenant_id IS NOT NULL
       AND (a.created_at >= p_since OR a.status IN ('PENDING', 'ACKNOWLEDGED', 'DISPATCHED'))
     GROUP BY a.tenant_id;
END $$;

-- Demanda no atendida (RF-1.4): SOS y reportes desde comunas sin servicio.
CREATE FUNCTION platform_unserved(p_since timestamptz)
  RETURNS TABLE (comuna_cut integer, sos bigint, reports bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_platform();
  RETURN QUERY
    SELECT a.comuna_cut,
           count(*) FILTER (WHERE a.type = 'EMERGENCY_SOS'),
           count(*) FILTER (WHERE a.type = 'CIVIC_REPORT')
      FROM alert a
     WHERE a.tenant_id IS NULL AND a.created_at >= p_since AND a.comuna_cut IS NOT NULL
     GROUP BY a.comuna_cut;
END $$;

REVOKE ALL ON FUNCTION create_tenant(integer, text, text), tenant_readiness(uuid),
  set_tenant_status(uuid, tenant_status, text), platform_tenant_activity(timestamptz),
  platform_unserved(timestamptz), require_platform() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_tenant(integer, text, text), tenant_readiness(uuid),
  set_tenant_status(uuid, tenant_status, text), platform_tenant_activity(timestamptz),
  platform_unserved(timestamptz), require_platform() TO guardia_app;
