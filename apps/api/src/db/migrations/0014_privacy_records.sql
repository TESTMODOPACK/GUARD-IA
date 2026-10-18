-- 0014 · Ley 21.719, etapa 1: poder demostrar (docs/plan-ley-21719.md, 15-10-2026).
--
-- - Consentimiento con historial (1.1): cada aceptación o revocación queda en consent_record (solo inserción) y apunta
--   al texto exacto que vio el vecino (consent_notice, guardado por su hash). citizen.consent_version/consent_at
--   quedan como caché. citizen.external_ai: el vecino puede oponerse al análisis con IA externa; el worker clasifica
--   entonces sin red y deja ai_status = 'LOCAL'. El SOS nunca depende de esto.
-- - Contacto para ejercer derechos (1.2): tenant_privacy, una fila por municipio, la edita su administrador.
-- - Edad declarada (1.3): citizen.age_declared_at.
-- - Subencargados (1.4): catálogo (subprocessor) y autorización escrita de cada municipio (tenant_subprocessor). El
--   worker no envía nada a un proveedor de IA que el municipio de la alerta no autorizó.
-- - Contratos con referencia y evaluación de impacto (1.4): tenant.contract_ref, dpa_ref, dpia_*; la lista de puesta
--   en marcha los exige junto con el contacto de privacidad y los subencargados en uso autorizados.
-- - Incidentes de seguridad (1.5): registro de Guard-IA con los municipios afectados y sus avisos.
--
-- ALTER TYPE ... ADD VALUE corre en la transacción de la migración; los valores nuevos no se usan en este archivo.

ALTER TYPE ai_status ADD VALUE IF NOT EXISTS 'LOCAL';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'PRIVACY_CONTACT_UPDATED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_AUTHORIZED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_REVOKED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'INCIDENT_NOTIFIED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'INCIDENT_AGENCY_REPORTED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'INCIDENT_SUBJECTS_NOTIFIED';
ALTER TYPE platform_action ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_CREATED';
ALTER TYPE platform_action ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_UPDATED';
ALTER TYPE platform_action ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_AUTHORIZED';
ALTER TYPE platform_action ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_REVOKED';
ALTER TYPE platform_action ADD VALUE IF NOT EXISTS 'INCIDENT_OPENED';
ALTER TYPE platform_action ADD VALUE IF NOT EXISTS 'INCIDENT_UPDATED';
ALTER TYPE platform_action ADD VALUE IF NOT EXISTS 'INCIDENT_TENANT_NOTIFIED';

-- ---------------------------------------------------------------------------------------- 1.1 consentimiento
-- El texto exacto de cada aviso que se mostró (lo arma la API desde shared con la configuración vigente). Se guarda una
-- vez por hash: es la prueba de qué leyó el vecino al aceptar.
CREATE TABLE consent_notice (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version    text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 20),
  text_hash  text NOT NULL UNIQUE CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  body       jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE consent_purpose AS ENUM ('SERVICE', 'EXTERNAL_AI');
CREATE TYPE consent_action AS ENUM ('GRANTED', 'REVOKED');

CREATE TABLE consent_record (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id  uuid NOT NULL REFERENCES citizen(id),
  notice_id   uuid NOT NULL REFERENCES consent_notice(id),
  purpose     consent_purpose NOT NULL,
  action      consent_action NOT NULL,
  app_version text CHECK (char_length(app_version) <= 40),
  platform    text CHECK (char_length(platform) <= 20),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_record_citizen_idx ON consent_record (citizen_id, created_at DESC);

ALTER TABLE citizen
  ADD COLUMN external_ai     boolean NOT NULL DEFAULT true,
  ADD COLUMN age_declared_at timestamptz;

REVOKE ALL ON consent_notice, consent_record FROM guardia_app;
GRANT SELECT, INSERT ON consent_notice TO guardia_app;
-- Solo inserción: un consentimiento no se edita ni se borra; revocar es otra fila.
GRANT SELECT, INSERT ON consent_record TO guardia_app;
GRANT UPDATE (external_ai, age_declared_at) ON citizen TO guardia_app;

ALTER TABLE consent_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_notice_system ON consent_notice FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
-- El texto de los avisos no es dato personal: el vecino lo lee para su exportación.
CREATE POLICY consent_notice_citizen ON consent_notice FOR SELECT TO guardia_app USING (app_role() = 'citizen');
CREATE POLICY consent_record_system ON consent_record FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY consent_record_citizen_read ON consent_record FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id());
CREATE POLICY consent_record_citizen_insert ON consent_record FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'citizen' AND citizen_id = app_citizen_id());

