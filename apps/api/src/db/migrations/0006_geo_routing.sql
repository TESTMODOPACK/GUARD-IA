-- Georreferencia y redirección entre municipios (13-10-2026).
--
-- 1. Comunas de Chile como referencia nacional (346, código único territorial CUT como PK entera). Se
--    cargan con `pnpm --filter @guardia/api load-comunas --geojson comunas.geojson` (datos públicos).
--    Sirven para saber en qué comuna está el vecino aunque su municipio no use Guard-IA, y para
--    reconocer la comuna que nombra (triage.location.comuna).
-- 2. Cada alerta guarda la comuna de su punto GPS (alert.comuna_cut), la fija el trigger de ruteo.
-- 3. El trigger de ruteo usa ST_Covers sobre geography, que sí usa el índice GIST de tenant.boundary
--    (ST_Contains con ::geometry no lo usaba: hallazgo A3 de docs/revision-base-de-datos.md).
-- 4. transfer_alert(): única vía para cambiar el municipio de una alerta (regla 3: tenant_id sigue
--    sin privilegio UPDATE para la app). La usa el agente (traspaso automático, contexto system) y la
--    central (traspaso manual, solo desde el municipio dueño). Solo alertas abiertas sin despacho;
--    el historial viaja con la alerta y queda un evento TRANSFERRED con el motivo.

ALTER TYPE alert_event_kind ADD VALUE IF NOT EXISTS 'TRANSFERRED';
ALTER TYPE audit_kind ADD VALUE IF NOT EXISTS 'ALERT_TRANSFERRED';

CREATE TABLE comuna (
  cut         integer PRIMARY KEY CHECK (cut BETWEEN 1000 AND 99999),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  -- Minúsculas, sin tildes ni "comuna de": para reconocer la comuna que nombra el vecino.
  name_key    text NOT NULL CHECK (name_key ~ '^[a-z0-9 ]{2,80}$'),
  region_cut  smallint NOT NULL CHECK (region_cut BETWEEN 1 AND 16),
  region_name text NOT NULL CHECK (char_length(region_name) BETWEEN 2 AND 80),
  boundary    geography(MultiPolygon, 4326) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comuna_boundary_gix ON comuna USING GIST (boundary);
CREATE INDEX comuna_name_key_idx ON comuna (name_key);

-- Referencia nacional: la app solo la lee (la carga el script con el usuario dueño). Sin RLS a
-- propósito: no tiene datos de nadie y todos los contextos la necesitan.
REVOKE INSERT, UPDATE, DELETE ON comuna FROM guardia_app;
GRANT SELECT ON comuna TO guardia_app;

-- Un municipio de Guard-IA corresponde a una comuna (opcional: el municipio demo no tiene).
ALTER TABLE tenant ADD COLUMN comuna_cut integer REFERENCES comuna(cut);
CREATE UNIQUE INDEX tenant_comuna_uidx ON tenant (comuna_cut) WHERE comuna_cut IS NOT NULL AND active;

-- Comuna del punto GPS. Inmutable para la app, como lat/lng (sin GRANT UPDATE).
ALTER TABLE alert ADD COLUMN comuna_cut integer REFERENCES comuna(cut);

CREATE OR REPLACE FUNCTION alert_route_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
BEGIN
  SELECT t.id INTO NEW.tenant_id
  FROM tenant t
  WHERE t.active AND ST_Covers(t.boundary, v_point)
  ORDER BY ST_Area(t.boundary) ASC   -- si dos polígonos se solapan gana el más chico
  LIMIT 1;

  SELECT c.cut INTO NEW.comuna_cut FROM comuna c WHERE ST_Covers(c.boundary, v_point) LIMIT 1;

  IF NEW.tenant_id IS NULL THEN
    NEW.status := 'UNROUTED';
    NEW.ai_status := 'SKIPPED';
  END IF;
  RETURN NEW;
END $$;

-- Devuelve el municipio de origen. Errores con SQLSTATE propio para que la API responda claro:
--   42501 sin permiso · P0002 no existe · 22023 destino inválido · 55000 la alerta ya no se puede mover.
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

  -- La alerta llega al otro municipio como nueva: sin acuse, fuera del grupo de origen.
  UPDATE alert SET tenant_id = p_to, status = 'PENDING', acknowledged_by = NULL, incident_id = NULL WHERE id = p_alert;
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

REVOKE ALL ON FUNCTION transfer_alert(uuid, uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transfer_alert(uuid, uuid, uuid, text, boolean) TO guardia_app;
