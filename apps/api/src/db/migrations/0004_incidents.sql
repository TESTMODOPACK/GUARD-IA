-- Incidentes (12-10-2026): agrupar alertas que hablan de la misma situación para no saturar la
-- central con avisos repetidos, y medir su importancia.
--
-- Un incidente reúne alertas del mismo municipio y tipo, cerca entre sí y en una ventana de tiempo
-- (reglas en packages/shared/src/schemas/incident.ts: INCIDENT_RULES). Un reporte urbano repetido
-- por varios vecinos o que reaparece después de resuelto sube de importancia. Ninguna alerta se
-- borra ni se oculta del registro: el incidente solo las agrupa. El agrupamiento corre después del
-- commit del SOS y nunca lo bloquea (si falla, el worker lo reintenta).

CREATE TABLE incident (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  type               alert_type NOT NULL,
  category           alert_category,
  -- Centro del grupo (promedio de sus reportes); la geocerca de búsqueda se mide desde aquí.
  lat                double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  location           geography(Point, 4326)
                     GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
  alert_count        integer NOT NULL DEFAULT 1 CHECK (alert_count >= 0),
  citizen_count      integer NOT NULL DEFAULT 1 CHECK (citizen_count >= 0),
  -- Incidentes ya cerrados de la misma categoría en el mismo lugar (últimos 90 días) al abrirse este.
  recurrence_count   integer NOT NULL DEFAULT 0 CHECK (recurrence_count >= 0),
  importance         smallint NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 100),
  importance_reasons text[] NOT NULL DEFAULT '{}',
  first_alert_at     timestamptz NOT NULL,
  last_alert_at      timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_location_gix ON incident USING GIST (location);
CREATE INDEX incident_tenant_type_last_idx ON incident (tenant_id, type, last_alert_at DESC);

ALTER TABLE alert ADD COLUMN incident_id uuid REFERENCES incident(id);
CREATE INDEX alert_incident_idx ON alert (incident_id, created_at) WHERE incident_id IS NOT NULL;
-- La app puede asignar o cambiar el incidente de una alerta (agrupar, "separar del grupo").
GRANT UPDATE (incident_id) ON alert TO guardia_app;

REVOKE DELETE ON incident FROM guardia_app;
REVOKE UPDATE ON incident FROM guardia_app;
GRANT UPDATE (category, lat, lng, alert_count, citizen_count, recurrence_count, importance,
  importance_reasons, first_alert_at, last_alert_at, updated_at) ON incident TO guardia_app;

-- El vecino no ve incidentes (solo sus alertas); la central, los de su municipio.
ALTER TABLE incident ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_system ON incident FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY incident_operator ON incident FOR ALL TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