-- ---------------------------------------------------------------------------------------- 1.2 contacto
CREATE TABLE tenant_privacy (
  tenant_id       uuid PRIMARY KEY REFERENCES tenant(id),
  contact_email   text NOT NULL CHECK (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(contact_email) <= 160),
  contact_address text CHECK (char_length(contact_address) <= 200),
  dpo_name        text CHECK (char_length(dpo_name) <= 120),
  dpo_email       text CHECK (dpo_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(dpo_email) <= 160),
  policy_url      text CHECK (policy_url ~ '^https://' AND char_length(policy_url) <= 300),
  policy_version  text CHECK (char_length(policy_version) <= 40),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_privacy_actor_fk FOREIGN KEY (updated_by, tenant_id) REFERENCES operator (id, tenant_id)
);
REVOKE ALL ON tenant_privacy FROM guardia_app;
GRANT SELECT, INSERT ON tenant_privacy TO guardia_app;
GRANT UPDATE (contact_email, contact_address, dpo_name, dpo_email, policy_url, policy_version, updated_by, updated_at)
  ON tenant_privacy TO guardia_app;
ALTER TABLE tenant_privacy ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_privacy_system ON tenant_privacy FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
-- Lo edita el administrador de su municipio (la API exige ADMIN); el resto de la central lo lee.
CREATE POLICY tenant_privacy_operator ON tenant_privacy FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY tenant_privacy_platform ON tenant_privacy FOR SELECT TO guardia_app USING (app_role() = 'platform');
-- El vecino ve el contacto de los municipios que atienden sus alertas: a quién pedir sus derechos (art. 14 ter).
CREATE POLICY tenant_privacy_citizen ON tenant_privacy FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.tenant_id = tenant_privacy.tenant_id AND a.citizen_id = app_citizen_id()));

-- ---------------------------------------------------------------------------------------- 1.4 subencargados
CREATE TYPE subprocessor_service AS ENUM ('AI', 'SMS', 'PUSH', 'HOSTING', 'STORAGE', 'BACKUP', 'MAPS', 'OTHER');

