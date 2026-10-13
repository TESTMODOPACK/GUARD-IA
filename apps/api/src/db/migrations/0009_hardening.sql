-- Endurecimiento de la base (13-10-2026). Aplica los hallazgos de docs/revision-base-de-datos.md:
-- C1, C2 (llaves primarias de texto), C3 nivel 1 (índices por municipio; las consultas ya pasan tenant_id
-- explícito), A1 (privilegios), A2 (RLS en tenant), A4 (supresión), A5 (índices de purga), M1 (FK del
-- refresh token), M2 (FK sin índice), M3 (invariantes entre municipios), M4, M5 (políticas del vecino),
-- M6 (integridad), M8 (autovacuum). A3 quedó resuelto en 0006/0007; A6, M7 y la purga son de código.
--
-- Regla desde aquí: ALTER DEFAULT PRIVILEGES ya no da permisos a guardia_app; cada migración declara
-- sus GRANT explícitos.

-- ---------------------------------------------------------------------------------------- C1, C2
ALTER TABLE otp_code ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE otp_code DROP CONSTRAINT otp_code_pkey;
ALTER TABLE otp_code ADD CONSTRAINT otp_code_pkey PRIMARY KEY (id);
ALTER TABLE otp_code ADD CONSTRAINT otp_code_phone_key UNIQUE (phone);
ALTER TABLE otp_code ADD CONSTRAINT otp_code_phone_fmt CHECK (phone ~ '^\+[1-9][0-9]{6,14}$') NOT VALID;
ALTER TABLE otp_code VALIDATE CONSTRAINT otp_code_phone_fmt;
CREATE INDEX otp_code_expires_idx ON otp_code (expires_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'id') THEN
    ALTER TABLE schema_migrations ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE schema_migrations DROP CONSTRAINT schema_migrations_pkey;
    ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);
    ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_name_key UNIQUE (name);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------- C3 nivel 1
-- Orden de la cola como columna (enum_eq es IMMUTABLE). Reescribe la tabla: hacerlo mientras es chica.
ALTER TABLE alert ADD COLUMN priority_rank smallint GENERATED ALWAYS AS (
  CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 1 END) STORED;
CREATE INDEX alert_open_queue_idx ON alert (tenant_id, priority_rank, created_at, id)
  WHERE status IN ('PENDING', 'ACKNOWLEDGED', 'DISPATCHED');
CREATE INDEX alert_tenant_created_idx ON alert (tenant_id, created_at DESC);
CREATE INDEX alert_ai_queued_idx ON alert (created_at) WHERE ai_status = 'QUEUED' AND tenant_id IS NOT NULL;
DROP INDEX alert_tenant_status_created_idx;
CREATE INDEX incident_tenant_last_idx ON incident (tenant_id, last_alert_at DESC);
DROP INDEX incident_tenant_type_last_idx;

-- ---------------------------------------------------------------------------------------- A1
REVOKE ALL ON schema_migrations FROM guardia_app;
REVOKE INSERT, UPDATE, DELETE ON spatial_ref_sys, geometry_columns, geography_columns FROM guardia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM guardia_app;

REVOKE UPDATE ON refresh_token FROM guardia_app;
GRANT UPDATE (revoked_at, replaced_by) ON refresh_token TO guardia_app;
REVOKE UPDATE ON otp_code FROM guardia_app;
GRANT UPDATE (code_hash, expires_at, attempts, created_at) ON otp_code TO guardia_app;
REVOKE UPDATE ON unit FROM guardia_app;
GRANT UPDATE (kind, status, last_lat, last_lng, last_seen_at) ON unit TO guardia_app;
REVOKE UPDATE ON device FROM guardia_app;
GRANT UPDATE (citizen_id, platform, app_version, last_seen_at) ON device TO guardia_app;
REVOKE DELETE ON citizen, operator, dispatch, media, unit FROM guardia_app;

