-- Agente de clasificación, triage-v2 (13-10-2026). Contrato en packages/shared/src/schemas/ai.ts y
-- reglas fijas en packages/shared/src/triage-rules.ts.
--
-- 1. La IA entrega más que una categoría: subcategoría, varias instituciones con su motivo (PDI se
--    suma a la lista), preguntas para el operador y las reglas fijas que corrigieron al modelo. Se
--    guarda completo en alert.ai_triage; las columnas de siempre (category, priority,
--    suggested_agency) siguen siendo las que usan la cola, el panel y los incidentes.
-- 2. La central confirma o corrige la clasificación y registra a qué instituciones derivó. Eso queda
--    en triage_label (una fila por alerta) junto con lo que había dicho la IA en ese momento: es el
--    conjunto con el que se mide y mejora el agente (pnpm --filter @guardia/api eval:triage).
--
-- ALTER TYPE ... ADD VALUE corre dentro de la transacción de la migración (PostgreSQL 12+); los
-- valores nuevos no se usan en este archivo.

ALTER TYPE suggested_agency ADD VALUE IF NOT EXISTS 'PDI';
ALTER TYPE alert_event_kind ADD VALUE IF NOT EXISTS 'RECLASSIFIED';
ALTER TYPE alert_event_kind ADD VALUE IF NOT EXISTS 'REFERRED';

-- Subcategoría como texto con formato fijo: la lista vive en shared (SUBCATEGORIES) y crece sin
-- migraciones; la API valida que corresponda a la categoría.
ALTER TABLE alert
  ADD COLUMN subcategory text CHECK (subcategory ~ '^[A-Z][A-Z_]{1,39}$'),
  ADD COLUMN ai_triage jsonb CHECK (ai_triage IS NULL OR jsonb_typeof(ai_triage) = 'object');
GRANT UPDATE (subcategory, ai_triage) ON alert TO guardia_app;

CREATE TABLE triage_label (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  alert_id       uuid NOT NULL UNIQUE REFERENCES alert(id) ON DELETE CASCADE,
  -- Clasificación que confirmó o corrigió el operador (null: solo registró la derivación).
  category       alert_category,
  subcategory    text CHECK (subcategory ~ '^[A-Z][A-Z_]{1,39}$'),
  -- Instituciones a las que efectivamente se derivó el caso.
  agencies       suggested_agency[] NOT NULL DEFAULT '{}' CHECK (cardinality(agencies) <= 8),
  -- Lo que proponía la IA cuando el operador decidió (no cambia si después se vuelve a analizar).
  ai_category    alert_category,
  ai_subcategory text CHECK (ai_subcategory ~ '^[A-Z][A-Z_]{1,39}$'),
  ai_agencies    suggested_agency[] NOT NULL DEFAULT '{}' CHECK (cardinality(ai_agencies) <= 8),
  ai_version     text CHECK (char_length(ai_version) <= 40),
  classified_by  uuid REFERENCES operator(id),
  classified_at  timestamptz,
  referred_by    uuid REFERENCES operator(id),
  referred_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (subcategory IS NULL OR category IS NOT NULL),
  CHECK ((category IS NULL) = (classified_at IS NULL)),
  CHECK ((referred_at IS NULL) = (cardinality(agencies) = 0))
);
-- Evaluación por municipio y período.
CREATE INDEX triage_label_tenant_created_idx ON triage_label (tenant_id, created_at DESC);

REVOKE DELETE ON triage_label FROM guardia_app;
REVOKE UPDATE ON triage_label FROM guardia_app;
GRANT UPDATE (category, subcategory, agencies, ai_category, ai_subcategory, ai_agencies, ai_version,
  classified_by, classified_at, referred_by, referred_at, updated_at) ON triage_label TO guardia_app;
ALTER TABLE triage_label ENABLE ROW LEVEL SECURITY;
CREATE POLICY triage_label_system ON triage_label FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY triage_label_operator ON triage_label FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- Supresión (0002): ai_triage repite lo que dijo el vecino (resumen, preguntas), así que también se
-- borra. La etiqueta del operador no tiene texto libre y se conserva, como la categoría.
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

  -- Audio y fotos: vencidos ya; la API llama a la purga después del commit (y la diaria es respaldo).
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

  DELETE FROM device WHERE citizen_id = p_citizen;
  DELETE FROM refresh_token WHERE subject_id = p_citizen AND kind = 'CITIZEN';
  DELETE FROM otp_code WHERE phone = v_phone;

  -- Teléfono ficticio único (+999 y 11 dígitos): libera el número real para un registro futuro.
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