-- Catálogo de Guard-IA. `key` identifica al proveedor en la configuración (p. ej. el de IA activo); `in_use` marca
-- los que el servicio usa hoy: la puesta en marcha exige que el municipio los haya autorizado todos.
CREATE TABLE subprocessor (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  service         subprocessor_service NOT NULL,
  country         text NOT NULL CHECK (char_length(country) BETWEEN 2 AND 80),
  data_categories text NOT NULL CHECK (char_length(data_categories) BETWEEN 2 AND 500),
  guarantee       text CHECK (char_length(guarantee) <= 500),
  in_use          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subprocessor_updated_at BEFORE UPDATE ON subprocessor FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO subprocessor (key, name, service, country, data_categories, guarantee) VALUES
  ('openai', 'OpenAI', 'AI', 'Estados Unidos',
   'Audio y texto de las alertas, sin teléfono, nombre ni ubicación', 'Cláusulas contractuales (art. 27 b); sin retención ni entrenamiento: por confirmar'),
  ('groq', 'Groq', 'AI', 'Estados Unidos',
   'Audio y texto de las alertas, sin teléfono, nombre ni ubicación', 'Cláusulas contractuales (art. 27 b); sin retención ni entrenamiento: por confirmar'),
  ('twilio', 'Twilio', 'SMS', 'Estados Unidos', 'Teléfono del vecino y código de ingreso', 'Cláusulas contractuales (art. 27 b)'),
  ('expo', 'Expo (vía Google y Apple)', 'PUSH', 'Estados Unidos',
   'Identificador del teléfono para avisos y texto del aviso, sin datos de la alerta', 'Cláusulas contractuales (art. 27 b)');

CREATE TABLE tenant_subprocessor (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  subprocessor_id uuid NOT NULL REFERENCES subprocessor(id),
  -- Fecha del documento firmado por el municipio, quién firmó y dónde consta (art. 15 bis: autorización específica
  -- y por escrito).
  authorized_at   date NOT NULL,
  authorized_by   text NOT NULL CHECK (char_length(authorized_by) BETWEEN 2 AND 120),
  document_ref    text NOT NULL CHECK (char_length(document_ref) BETWEEN 2 AND 200),
  revoked_at      timestamptz,
  created_by      uuid REFERENCES platform_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_subprocessor_active_uidx ON tenant_subprocessor (tenant_id, subprocessor_id)
  WHERE revoked_at IS NULL;

REVOKE ALL ON subprocessor, tenant_subprocessor FROM guardia_app;
GRANT SELECT, INSERT ON subprocessor TO guardia_app;
GRANT UPDATE (name, service, country, data_categories, guarantee, in_use, updated_at) ON subprocessor TO guardia_app;
GRANT SELECT, INSERT ON tenant_subprocessor TO guardia_app;
GRANT UPDATE (revoked_at) ON tenant_subprocessor TO guardia_app;

ALTER TABLE subprocessor ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subprocessor ENABLE ROW LEVEL SECURITY;
CREATE POLICY subprocessor_system ON subprocessor FOR SELECT TO guardia_app USING (app_role() = 'system');
CREATE POLICY subprocessor_operator ON subprocessor FOR SELECT TO guardia_app USING (app_role() = 'operator');
CREATE POLICY subprocessor_platform ON subprocessor FOR ALL TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');
CREATE POLICY tenant_subprocessor_system ON tenant_subprocessor FOR SELECT TO guardia_app USING (app_role() = 'system');
CREATE POLICY tenant_subprocessor_operator ON tenant_subprocessor FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY tenant_subprocessor_platform ON tenant_subprocessor FOR ALL TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');

-- Contratos con versión y referencia del documento, no solo la fecha; evaluación de impacto aprobada (art. 15 ter).
ALTER TABLE tenant
  ADD COLUMN contract_ref     text CHECK (char_length(contract_ref) <= 200),
  ADD COLUMN dpa_ref          text CHECK (char_length(dpa_ref) <= 200),
  ADD COLUMN dpia_approved_at date,
  ADD COLUMN dpia_ref         text CHECK (char_length(dpia_ref) <= 200);
GRANT SELECT (contract_ref, dpa_ref, dpia_approved_at, dpia_ref) ON tenant TO guardia_app;
GRANT UPDATE (contract_ref, dpa_ref, dpia_approved_at, dpia_ref) ON tenant TO guardia_app;

-- ---------------------------------------------------------------------------------------- 1.5 incidentes
CREATE TYPE incident_nature AS ENUM ('DESTRUCTION', 'LEAK', 'LOSS', 'ALTERATION', 'UNAUTHORIZED_ACCESS');
CREATE TYPE security_incident_status AS ENUM ('OPEN', 'CLOSED');
CREATE SEQUENCE security_incident_number_seq;

-- Registro de Guard-IA (art. 14 sexies inciso 2, y 15 bis: el encargado avisa al responsable). Cada cambio queda en
-- platform_audit_log; nada se borra.
CREATE TABLE security_incident (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            integer NOT NULL UNIQUE DEFAULT nextval('security_incident_number_seq'),
  detected_at       timestamptz NOT NULL,
  started_at        timestamptz,
  detected_by       text NOT NULL CHECK (char_length(detected_by) BETWEEN 2 AND 120),
  nature            incident_nature NOT NULL,
  summary           text NOT NULL CHECK (char_length(summary) BETWEEN 10 AND 2000),
  data_categories   text NOT NULL CHECK (char_length(data_categories) BETWEEN 2 AND 500),
  affected_estimate integer CHECK (affected_estimate >= 0),
  sensitive_data    boolean NOT NULL DEFAULT false,
  measures          text CHECK (char_length(measures) <= 2000),
  status            security_incident_status NOT NULL DEFAULT 'OPEN',
  closed_at         timestamptz,
  created_by        uuid REFERENCES platform_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_incident_closed_chk CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT security_incident_dates_chk CHECK (started_at IS NULL OR started_at <= detected_at)
);
CREATE INDEX security_incident_status_idx ON security_incident (status, detected_at DESC);
CREATE TRIGGER security_incident_updated_at BEFORE UPDATE ON security_incident
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Un municipio afectado: cuándo le avisó Guard-IA y, de su parte, el reporte a la Agencia y el aviso a los vecinos
-- (o por qué no correspondía).
CREATE TABLE security_incident_tenant (
  incident_id           uuid NOT NULL REFERENCES security_incident(id),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  notified_at           timestamptz NOT NULL DEFAULT now(),
  agency_reported_at    timestamptz,
  agency_ref            text CHECK (char_length(agency_ref) <= 200),
  subjects_notified_at  timestamptz,
  subjects_note         text CHECK (char_length(subjects_note) <= 1000),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, tenant_id)
);
CREATE INDEX security_incident_tenant_idx ON security_incident_tenant (tenant_id, notified_at DESC);
CREATE TRIGGER security_incident_tenant_updated_at BEFORE UPDATE ON security_incident_tenant
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

REVOKE ALL ON security_incident, security_incident_tenant FROM guardia_app;
GRANT USAGE ON SEQUENCE security_incident_number_seq TO guardia_app;
GRANT SELECT, INSERT ON security_incident TO guardia_app;
GRANT UPDATE (started_at, summary, data_categories, affected_estimate, sensitive_data, measures, status, closed_at,
  updated_at) ON security_incident TO guardia_app;
GRANT SELECT, INSERT ON security_incident_tenant TO guardia_app;
GRANT UPDATE (agency_reported_at, agency_ref, subjects_notified_at, subjects_note, updated_at)
  ON security_incident_tenant TO guardia_app;

ALTER TABLE security_incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_incident_tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_incident_platform ON security_incident FOR ALL TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');
CREATE POLICY security_incident_system ON security_incident FOR SELECT TO guardia_app USING (app_role() = 'system');
-- La central ve solo los incidentes que afectan a su municipio.
CREATE POLICY security_incident_operator ON security_incident FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND EXISTS (
    SELECT 1 FROM security_incident_tenant st WHERE st.incident_id = security_incident.id AND st.tenant_id = app_tenant_id()));
