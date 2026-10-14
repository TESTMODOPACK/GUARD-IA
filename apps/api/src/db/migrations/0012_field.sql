-- 0012 · Terreno (docs/plan-plataforma.md §5c, fase PT): el funcionario de terreno informa desde su teléfono.
--
-- - Rol FIELD: cada funcionario con su cuenta (decisión 14-10-2026). Al iniciar turno elige su unidad
--   (shift.unit_id); varios funcionarios pueden salir en la misma unidad.
-- - Contexto RLS `field` (DbService.asField): ve solo su municipio, su turno, su unidad y el caso al que la
--   despacharon. Nunca la cola de la central, ni otros casos, ni los datos del vecino (citizen no tiene política
--   para field). La API además niega al rol FIELD todo endpoint que no lo nombre (AuthGuard).
-- - dispatch: quién informó el resultado (outcome_via) y la categoría que propone la unidad con "era otra
--   situación" (la aplica la central con un clic).
-- - field_alarm: pánico del funcionario, pedido de apoyo y plazos vencidos (RT-6, RT-3, RT-7).
--
-- ALTER TYPE ... ADD VALUE corre dentro de la transacción de la migración; los valores nuevos (FIELD,
-- FIELD_ALARM) no se usan en este archivo: las funciones comparan texto.

ALTER TYPE operator_role ADD VALUE IF NOT EXISTS 'FIELD';
ALTER TYPE alert_event_kind ADD VALUE IF NOT EXISTS 'FIELD_ALARM';

CREATE TYPE outcome_via AS ENUM ('CENTRAL', 'FIELD');
CREATE TYPE field_alarm_kind AS ENUM ('PANIC', 'SUPPORT', 'LATE', 'NO_NEWS');

-- ---------------------------------------------------------------------------------------- turno con unidad
ALTER TABLE shift ADD COLUMN unit_id uuid;
ALTER TABLE shift ADD CONSTRAINT shift_unit_fk FOREIGN KEY (unit_id, tenant_id) REFERENCES unit (id, tenant_id);
CREATE INDEX shift_unit_open_idx ON shift (unit_id)
  WHERE unit_id IS NOT NULL AND started_at IS NOT NULL AND ended_at IS NULL;
GRANT UPDATE (unit_id) ON shift TO guardia_app;

-- ---------------------------------------------------------------------------------------- contexto field
CREATE FUNCTION app_operator_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.operator_id', true), '')::uuid $$;

-- Unidad del turno abierto del funcionario (NULL sin turno o fuera del contexto field). SECURITY DEFINER: lee
-- shift sin pasar por sus políticas, y solo la fila del propio funcionario.
CREATE FUNCTION app_field_unit() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.unit_id FROM shift s
   WHERE app_role() = 'field' AND s.operator_id = app_operator_id() AND s.tenant_id = app_tenant_id()
     AND s.started_at IS NOT NULL AND s.ended_at IS NULL
   LIMIT 1 $$;

