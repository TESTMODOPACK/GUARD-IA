-- Uso indebido, etapa 3 (13-10-2026; docs/plan-plataforma.md §5b): cuenta restringida, bloqueo con
-- aprobación, revisión pedida por el vecino y anulación de faltas.
--
-- 1. Restringida: 2 faltas vigentes (en todo el país; la cuenta es una sola). Se deriva de citizen_strike, sin
--    tabla propia. El SOS sigue llegando, en prioridad MEDIUM y con la marca alert.citizen_restricted; los
--    reportes urbanos se rechazan.
-- 2. Bloqueo (citizen_block): la 3.ª falta lo propone (PROPOSED). Lo aprueba un supervisor o administrador del
--    municipio distinto de quien propuso (ACTIVE: 30 días, reincidencia 6 meses, indefinido solo el
--    administrador) o lo descarta (DISMISSED). Se levanta antes (LIFTED) o vence (EXPIRED, lo marca el cron).
--    Bloqueada, la cuenta no envía alertas (decisión 13-10: la app queda sin uso y muestra los números de
--    emergencia, el plazo y cómo pedir revisión).
-- 3. Revisión (citizen_review): el vecino pide revisar una falta o un bloqueo con un texto breve; la resuelve el
--    municipio que sancionó: GRANTED anula la falta o levanta el bloqueo, DENIED la mantiene; siempre con
--    respuesta al vecino.
-- 4. El trigger alert_account aplica 1 y 2 al insertar la alerta. Corre antes del ruteo (orden alfabético:
--    alert_account < alert_route): un bloqueo rige en cualquier comuna.
--
-- Umbrales (espejo en shared: RESTRICT_AT_STRIKES = 2, BLOCK_PROPOSAL_AT_STRIKES = 3).

ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'CITIZEN_BLOCKED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'CITIZEN_BLOCK_DISMISSED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'CITIZEN_UNBLOCKED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'STRIKE_ANNULLED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'REVIEW_RESOLVED';

CREATE TYPE citizen_block_status AS ENUM ('PROPOSED', 'ACTIVE', 'DISMISSED', 'LIFTED', 'EXPIRED');
CREATE TYPE citizen_review_status AS ENUM ('PENDING', 'GRANTED', 'DENIED');

-- ---------------------------------------------------------------------------------------- bloqueos
CREATE TABLE citizen_block (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id     uuid NOT NULL REFERENCES citizen(id),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  -- Alerta con la que se llegó a la 3.ª falta.
  alert_id       uuid REFERENCES alert(id),
  status         citizen_block_status NOT NULL DEFAULT 'PROPOSED',
  -- Faltas vigentes al proponer y plazo sugerido (6 meses si ya cumplió un bloqueo en el último año).
  strikes        smallint NOT NULL CHECK (strikes BETWEEN 1 AND 100),
  suggested_days smallint NOT NULL CHECK (suggested_days IN (30, 180)),
  -- Plazo aprobado; NULL con ACTIVE es indefinido (solo el administrador).
  days           smallint CHECK (days IN (30, 180)),
  starts_at      timestamptz,
  ends_at        timestamptz,
  proposed_by    uuid NOT NULL,
  proposed_at    timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text CHECK (char_length(decision_note) <= 500),
  lifted_by      uuid,
  lifted_at      timestamptz,
  lift_reason    text CHECK (char_length(lift_reason) <= 500),
  CONSTRAINT citizen_block_proposer_fk FOREIGN KEY (proposed_by, tenant_id) REFERENCES operator (id, tenant_id),
  CONSTRAINT citizen_block_decider_fk FOREIGN KEY (decided_by, tenant_id) REFERENCES operator (id, tenant_id),
  CONSTRAINT citizen_block_lifter_fk FOREIGN KEY (lifted_by, tenant_id) REFERENCES operator (id, tenant_id),
  -- Dos personas para bloquear (§5b, principio 4): quien propone no decide.
  CONSTRAINT citizen_block_two_people_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK (status = 'PROPOSED' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status NOT IN ('ACTIVE', 'LIFTED', 'EXPIRED') OR starts_at IS NOT NULL),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK ((ends_at IS NULL) = (days IS NULL)),
  CHECK ((status = 'LIFTED') = (lifted_at IS NOT NULL))
);
-- Una propuesta o un bloqueo vigente por vecino (los vencidos pasan a EXPIRED).
CREATE UNIQUE INDEX citizen_block_open_uidx ON citizen_block (citizen_id) WHERE status IN ('PROPOSED', 'ACTIVE');
CREATE INDEX citizen_block_tenant_idx ON citizen_block (tenant_id, status, proposed_at DESC);
CREATE INDEX citizen_block_citizen_idx ON citizen_block (citizen_id, status);
CREATE INDEX citizen_block_ends_idx ON citizen_block (ends_at) WHERE status = 'ACTIVE';

