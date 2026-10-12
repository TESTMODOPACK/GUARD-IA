-- Derecho de supresión (Ley 21.719, DELETE /v1/me): anonimiza al vecino sin perder el registro
-- municipal de casos atendidos. Decisión (12-10-2026): anonimizar, no borrar en cascada.
--
-- Se borra lo que identifica a la persona: teléfono (se reemplaza por uno ficticio, porque la columna
-- es NOT NULL y UNIQUE), nombre, consentimiento, dispositivos, sesiones, OTP pendiente, lo que escribió,
-- la transcripción y el resumen de la IA, y el audio y las fotos (se marcan vencidos y la API los purga
-- al confirmar). La ubicación de sus alertas queda redondeada a 3 decimales (~100 m).
-- Se conserva: tipo, categoría, prioridad, estados, despachos y eventos (registro de la central).
--
-- SECURITY DEFINER: corre como dueño (salta los privilegios por columna y RLS que impiden a guardia_app
-- tocar phone o lat/lng), pero SOLO para el vecino del contexto actual: exige app.role = 'citizen' y
-- app.citizen_id = p_citizen. Ningún otro contexto (operador, system) puede usarla.

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
