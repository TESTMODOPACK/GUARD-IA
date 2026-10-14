-- 0013 · Áreas municipales (decisión 14-10-2026).
--
-- - Las áreas las define el administrador municipal: nombre, cuál recibe los SOS (exactamente una) y qué
--   categoría o subcategoría de reporte urbano atiende cada una (area_rule). Las categorías siguen siendo
--   nacionales y fijas; el municipio solo decide quién las atiende.
-- - Cada aviso tiene un área: la pone la base al insertar (SOS al área de los SOS, reporte urbano según la
--   categoría que eligió el vecino; no espera a la IA), el agente la corrige y una persona puede reasignarla
--   (reassign_alert_area, auditada; manda sobre el agente). `security_relevant`: el agente marcó que un reporte
--   urbano tiene carácter de seguridad; además de su área lo ve el área de los SOS.
-- - Cada operador ve solo los avisos de sus áreas (operator_area), salvo el administrador, el modo compartido
--   (tenant_area_mode.shared, excepción que elige el municipio) o un municipio sin áreas. Política RESTRICTIVE en
--   alert y en lo que cuelga del aviso (eventos, archivos, despachos, etiquetas): un operador de Aseo nunca ve un SOS.
-- - Rol ASSISTANT (apoyo administrativo): consulta sin operar (la API se lo niega en las acciones).
--
-- ALTER TYPE ... ADD VALUE corre en la transacción de la migración; los valores nuevos no se usan en este archivo.

ALTER TYPE operator_role ADD VALUE IF NOT EXISTS 'ASSISTANT';
ALTER TYPE alert_event_kind ADD VALUE IF NOT EXISTS 'AREA_CHANGED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'AREA_CREATED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'AREA_UPDATED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'AREA_RULES_UPDATED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'AREA_MODE_CHANGED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'ALERT_AREA_CHANGED';

CREATE TYPE area_source AS ENUM ('AUTO', 'AI', 'OPERATOR');

-- ---------------------------------------------------------------------------------------- áreas
CREATE TABLE area (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  receives_sos boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT area_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT area_creator_fk FOREIGN KEY (created_by, tenant_id) REFERENCES operator (id, tenant_id),
  -- El área de los SOS no se desactiva: un SOS nunca queda sin quién lo vea.
  CONSTRAINT area_sos_active_chk CHECK (NOT receives_sos OR active)
);
CREATE UNIQUE INDEX area_name_uidx ON area (tenant_id, lower(name));
CREATE UNIQUE INDEX area_sos_uidx ON area (tenant_id) WHERE receives_sos;

REVOKE ALL ON area FROM guardia_app;
GRANT SELECT, INSERT ON area TO guardia_app;
GRANT UPDATE (name, receives_sos, active) ON area TO guardia_app;
ALTER TABLE area ENABLE ROW LEVEL SECURITY;
CREATE POLICY area_system ON area FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY area_operator ON area FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- Qué área atiende cada categoría urbana; con subcategoría, solo esa parte (manda sobre la general).
CREATE TABLE area_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  category    alert_category NOT NULL
              CHECK (category IN ('BACHE', 'LUMINARIA', 'BASURA_MICROBASURAL', 'SEMAFORO', 'AREA_VERDE', 'ANIMAL', 'OTRO_URBANO')),
  subcategory text CHECK (char_length(subcategory) <= 80),
  area_id     uuid NOT NULL,
  CONSTRAINT area_rule_area_fk FOREIGN KEY (area_id, tenant_id) REFERENCES area (id, tenant_id)
);
CREATE UNIQUE INDEX area_rule_uidx ON area_rule (tenant_id, category, coalesce(subcategory, ''));
CREATE INDEX area_rule_area_idx ON area_rule (area_id);

