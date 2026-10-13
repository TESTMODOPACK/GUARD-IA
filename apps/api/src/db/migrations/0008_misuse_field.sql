-- Uso indebido y resultado en terreno (13-10-2026). Diseño en docs/plan-plataforma.md §5b y §5c.
--
-- 1. Resultado del despacho: lo que encontró la unidad (lo registra la central con lo que informa la
--    unidad por radio; después, la unidad desde su teléfono). "Era otra situación" deja la categoría
--    real en triage_label (la mejor etiqueta para medir al agente de clasificación).
-- 2. Faltas del vecino (citizen_strike): solo por aviso falso intencional, con la evidencia escrita por el
--    operador; vencen a los 90 días. La cuenta del vecino es una para todo el país: cualquier central que
--    reciba una alerta suya ve sus faltas vigentes, con el municipio que las puso. Un supervisor puede
--    anular una falta mal puesta (no se borra: queda anulada).
-- Los motivos de rechazo viven en el evento REJECTED (shared REJECT_REASONS), no en un enum de Postgres.

ALTER TYPE alert_event_kind ADD VALUE IF NOT EXISTS 'FIELD_REPORT';

CREATE TYPE dispatch_outcome AS ENUM (
  'RESOLVED_ON_SITE', 'REFERRED', 'NEEDS_SUPPORT', 'NOT_FOUND', 'DIFFERENT_SITUATION', 'FALSE_ALARM_CONFIRMED'
);
ALTER TABLE dispatch
  ADD COLUMN outcome      dispatch_outcome,
  ADD COLUMN outcome_note text CHECK (char_length(outcome_note) <= 1000),
  ADD COLUMN outcome_at   timestamptz,
  ADD COLUMN outcome_by   uuid REFERENCES operator(id),
  ADD CONSTRAINT dispatch_outcome_complete CHECK ((outcome IS NULL) = (outcome_at IS NULL));
GRANT UPDATE (outcome, outcome_note, outcome_at, outcome_by) ON dispatch TO guardia_app;

-- Lo que vio la unidad cuando no era lo reportado.
ALTER TABLE triage_label
  ADD COLUMN field_category    alert_category,
  ADD COLUMN field_subcategory text CHECK (field_subcategory ~ '^[A-Z][A-Z_]{1,39}$'),
  ADD CONSTRAINT triage_label_field_sub CHECK (field_subcategory IS NULL OR field_category IS NOT NULL);
GRANT UPDATE (field_category, field_subcategory) ON triage_label TO guardia_app;

CREATE TABLE citizen_strike (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id   uuid NOT NULL REFERENCES citizen(id),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  -- Una falta por alerta: rechazar dos veces la misma alerta no suma.
  alert_id     uuid NOT NULL UNIQUE REFERENCES alert(id) ON DELETE CASCADE,
  -- Evidencia escrita por el operador (qué se escuchó, qué comprobó la unidad).
  note         text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 1000),
  decided_by   uuid NOT NULL REFERENCES operator(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  annulled_at  timestamptz,
  annulled_by  uuid REFERENCES operator(id),
  annul_reason text CHECK (char_length(annul_reason) <= 500),
  CHECK (expires_at > created_at),
  CHECK ((annulled_at IS NULL) = (annulled_by IS NULL))
);
-- "Faltas vigentes de este vecino" se consulta en cada ficha.
CREATE INDEX citizen_strike_citizen_idx ON citizen_strike (citizen_id, expires_at DESC);
CREATE INDEX citizen_strike_tenant_idx ON citizen_strike (tenant_id, created_at DESC);

REVOKE DELETE ON citizen_strike FROM guardia_app;
REVOKE UPDATE ON citizen_strike FROM guardia_app;
GRANT UPDATE (annulled_at, annulled_by, annul_reason) ON citizen_strike TO guardia_app;

ALTER TABLE citizen_strike ENABLE ROW LEVEL SECURITY;
CREATE POLICY citizen_strike_system ON citizen_strike FOR ALL TO guardia_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
-- La central ve las faltas de un vecino que tiene alertas en su municipio (las de todo el país: la cuenta
-- es una sola), pero solo pone o anula faltas propias.
CREATE POLICY citizen_strike_operator_read ON citizen_strike FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.citizen_id = citizen_strike.citizen_id AND a.tenant_id = app_tenant_id()));
CREATE POLICY citizen_strike_operator_insert ON citizen_strike FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
CREATE POLICY citizen_strike_operator_update ON citizen_strike FOR UPDATE TO guardia_app
  USING (app_role() = 'operator' AND tenant_id = app_tenant_id())
  WITH CHECK (app_role() = 'operator' AND tenant_id = app_tenant_id());
-- El vecino ve las suyas (Mis datos, aviso en la app).
CREATE POLICY citizen_strike_citizen ON citizen_strike FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id());
