-- Comunas en trozos (13-10-2026). Con la DPA 2023 de SUBDERE, las comunas australes tienen cientos de
-- miles de vértices (Natales 585 mil, Cabo de Hornos 232 mil): ST_Covers sobre el polígono entero tardaba
-- ~130 ms dentro del trigger del SOS. Se guardan también partidas con ST_Subdivide (≤ 256 vértices por
-- trozo): el índice GIST descarta casi todo y la búsqueda queda bajo 1 ms en cualquier punto del país.
-- `comuna.boundary` sigue siendo el polígono completo (referencia); el ruteo usa `comuna_part`.
--
-- Ruteo nuevo (alert_route_tenant):
--   1. comuna del punto GPS por sus trozos; si cae en el mar o en una rendija entre comunas
--      simplificadas, la más cercana a menos de 50 m (muelles, costanera);
--   2. municipio enlazado a esa comuna (tenant.comuna_cut);
--   3. si no hay, municipio sin comuna por su propio polígono (municipios con límite propio, p. ej. demo).

CREATE TABLE comuna_part (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cut  integer NOT NULL REFERENCES comuna(cut) ON DELETE CASCADE,
  part geography(Geometry, 4326) NOT NULL
);
CREATE INDEX comuna_part_gix ON comuna_part USING GIST (part);
CREATE INDEX comuna_part_cut_idx ON comuna_part (cut);

REVOKE INSERT, UPDATE, DELETE ON comuna_part FROM guardia_app;
GRANT SELECT ON comuna_part TO guardia_app;

-- Comunas ya cargadas (load-comunas mantiene los trozos de aquí en adelante).
INSERT INTO comuna_part (cut, part)
SELECT c.cut, ST_Subdivide(c.boundary::geometry, 256)::geography FROM comuna c;

CREATE OR REPLACE FUNCTION alert_route_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
BEGIN
  -- Regla 3: el vecino nunca elige municipio ni comuna; lo que venga en el INSERT se descarta.
  NEW.tenant_id := NULL;
  NEW.comuna_cut := NULL;

  SELECT p.cut INTO NEW.comuna_cut FROM comuna_part p WHERE ST_Covers(p.part, v_point) LIMIT 1;
  IF NEW.comuna_cut IS NULL THEN
    SELECT p.cut INTO NEW.comuna_cut
      FROM comuna_part p
     WHERE ST_DWithin(p.part, v_point, 50)
     ORDER BY ST_Distance(p.part, v_point)
     LIMIT 1;
  END IF;

  IF NEW.comuna_cut IS NOT NULL THEN
    SELECT t.id INTO NEW.tenant_id FROM tenant t WHERE t.active AND t.comuna_cut = NEW.comuna_cut LIMIT 1;
  END IF;
  IF NEW.tenant_id IS NULL THEN
    SELECT t.id INTO NEW.tenant_id
      FROM tenant t
     WHERE t.active AND t.comuna_cut IS NULL AND ST_Covers(t.boundary, v_point)
     ORDER BY ST_Area(t.boundary) ASC   -- si dos polígonos se solapan gana el más chico
     LIMIT 1;
  END IF;

  IF NEW.tenant_id IS NULL THEN
    NEW.status := 'UNROUTED';
    NEW.ai_status := 'SKIPPED';
  END IF;
  RETURN NEW;
END $$;