CREATE POLICY security_incident_tenant_platform ON security_incident_tenant FOR ALL TO guardia_app
  USING (app_role() = 'platform') WITH CHECK (app_role() = 'platform');
CREATE POLICY security_incident_tenant_system ON security_incident_tenant FOR SELECT TO guardia_app
  USING (app_role() = 'system');
-- El municipio registra su reporte a la Agencia y el aviso a los vecinos (la API exige ADMIN).
CREATE POLICY security_incident_tenant_operator_read ON security_incident_tenant FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY security_incident_tenant_operator_update ON security_incident_tenant FOR UPDATE TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------------------- puesta en marcha
-- Igual que en 0012, más: contratos con referencia, evaluación de impacto, contacto de privacidad y todos los
-- subencargados en uso autorizados por escrito.
CREATE OR REPLACE FUNCTION tenant_readiness(p_tenant uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_items jsonb;
BEGIN
  PERFORM require_platform();
  WITH counts(key, n, required) AS (
    VALUES
      ('ADMIN_READY', (SELECT count(*) FROM operator o WHERE o.tenant_id = p_tenant AND o.role = 'ADMIN'
                         AND o.active AND NOT o.must_change_password), 1),
      ('OPERATORS', (SELECT count(*) FROM operator o WHERE o.tenant_id = p_tenant
                       AND o.role::text IN ('OPERATOR', 'SUPERVISOR') AND o.active), 2),
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
      ('CONTRACT_SIGNED', (SELECT count(*) FROM tenant t WHERE t.id = p_tenant AND t.contract_signed_at IS NOT NULL
                             AND t.contract_ref IS NOT NULL), 1),
      ('DPA_SIGNED', (SELECT count(*) FROM tenant t WHERE t.id = p_tenant AND t.dpa_signed_at IS NOT NULL
                        AND t.dpa_ref IS NOT NULL), 1),
      ('DPIA_APPROVED', (SELECT count(*) FROM tenant t WHERE t.id = p_tenant AND t.dpia_approved_at IS NOT NULL
                           AND t.dpia_ref IS NOT NULL), 1),
      ('PRIVACY_CONTACT', (SELECT count(*) FROM tenant_privacy p WHERE p.tenant_id = p_tenant), 1),
      -- n = subencargados en uso que el municipio autorizó; mínimo = todos los que están en uso.
      ('SUBPROCESSORS', (SELECT count(*) FROM subprocessor s WHERE s.in_use AND EXISTS (
                           SELECT 1 FROM tenant_subprocessor ts WHERE ts.subprocessor_id = s.id
                              AND ts.tenant_id = p_tenant AND ts.revoked_at IS NULL)),
                        (SELECT count(*) FROM subprocessor s WHERE s.in_use)),
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