-- ---------------------------------------------------------------------------------------- A2
-- Cada contexto ve solo su municipio. El polígono no lo lee la app (el ruteo y el traspaso son
-- SECURITY DEFINER); los nombres y límites de los demás municipios (datos públicos) se leen por el
-- directorio, sin ajustes ni configuración.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_system ON tenant FOR SELECT TO guardia_app USING (app_role() = 'system');
CREATE POLICY tenant_operator ON tenant FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND id = app_tenant_id());
CREATE POLICY tenant_citizen ON tenant FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.tenant_id = tenant.id AND a.citizen_id = app_citizen_id()));
REVOKE SELECT ON tenant FROM guardia_app;
GRANT SELECT (id, name, slug, cut_code, timezone, audio_retention_days, settings, active, created_at, comuna_cut)
  ON tenant TO guardia_app;

CREATE VIEW tenant_directory WITH (security_barrier) AS
  SELECT id, name, comuna_cut, active, boundary FROM tenant;
REVOKE ALL ON tenant_directory FROM PUBLIC;
GRANT SELECT ON tenant_directory TO guardia_app;

-- ---------------------------------------------------------------------------------------- A4
-- Supresión: el cuerpo vigente (0005, que ya borra ai_triage) más el redondeo de los incidentes, que
-- copiaban la ubicación exacta de la alerta cuando eran de una sola.
CREATE OR REPLACE FUNCTION erase_citizen(p_citizen uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone text;
  v_tomb  text;
  v_media integer;
BEGIN
  IF current_setting('app.role', true) IS DISTINCT FROM 'citizen'
     OR current_setting('app.citizen_id', true) IS DISTINCT FROM p_citizen::text THEN
    RAISE EXCEPTION 'erase_citizen: solo el propio vecino puede suprimir su cuenta' USING ERRCODE = '42501';
  END IF;

  SELECT phone INTO v_phone FROM citizen WHERE id = p_citizen FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  UPDATE media m
     SET retention_until = now() - interval '1 second'
    FROM alert a
   WHERE m.alert_id = a.id AND a.citizen_id = p_citizen AND m.deleted_at IS NULL;
  GET DIAGNOSTICS v_media = ROW_COUNT;

  UPDATE alert
     SET user_text = NULL,
         transcription = NULL,
         ai_summary = NULL,
         ai_triage = NULL,
         address_hint = NULL,
         accuracy_m = NULL,
         lat = round(lat::numeric, 3)::double precision,
         lng = round(lng::numeric, 3)::double precision
   WHERE citizen_id = p_citizen;

  UPDATE incident i
     SET lat = round(i.lat::numeric, 3)::double precision,
         lng = round(i.lng::numeric, 3)::double precision
   WHERE i.id IN (SELECT incident_id FROM alert WHERE citizen_id = p_citizen AND incident_id IS NOT NULL);

  DELETE FROM device WHERE citizen_id = p_citizen;
  DELETE FROM refresh_token WHERE citizen_id = p_citizen;
  DELETE FROM otp_code WHERE phone = v_phone;

  LOOP
    v_tomb := '+999' || lpad((floor(random() * 1e11))::bigint::text, 11, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM citizen WHERE phone = v_tomb);
  END LOOP;

  UPDATE citizen
     SET phone = v_tomb,
         name = NULL,
         consent_version = NULL,
         consent_at = NULL,
         blocked_at = now()
   WHERE id = p_citizen;

  RETURN v_media;
END
$$;
REVOKE ALL ON FUNCTION erase_citizen(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_citizen(uuid) TO guardia_app;

-- ---------------------------------------------------------------------------------------- A5
CREATE INDEX refresh_token_expires_idx ON refresh_token (expires_at);

-- ---------------------------------------------------------------------------------------- M1
-- El dueño del refresh token con FK real (antes subject_id polimórfico, sin FK).
ALTER TABLE refresh_token
  ADD COLUMN citizen_id  uuid REFERENCES citizen(id)  ON DELETE CASCADE,
  ADD COLUMN operator_id uuid REFERENCES operator(id) ON DELETE CASCADE;
UPDATE refresh_token r SET citizen_id = r.subject_id
 WHERE r.kind = 'CITIZEN' AND EXISTS (SELECT 1 FROM citizen c WHERE c.id = r.subject_id);
UPDATE refresh_token r SET operator_id = r.subject_id
 WHERE r.kind = 'OPERATOR' AND EXISTS (SELECT 1 FROM operator o WHERE o.id = r.subject_id);
-- Huérfanos (un dueño que ya no existe): no sirven para nada y no cumplirían el CHECK.
DELETE FROM refresh_token WHERE citizen_id IS NULL AND operator_id IS NULL;
ALTER TABLE refresh_token ADD CONSTRAINT refresh_token_subject_chk CHECK (
  (kind = 'CITIZEN'  AND citizen_id  IS NOT NULL AND operator_id IS NULL) OR
  (kind = 'OPERATOR' AND operator_id IS NOT NULL AND citizen_id  IS NULL));
DROP INDEX refresh_token_subject_idx;
ALTER TABLE refresh_token DROP COLUMN subject_id;
ALTER TABLE refresh_token ADD COLUMN subject_id uuid GENERATED ALWAYS AS (COALESCE(citizen_id, operator_id)) STORED;
CREATE INDEX refresh_token_subject_idx ON refresh_token (subject_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------- M2
CREATE INDEX dispatch_unit_idx     ON dispatch (unit_id, created_at DESC);
CREATE INDEX shift_operator_idx    ON shift (operator_id, planned_start) WHERE planned_start IS NOT NULL;
CREATE INDEX operator_tenant_idx   ON operator (tenant_id, active, name);
CREATE INDEX shift_tenant_open_idx ON shift (tenant_id) WHERE started_at IS NOT NULL AND ended_at IS NULL;

-- ---------------------------------------------------------------------------------------- M3
-- Un despacho, un turno o un incidente nunca mezclan municipios. Los FK compuestos usan MATCH SIMPLE: con
-- tenant_id NULL (alertas sin cobertura) no se aplican y los FK simples existentes cubren la existencia.
ALTER TABLE operator ADD CONSTRAINT operator_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE unit     ADD CONSTRAINT unit_id_tenant_key     UNIQUE (id, tenant_id);
ALTER TABLE incident ADD CONSTRAINT incident_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE alert    ADD CONSTRAINT alert_id_tenant_key    UNIQUE (id, tenant_id);
ALTER TABLE dispatch
  ADD CONSTRAINT dispatch_alert_tenant_fk    FOREIGN KEY (alert_id, tenant_id)    REFERENCES alert (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT dispatch_unit_tenant_fk     FOREIGN KEY (unit_id, tenant_id)     REFERENCES unit (id, tenant_id),
  ADD CONSTRAINT dispatch_operator_tenant_fk FOREIGN KEY (operator_id, tenant_id) REFERENCES operator (id, tenant_id);
ALTER TABLE shift ADD CONSTRAINT shift_operator_tenant_fk FOREIGN KEY (operator_id, tenant_id) REFERENCES operator (id, tenant_id);
ALTER TABLE alert ADD CONSTRAINT alert_incident_tenant_fk FOREIGN KEY (incident_id, tenant_id) REFERENCES incident (id, tenant_id);

-- El municipio de un evento o un archivo lo decide la alerta, no el código (mismo patrón que el ruteo).
CREATE OR REPLACE FUNCTION tenant_from_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  SELECT a.tenant_id INTO NEW.tenant_id FROM alert a WHERE a.id = NEW.alert_id;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_event_tenant BEFORE INSERT ON alert_event FOR EACH ROW EXECUTE FUNCTION tenant_from_alert();
CREATE TRIGGER media_tenant       BEFORE INSERT ON media       FOR EACH ROW EXECUTE FUNCTION tenant_from_alert();

-- ---------------------------------------------------------------------------------------- M4
-- Ninguna consulta usa alert.location y encarece cada inserción del SOS.
DROP INDEX alert_location_gix;

-- ---------------------------------------------------------------------------------------- M5
-- El vecino solo lee lo suyo, inserta su SOS tal como lo deja el ruteo y cancela una alerta pendiente.
DROP POLICY alert_citizen ON alert;
CREATE POLICY alert_citizen_select ON alert FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id());
CREATE POLICY alert_citizen_insert ON alert FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'citizen' AND citizen_id = app_citizen_id()
              AND status IN ('PENDING', 'UNROUTED') AND acknowledged_by IS NULL
              AND resolved_at IS NULL AND incident_id IS NULL AND priority IS NULL);
CREATE POLICY alert_citizen_cancel ON alert FOR UPDATE TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id() AND status = 'PENDING')
  WITH CHECK (app_role() = 'citizen' AND citizen_id = app_citizen_id() AND status = 'CANCELLED');
DROP POLICY media_citizen ON media;
CREATE POLICY media_citizen_select ON media FOR SELECT TO guardia_app USING (app_role() = 'citizen' AND EXISTS (
  SELECT 1 FROM alert a WHERE a.id = media.alert_id AND a.citizen_id = app_citizen_id()));
CREATE POLICY media_citizen_insert ON media FOR INSERT TO guardia_app WITH CHECK (app_role() = 'citizen' AND EXISTS (
  SELECT 1 FROM alert a WHERE a.id = media.alert_id AND a.citizen_id = app_citizen_id()));

-- ---------------------------------------------------------------------------------------- M6
ALTER TABLE operator ADD CONSTRAINT operator_email_lower CHECK (email = lower(email) AND char_length(email) <= 160);

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE shift ADD CONSTRAINT shift_no_overlap
  EXCLUDE USING gist (operator_id WITH =, tstzrange(planned_start, planned_end) WITH &&)
  WHERE (planned_start IS NOT NULL);

ALTER TABLE tenant ADD CONSTRAINT tenant_slug_fmt CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE tenant ADD CONSTRAINT tenant_cut_fmt  CHECK (cut_code IS NULL OR cut_code ~ '^[0-9]{4,5}$');
CREATE UNIQUE INDEX tenant_cut_code_uidx ON tenant (cut_code) WHERE cut_code IS NOT NULL;
ALTER TABLE tenant ADD CONSTRAINT tenant_settings_obj CHECK (jsonb_typeof(settings) = 'object');

ALTER TABLE alert
  ADD CONSTRAINT alert_user_text_len     CHECK (char_length(user_text)     <= 1000) NOT VALID,
  ADD CONSTRAINT alert_transcription_len CHECK (char_length(transcription) <= 5000) NOT VALID,
  ADD CONSTRAINT alert_ai_summary_len    CHECK (char_length(ai_summary)    <= 500)  NOT VALID,
  ADD CONSTRAINT alert_address_hint_len  CHECK (char_length(address_hint)  <= 300)  NOT VALID,
  ADD CONSTRAINT alert_ai_error_len      CHECK (char_length(ai_error)      <= 1000) NOT VALID,
  ADD CONSTRAINT alert_accuracy_chk      CHECK (accuracy_m IS NULL OR accuracy_m >= 0) NOT VALID,
  ADD CONSTRAINT alert_ai_flags_obj      CHECK (ai_flags IS NULL OR jsonb_typeof(ai_flags) = 'object') NOT VALID;
ALTER TABLE alert VALIDATE CONSTRAINT alert_user_text_len;
ALTER TABLE alert VALIDATE CONSTRAINT alert_transcription_len;
ALTER TABLE alert VALIDATE CONSTRAINT alert_ai_summary_len;
ALTER TABLE alert VALIDATE CONSTRAINT alert_address_hint_len;
ALTER TABLE alert VALIDATE CONSTRAINT alert_ai_error_len;
ALTER TABLE alert VALIDATE CONSTRAINT alert_accuracy_chk;
ALTER TABLE alert VALIDATE CONSTRAINT alert_ai_flags_obj;
ALTER TABLE media  ADD CONSTRAINT media_duration_chk CHECK (duration_s IS NULL OR duration_s >= 0);
ALTER TABLE device ADD CONSTRAINT device_token_len   CHECK (char_length(expo_push_token) BETWEEN 10 AND 200);

CREATE TRIGGER incident_updated_at BEFORE UPDATE ON incident FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contact_updated_at  BEFORE UPDATE ON contact  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------- M8
ALTER TABLE unit    SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 50);
ALTER TABLE device  SET (fillfactor = 80);
ALTER TABLE citizen SET (fillfactor = 90);
ALTER TABLE alert   SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE refresh_token SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE otp_code SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 1000);