-- ¿El funcionario puede ver esta alerta? Sí si su unidad tiene un despacho abierto hacia ella, o se la
-- despacharon o la cerró durante su turno (el informe que cierra el despacho guarda fotos y eventos después).
CREATE FUNCTION field_can_see_alert(p_alert uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_role() = 'field' AND EXISTS (
    SELECT 1 FROM dispatch d
      JOIN shift s ON s.unit_id = d.unit_id AND s.tenant_id = d.tenant_id
     WHERE d.alert_id = p_alert AND d.tenant_id = app_tenant_id()
       AND s.operator_id = app_operator_id() AND s.started_at IS NOT NULL AND s.ended_at IS NULL
       AND (d.status IN ('ASSIGNED', 'EN_ROUTE', 'ON_SITE') OR d.created_at >= s.started_at
            OR d.closed_at >= s.started_at)) $$;

REVOKE ALL ON FUNCTION app_field_unit() FROM PUBLIC;
REVOKE ALL ON FUNCTION field_can_see_alert(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_field_unit(), field_can_see_alert(uuid) TO guardia_app;

-- ---------------------------------------------------------------------------------------- despacho
ALTER TABLE dispatch
  ADD COLUMN outcome_via outcome_via,
  ADD COLUMN proposed_category alert_category,
  ADD COLUMN proposed_subcategory text CHECK (char_length(proposed_subcategory) <= 80);
UPDATE dispatch SET outcome_via = 'CENTRAL' WHERE outcome IS NOT NULL;
ALTER TABLE dispatch
  ADD CONSTRAINT dispatch_outcome_via_chk CHECK ((outcome IS NULL) = (outcome_via IS NULL)),
  ADD CONSTRAINT dispatch_proposed_chk CHECK (proposed_category IS NULL OR outcome = 'DIFFERENT_SITUATION'),
  ADD CONSTRAINT dispatch_proposed_sub_chk CHECK (proposed_subcategory IS NULL OR proposed_category IS NOT NULL);
ALTER TABLE dispatch ADD CONSTRAINT dispatch_id_tenant_key UNIQUE (id, tenant_id);
GRANT UPDATE (outcome_via, proposed_category, proposed_subcategory) ON dispatch TO guardia_app;

-- ---------------------------------------------------------------------------------------- avisos de terreno
CREATE TABLE field_alarm (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  kind         field_alarm_kind NOT NULL,
  unit_id      uuid,
  -- Funcionario que lo envió (pánico, apoyo); NULL en los plazos vencidos (los crea el sistema).
  operator_id  uuid,
  dispatch_id  uuid,
  alert_id     uuid,
  lat          double precision CHECK (lat BETWEEN -90 AND 90),
  lng          double precision CHECK (lng BETWEEN -180 AND 180),
  accuracy_m   real CHECK (accuracy_m >= 0),
  note         text CHECK (char_length(note) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Atendido en la central (closed_by) o cerrado por el sistema cuando la unidad volvió a dar noticias.
  closed_at    timestamptz,
  closed_by    uuid,
  close_note   text CHECK (char_length(close_note) <= 300),
  CONSTRAINT field_alarm_unit_fk FOREIGN KEY (unit_id, tenant_id) REFERENCES unit (id, tenant_id),
  CONSTRAINT field_alarm_operator_fk FOREIGN KEY (operator_id, tenant_id) REFERENCES operator (id, tenant_id),
  CONSTRAINT field_alarm_closer_fk FOREIGN KEY (closed_by, tenant_id) REFERENCES operator (id, tenant_id),
  CONSTRAINT field_alarm_dispatch_fk FOREIGN KEY (dispatch_id, tenant_id) REFERENCES dispatch (id, tenant_id),
  CONSTRAINT field_alarm_alert_fk FOREIGN KEY (alert_id, tenant_id) REFERENCES alert (id, tenant_id),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK (closed_by IS NULL OR closed_at IS NOT NULL),
  -- El pánico y el apoyo tienen autor; los plazos se refieren siempre a un despacho.
  CHECK (kind NOT IN ('PANIC', 'SUPPORT') OR operator_id IS NOT NULL),
  CHECK (kind = 'PANIC' OR dispatch_id IS NOT NULL)
);
-- Un pánico abierto por funcionario (volver a apretar actualiza la posición) y un aviso abierto de cada tipo por
-- despacho (el reloj de plazos corre cada 30 s y no duplica).
CREATE UNIQUE INDEX field_alarm_panic_open_uidx ON field_alarm (operator_id) WHERE kind = 'PANIC' AND closed_at IS NULL;
CREATE UNIQUE INDEX field_alarm_dispatch_open_uidx ON field_alarm (dispatch_id, kind)
  WHERE kind <> 'PANIC' AND closed_at IS NULL;
CREATE INDEX field_alarm_tenant_idx ON field_alarm (tenant_id, created_at DESC);
CREATE INDEX field_alarm_dispatch_idx ON field_alarm (dispatch_id) WHERE dispatch_id IS NOT NULL;

REVOKE ALL ON field_alarm FROM guardia_app;
GRANT SELECT, INSERT ON field_alarm TO guardia_app;
GRANT UPDATE (lat, lng, accuracy_m, closed_at, closed_by, close_note) ON field_alarm TO guardia_app;

ALTER TABLE field_alarm ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_alarm_system ON field_alarm FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY field_alarm_operator ON field_alarm FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY field_alarm_field ON field_alarm FOR ALL TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND operator_id = app_operator_id())
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND operator_id = app_operator_id());

-- Cuando la unidad (o la central) mueve el despacho, los plazos vencidos de ese despacho se cierran solos.
CREATE FUNCTION field_alarm_clear() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at THEN
    UPDATE field_alarm SET closed_at = now()
     WHERE dispatch_id = NEW.id AND kind IN ('LATE', 'NO_NEWS') AND closed_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_field_alarm_clear AFTER UPDATE ON dispatch FOR EACH ROW EXECUTE FUNCTION field_alarm_clear();

-- ---------------------------------------------------------------------------------------- políticas field
-- Su municipio (nombre y retención de archivos) y su propia cuenta.
CREATE POLICY tenant_field ON tenant FOR SELECT TO guardia_app
  USING (app_role() = 'field' AND id = app_tenant_id());
CREATE POLICY operator_field ON operator FOR SELECT TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND id = app_operator_id());

-- Unidades del municipio (para elegir al iniciar turno); solo la suya se actualiza (posición, disponible).
CREATE POLICY unit_field_select ON unit FOR SELECT TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id());
CREATE POLICY unit_field_update ON unit FOR UPDATE TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND id = app_field_unit())
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND id = app_field_unit());

-- Su turno.
CREATE POLICY shift_field ON shift FOR ALL TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND operator_id = app_operator_id())
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND operator_id = app_operator_id());

-- Despachos de su unidad.
CREATE POLICY dispatch_field_select ON dispatch FOR SELECT TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND unit_id = app_field_unit());
CREATE POLICY dispatch_field_update ON dispatch FOR UPDATE TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND unit_id = app_field_unit())
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND unit_id = app_field_unit());

-- El caso: leerlo y "tocarlo" (updated_at, para que el sync de la central lo vea). La API no cambia nada más.
CREATE POLICY alert_field_select ON alert FOR SELECT TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND field_can_see_alert(id));
CREATE POLICY alert_field_update ON alert FOR UPDATE TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND field_can_see_alert(id))
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND field_can_see_alert(id));

-- Línea de tiempo y fotos del caso (el tenant lo pone el trigger tenant_from_alert).
CREATE POLICY alert_event_field ON alert_event FOR ALL TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND field_can_see_alert(alert_id))
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND field_can_see_alert(alert_id));
CREATE POLICY media_field ON media FOR ALL TO guardia_app
  USING (app_role() = 'field' AND tenant_id = app_tenant_id() AND field_can_see_alert(alert_id))
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND field_can_see_alert(alert_id));

-- Bitácora: registra su inicio y fin de turno (solo inserción, como todos).
CREATE POLICY audit_log_field_insert ON audit_log FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'field' AND tenant_id = app_tenant_id() AND actor_id = app_operator_id());

-- ---------------------------------------------------------------------------------------- puesta en marcha
-- "Al menos 2 operadores o supervisores": los funcionarios de terreno no atienden la central.
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