REVOKE ALL ON citizen_block FROM guardia_app;
GRANT SELECT, INSERT ON citizen_block TO guardia_app;
GRANT UPDATE (status, days, starts_at, ends_at, decided_by, decided_at, decision_note, lifted_by, lifted_at, lift_reason)
  ON citizen_block TO guardia_app;

ALTER TABLE citizen_block ENABLE ROW LEVEL SECURITY;
CREATE POLICY citizen_block_system ON citizen_block FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
-- Como las faltas: la central ve el bloqueo de un vecino con alertas en su municipio, pero solo decide los suyos.
CREATE POLICY citizen_block_operator_read ON citizen_block FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND (tenant_id = app_tenant_id() OR EXISTS (
    SELECT 1 FROM alert a WHERE a.citizen_id = citizen_block.citizen_id AND a.tenant_id = app_tenant_id())));
CREATE POLICY citizen_block_operator_insert ON citizen_block FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY citizen_block_operator_update ON citizen_block FOR UPDATE TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY citizen_block_citizen ON citizen_block FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id());

-- ---------------------------------------------------------------------------------------- revisiones
CREATE TABLE citizen_review (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id  uuid NOT NULL REFERENCES citizen(id),
  -- Municipio que sancionó (el de la falta o el del bloqueo): es quien resuelve.
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  strike_id   uuid REFERENCES citizen_strike(id),
  block_id    uuid REFERENCES citizen_block(id),
  text        text NOT NULL CHECK (char_length(text) BETWEEN 10 AND 1000),
  status      citizen_review_status NOT NULL DEFAULT 'PENDING',
  response    text CHECK (char_length(response) <= 1000),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citizen_review_resolver_fk FOREIGN KEY (resolved_by, tenant_id) REFERENCES operator (id, tenant_id),
  CHECK ((strike_id IS NULL) <> (block_id IS NULL)),
  CHECK ((status = 'PENDING') = (resolved_at IS NULL)),
  CHECK (status = 'PENDING' OR (response IS NOT NULL AND resolved_by IS NOT NULL))
);
-- Una revisión pendiente por falta o bloqueo.
CREATE UNIQUE INDEX citizen_review_strike_pending_uidx ON citizen_review (strike_id) WHERE status = 'PENDING' AND strike_id IS NOT NULL;
CREATE UNIQUE INDEX citizen_review_block_pending_uidx ON citizen_review (block_id) WHERE status = 'PENDING' AND block_id IS NOT NULL;
CREATE INDEX citizen_review_tenant_idx ON citizen_review (tenant_id, status, created_at);
CREATE INDEX citizen_review_citizen_idx ON citizen_review (citizen_id, created_at DESC);

REVOKE ALL ON citizen_review FROM guardia_app;
GRANT SELECT, INSERT ON citizen_review TO guardia_app;
GRANT UPDATE (status, response, resolved_by, resolved_at) ON citizen_review TO guardia_app;