REVOKE ALL ON area_rule FROM guardia_app;
GRANT SELECT, INSERT, DELETE ON area_rule TO guardia_app;
ALTER TABLE area_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY area_rule_system ON area_rule FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY area_rule_operator ON area_rule FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- A qué áreas pertenece cada cuenta (el administrador ve todas sin importar esta lista).
CREATE TABLE operator_area (
  operator_id uuid NOT NULL,
  area_id     uuid NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  PRIMARY KEY (operator_id, area_id),
  CONSTRAINT operator_area_operator_fk FOREIGN KEY (operator_id, tenant_id) REFERENCES operator (id, tenant_id),
  CONSTRAINT operator_area_area_fk FOREIGN KEY (area_id, tenant_id) REFERENCES area (id, tenant_id)
);
CREATE INDEX operator_area_area_idx ON operator_area (area_id);

REVOKE ALL ON operator_area FROM guardia_app;
GRANT SELECT, INSERT, DELETE ON operator_area TO guardia_app;
ALTER TABLE operator_area ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_area_system ON operator_area FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY operator_area_operator ON operator_area FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- Excepción a la regla: todas las áreas ven todos los avisos. Una fila por municipio que lo haya configurado.
CREATE TABLE tenant_area_mode (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant(id),
  shared     boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_area_mode_actor_fk FOREIGN KEY (updated_by, tenant_id) REFERENCES operator (id, tenant_id)
);
REVOKE ALL ON tenant_area_mode FROM guardia_app;
GRANT SELECT, INSERT ON tenant_area_mode TO guardia_app;
GRANT UPDATE (shared, updated_by, updated_at) ON tenant_area_mode TO guardia_app;
ALTER TABLE tenant_area_mode ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_area_mode_system ON tenant_area_mode FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY tenant_area_mode_operator ON tenant_area_mode FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------------------- área del aviso
ALTER TABLE alert
  ADD COLUMN area_id uuid,
  ADD COLUMN area_source area_source,
  ADD COLUMN security_relevant boolean NOT NULL DEFAULT false;
ALTER TABLE alert
  ADD CONSTRAINT alert_area_fk FOREIGN KEY (area_id, tenant_id) REFERENCES area (id, tenant_id),
  ADD CONSTRAINT alert_area_source_chk CHECK ((area_id IS NULL) = (area_source IS NULL));
CREATE INDEX alert_area_idx ON alert (area_id) WHERE area_id IS NOT NULL;
GRANT UPDATE (area_id, area_source, security_relevant) ON alert TO guardia_app;

-- Área que corresponde a un aviso: el SOS al área de los SOS; el reporte urbano a la regla de su subcategoría o,
-- si no hay, a la de su categoría. Sin áreas activas (o sin regla) queda sin área: lo ve todo el municipio.
CREATE FUNCTION area_for(p_tenant uuid, p_type alert_type, p_category alert_category, p_subcategory text)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_tenant IS NULL THEN NULL
    WHEN p_type = 'EMERGENCY_SOS' THEN
      (SELECT a.id FROM area a WHERE a.tenant_id = p_tenant AND a.receives_sos AND a.active)
    ELSE
      (SELECT r.area_id FROM area_rule r JOIN area a ON a.id = r.area_id AND a.active
        WHERE r.tenant_id = p_tenant AND r.category = p_category
          AND (r.subcategory IS NULL OR r.subcategory = p_subcategory)
        ORDER BY (r.subcategory IS NULL) LIMIT 1)
  END $$;