ALTER TABLE citizen_review ENABLE ROW LEVEL SECURITY;
CREATE POLICY citizen_review_system ON citizen_review FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY citizen_review_operator ON citizen_review FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY citizen_review_operator_update ON citizen_review FOR UPDATE TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY citizen_review_citizen_read ON citizen_review FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id());
-- El vecino solo pide revisión de lo suyo, y ante el municipio que lo sancionó.
CREATE POLICY citizen_review_citizen_insert ON citizen_review FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'citizen' AND citizen_id = app_citizen_id() AND status = 'PENDING' AND (
    EXISTS (SELECT 1 FROM citizen_strike s WHERE s.id = citizen_review.strike_id
             AND s.citizen_id = app_citizen_id() AND s.tenant_id = citizen_review.tenant_id)
    OR EXISTS (SELECT 1 FROM citizen_block b WHERE b.id = citizen_review.block_id
             AND b.citizen_id = app_citizen_id() AND b.tenant_id = citizen_review.tenant_id)));

-- ---------------------------------------------------------------------------------------- alerta
-- Marca de la cuenta al llegar la alerta (inmutable: sin GRANT UPDATE; la fija el trigger).
ALTER TABLE alert ADD COLUMN citizen_restricted boolean NOT NULL DEFAULT false;

CREATE FUNCTION alert_account_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_until   timestamptz;
  v_blocked boolean := false;
  v_strikes integer;
BEGIN
  SELECT true, b.ends_at INTO v_blocked, v_until
    FROM citizen_block b
   WHERE b.citizen_id = NEW.citizen_id AND b.status = 'ACTIVE' AND (b.ends_at IS NULL OR b.ends_at > now())
   ORDER BY b.ends_at DESC NULLS FIRST
   LIMIT 1;
  IF v_blocked THEN
    RAISE EXCEPTION 'cuenta bloqueada' USING ERRCODE = 'GIA10', DETAIL = COALESCE(v_until::text, 'indefinido');
  END IF;

  SELECT count(*) INTO v_strikes
    FROM citizen_strike s
   WHERE s.citizen_id = NEW.citizen_id AND s.annulled_at IS NULL AND s.expires_at > now();
  -- Lo que venga en el INSERT se descarta: la marca la pone la base.
  NEW.citizen_restricted := v_strikes >= 2;
  -- El SOS llega igual. La prioridad no se toca aquí: el vecino inserta sin prioridad (política
  -- alert_citizen_insert, 0009) y la cola ya ordena una alerta sin clasificar como media. El worker la deja
  -- en media salvo frase de riesgo vital (capPriority).
  IF NEW.citizen_restricted AND NEW.type = 'CIVIC_REPORT' THEN
    RAISE EXCEPTION 'cuenta restringida' USING ERRCODE = 'GIA11';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER alert_account BEFORE INSERT ON alert FOR EACH ROW EXECUTE FUNCTION alert_account_check();

-- ---------------------------------------------------------------------------------------- supresión
-- El cuerpo vigente (0009) más las revisiones: su texto son palabras del vecino. Las faltas y bloqueos quedan
-- (son decisiones del municipio sobre una cuenta ya anonimizada).
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

  UPDATE citizen_review SET text = '[suprimido por el vecino]' WHERE citizen_id = p_citizen;

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
END $$;

-- ---------------------------------------------------------------------------------------- plataforma
-- Uso indebido por municipio para la consola (§5b "Varios municipios y plataforma"): solo conteos.
CREATE FUNCTION platform_misuse(p_since timestamptz)
  RETURNS TABLE (tenant_id uuid, strikes bigint, active_blocks bigint, pending_proposals bigint, pending_reviews bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_platform();
  RETURN QUERY
    SELECT t.id,
           (SELECT count(*) FROM citizen_strike s WHERE s.tenant_id = t.id AND s.created_at >= p_since AND s.annulled_at IS NULL),
           (SELECT count(*) FROM citizen_block b WHERE b.tenant_id = t.id AND b.status = 'ACTIVE'
                                                   AND (b.ends_at IS NULL OR b.ends_at > now())),
           (SELECT count(*) FROM citizen_block b WHERE b.tenant_id = t.id AND b.status = 'PROPOSED'),
           (SELECT count(*) FROM citizen_review r WHERE r.tenant_id = t.id AND r.status = 'PENDING')
      FROM tenant t;
END $$;

REVOKE ALL ON FUNCTION platform_misuse(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_misuse(timestamptz) TO guardia_app;