REVOKE ALL ON FUNCTION area_for(uuid, alert_type, alert_category, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION area_for(uuid, alert_type, alert_category, text) TO guardia_app;

-- Al insertar (corre después de alert_route, que fija el municipio: los triggers van en orden alfabético). El
-- vecino no elige área ni marca de seguridad: lo que traiga se descarta.
CREATE FUNCTION alert_set_area() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.area_id := area_for(NEW.tenant_id, NEW.type, NEW.category, NEW.subcategory);
  NEW.area_source := CASE WHEN NEW.area_id IS NULL THEN NULL ELSE 'AUTO'::area_source END;
  NEW.security_relevant := false;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_set_area BEFORE INSERT ON alert FOR EACH ROW EXECUTE FUNCTION alert_set_area();

-- Recalcula el área después de clasificar (agente o persona), salvo que una persona la haya reasignado, y fija la
-- marca de seguridad (solo reportes urbanos; p_security NULL la deja como está). Devuelve el antes y el después
-- (para avisar a quienes dejan de verlo).
CREATE FUNCTION refresh_alert_area(p_alert uuid, p_source area_source, p_security boolean)
  RETURNS TABLE (out_prev_area uuid, out_prev_security boolean, out_area uuid, out_security boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v alert%ROWTYPE;
  v_area uuid;
  v_sec boolean;
BEGIN
  IF current_setting('app.role', true) NOT IN ('system', 'operator') THEN
    RAISE EXCEPTION 'refresh_alert_area: contexto no permitido' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v FROM alert WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND OR (current_setting('app.role', true) = 'operator'
                   AND current_setting('app.tenant_id', true) IS DISTINCT FROM v.tenant_id::text) THEN
    RAISE EXCEPTION 'refresh_alert_area: alerta no encontrada' USING ERRCODE = 'P0002';
  END IF;
  v_sec := CASE WHEN v.type = 'CIVIC_REPORT' THEN coalesce(p_security, v.security_relevant) ELSE false END;
  v_area := CASE WHEN v.area_source = 'OPERATOR' THEN v.area_id
                 ELSE coalesce(area_for(v.tenant_id, v.type, v.category, v.subcategory), v.area_id) END;
  UPDATE alert
     SET area_id = v_area,
         area_source = CASE WHEN v_area IS NULL THEN NULL
                            WHEN v_area IS DISTINCT FROM v.area_id THEN p_source
                            ELSE coalesce(v.area_source, p_source) END,
         security_relevant = v_sec
   WHERE id = p_alert;
  -- En la línea de tiempo, después del análisis que lo causó (misma transacción: clock_timestamp, no now()).
  IF v_area IS DISTINCT FROM v.area_id OR v_sec IS DISTINCT FROM v.security_relevant THEN
    INSERT INTO alert_event (alert_id, tenant_id, actor_type, kind, payload, created_at)
    VALUES (p_alert, v.tenant_id, CASE WHEN p_source = 'AI' THEN 'AI' ELSE 'SYSTEM' END::actor_type, 'AREA_CHANGED',
            jsonb_build_object('from', v.area_id, 'to', v_area, 'by', p_source, 'security', v_sec), clock_timestamp());
  END IF;
  RETURN QUERY SELECT v.area_id, v.security_relevant, v_area, v_sec;
END $$;
REVOKE ALL ON FUNCTION refresh_alert_area(uuid, area_source, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_alert_area(uuid, area_source, boolean) TO guardia_app;

-- Reasignar a otra área del municipio (una persona; manda sobre el agente). Única vía para que un operador mueva
-- un aviso a un área que quizás no ve: evento, bitácora y mismo municipio.
CREATE FUNCTION reassign_alert_area(p_alert uuid, p_area uuid, p_actor uuid, p_reason text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_from uuid;
BEGIN
  IF current_setting('app.role', true) IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'reassign_alert_area: contexto no permitido' USING ERRCODE = '42501';
  END IF;
  SELECT tenant_id, area_id INTO v_tenant, v_from FROM alert WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND OR current_setting('app.tenant_id', true) IS DISTINCT FROM v_tenant::text THEN
    RAISE EXCEPTION 'reassign_alert_area: alerta no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM area WHERE id = p_area AND tenant_id = v_tenant AND active) THEN
    RAISE EXCEPTION 'reassign_alert_area: área inválida' USING ERRCODE = '22023';
  END IF;
  IF v_from = p_area THEN
    RETURN v_from;
  END IF;
  UPDATE alert SET area_id = p_area, area_source = 'OPERATOR' WHERE id = p_alert;
  INSERT INTO alert_event (alert_id, tenant_id, actor_type, actor_id, kind, payload)
  VALUES (p_alert, v_tenant, 'OPERATOR', p_actor, 'AREA_CHANGED',
          jsonb_build_object('from', v_from, 'to', p_area, 'reason', left(coalesce(p_reason, ''), 300), 'by', 'OPERATOR'));
  INSERT INTO audit_log (tenant_id, actor_id, kind, target_id, payload)
  VALUES (v_tenant, p_actor, 'ALERT_AREA_CHANGED', p_alert,
          jsonb_build_object('from', v_from, 'to', p_area, 'reason', left(coalesce(p_reason, ''), 300)));
  RETURN v_from;
END $$;
REVOKE ALL ON FUNCTION reassign_alert_area(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reassign_alert_area(uuid, uuid, uuid, text) TO guardia_app;

-- ---------------------------------------------------------------------------------------- qué ve cada operador
-- Ve todo: el administrador, el municipio en modo compartido o un municipio que aún no define áreas.
CREATE FUNCTION operator_sees_all() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_role() = 'operator' AND (
    EXISTS (SELECT 1 FROM operator o WHERE o.id = app_operator_id() AND o.tenant_id = app_tenant_id() AND o.role = 'ADMIN')
    OR EXISTS (SELECT 1 FROM tenant_area_mode m WHERE m.tenant_id = app_tenant_id() AND m.shared)
    OR NOT EXISTS (SELECT 1 FROM area a WHERE a.tenant_id = app_tenant_id() AND a.active)) $$;

CREATE FUNCTION operator_area_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(array_agg(oa.area_id), '{}') FROM operator_area oa
    JOIN area a ON a.id = oa.area_id AND a.active
   WHERE app_role() = 'operator' AND oa.operator_id = app_operator_id() AND oa.tenant_id = app_tenant_id() $$;

CREATE FUNCTION operator_in_sos_area() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_role() = 'operator' AND EXISTS (
    SELECT 1 FROM operator_area oa JOIN area a ON a.id = oa.area_id AND a.active AND a.receives_sos
     WHERE oa.operator_id = app_operator_id() AND oa.tenant_id = app_tenant_id()) $$;

REVOKE ALL ON FUNCTION operator_sees_all(), operator_area_ids(), operator_in_sos_area() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_sees_all(), operator_area_ids(), operator_in_sos_area() TO guardia_app;

-- RESTRICTIVE: se suma (AND) a las políticas que ya existen. Fuera del contexto operador no cambia nada. Las
-- funciones van en subconsultas escalares para que se evalúen una vez por consulta, no por fila.
CREATE POLICY alert_operator_area ON alert AS RESTRICTIVE FOR SELECT TO guardia_app
  USING (app_role() IS DISTINCT FROM 'operator' OR (SELECT operator_sees_all()) OR area_id IS NULL
         OR area_id = ANY ((SELECT operator_area_ids())::uuid[])
         OR (security_relevant AND (SELECT operator_in_sos_area())));
CREATE POLICY alert_operator_area_update ON alert AS RESTRICTIVE FOR UPDATE TO guardia_app
  USING (app_role() IS DISTINCT FROM 'operator' OR (SELECT operator_sees_all()) OR area_id IS NULL
         OR area_id = ANY ((SELECT operator_area_ids())::uuid[])
         OR (security_relevant AND (SELECT operator_in_sos_area())))
  WITH CHECK (app_role() IS DISTINCT FROM 'operator' OR (SELECT operator_sees_all()) OR area_id IS NULL
         OR area_id = ANY ((SELECT operator_area_ids())::uuid[])
         OR (security_relevant AND (SELECT operator_in_sos_area())));

-- Lo que cuelga del aviso sigue su visibilidad (la subconsulta pasa por la política de alert).
CREATE POLICY alert_event_operator_area ON alert_event AS RESTRICTIVE FOR SELECT TO guardia_app
  USING (app_role() IS DISTINCT FROM 'operator' OR EXISTS (SELECT 1 FROM alert a WHERE a.id = alert_event.alert_id));
CREATE POLICY media_operator_area ON media AS RESTRICTIVE FOR SELECT TO guardia_app
  USING (app_role() IS DISTINCT FROM 'operator' OR EXISTS (SELECT 1 FROM alert a WHERE a.id = media.alert_id));
CREATE POLICY dispatch_operator_area ON dispatch AS RESTRICTIVE FOR SELECT TO guardia_app
  USING (app_role() IS DISTINCT FROM 'operator' OR EXISTS (SELECT 1 FROM alert a WHERE a.id = dispatch.alert_id));
CREATE POLICY triage_label_operator_area ON triage_label AS RESTRICTIVE FOR SELECT TO guardia_app
  USING (app_role() IS DISTINCT FROM 'operator' OR EXISTS (SELECT 1 FROM alert a WHERE a.id = triage_label.alert_id));

-- ---------------------------------------------------------------------------------------- traspaso entre municipios
-- Igual que 0006, más: la alerta toma el área que le corresponde en el municipio de destino.
CREATE OR REPLACE FUNCTION transfer_alert(p_alert uuid, p_to uuid, p_actor uuid, p_reason text, p_auto boolean)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role   text := current_setting('app.role', true);
  v_from   uuid;
  v_status alert_status;
BEGIN
  IF v_role IS DISTINCT FROM 'system' AND v_role IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'transfer_alert: contexto no permitido' USING ERRCODE = '42501';
  END IF;

  SELECT tenant_id, status INTO v_from, v_status FROM alert WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_alert: alerta no encontrada' USING ERRCODE = 'P0002';
  END IF;
  -- Desde la central solo se traspasa lo propio (y el operador no ve alertas de otros municipios).
  IF v_role = 'operator' AND current_setting('app.tenant_id', true) IS DISTINCT FROM v_from::text THEN
    RAISE EXCEPTION 'transfer_alert: alerta no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_from IS NULL OR v_from = p_to OR NOT EXISTS (SELECT 1 FROM tenant WHERE id = p_to AND active) THEN
    RAISE EXCEPTION 'transfer_alert: municipio de destino inválido' USING ERRCODE = '22023';
  END IF;
  IF v_status NOT IN ('PENDING', 'ACKNOWLEDGED') OR EXISTS (SELECT 1 FROM dispatch WHERE alert_id = p_alert) THEN
    RAISE EXCEPTION 'transfer_alert: solo se traspasan alertas abiertas sin despacho' USING ERRCODE = '55000';
  END IF;
  IF p_auto AND v_status <> 'PENDING' THEN
    RAISE EXCEPTION 'transfer_alert: la central ya tomó esta alerta' USING ERRCODE = '55000';
  END IF;

  -- La alerta llega al otro municipio como nueva: sin acuse, fuera del grupo de origen y en el área de destino.
  UPDATE alert
     SET tenant_id = p_to, status = 'PENDING', acknowledged_by = NULL, incident_id = NULL,
         area_id = area_for(p_to, type, category, subcategory),
         area_source = CASE WHEN area_for(p_to, type, category, subcategory) IS NULL THEN NULL ELSE 'AUTO'::area_source END
   WHERE id = p_alert;
  UPDATE media SET tenant_id = p_to WHERE alert_id = p_alert;
  UPDATE alert_event SET tenant_id = p_to WHERE alert_id = p_alert;
  UPDATE triage_label SET tenant_id = p_to WHERE alert_id = p_alert;
  INSERT INTO alert_event (alert_id, tenant_id, actor_type, actor_id, kind, payload)
  VALUES (
    p_alert, p_to,
    CASE WHEN p_auto THEN 'AI'::actor_type ELSE 'OPERATOR'::actor_type END,
    CASE WHEN p_auto THEN NULL ELSE p_actor END,
    'TRANSFERRED',
    jsonb_build_object('from', v_from, 'to', p_to, 'reason', left(coalesce(p_reason, ''), 300), 'auto', p_auto)
  );
  -- Bitácora del municipio de origen: queda constancia aunque ya no vea la alerta.
  INSERT INTO audit_log (tenant_id, actor_id, kind, target_id, payload)
  VALUES (
    v_from, CASE WHEN p_auto THEN NULL ELSE p_actor END, 'ALERT_TRANSFERRED', p_alert,
    jsonb_build_object('to', p_to, 'reason', left(coalesce(p_reason, ''), 300), 'auto', p_auto)
  );
  RETURN v_from;
END
$$;
