# Informe de revisión del esquema PostgreSQL 16 + PostGIS de Guard-IA

Revisé las migraciones `0001` a `0004`, el espejo Drizzle y el código que consulta las tablas. También consulté la base real `guardia` (PostgreSQL 16.15, PostGIS 3.4.2). No modifiqué ningún archivo del proyecto. Todo el SQL que propongo está sin ejecutar, porque la base es de solo lectura para esta revisión. Hay que probarlo en una copia con `pnpm --filter @guardia/api test:db`.

## 0. Cómo verifiqué

- **Base real y migraciones coinciden.** `schema_migrations` tiene las 4 migraciones y los índices, FKs, políticas y columnas leídos de la base son los del SQL.
- **EXPLAIN bajo el rol de la app.** Usé `SET ROLE guardia_app` más `set_config('app.role', ...)`, sin ANALYZE y con `enable_seqscan=off`. La base de desarrollo tiene 38 alertas, así que esto no mide tiempos. Mide qué índices el planificador puede usar, y eso no depende del volumen.
- **Dos EXPLAIN sustituidos.** Un control del entorno bloqueó dos `EXPLAIN` por contener las palabras UPDATE y DELETE. Los repetí como `SELECT` con la misma condición de lectura.
- **Fuera de alcance.** No comparé los enums de Postgres con `shared/enums.ts` (el CLAUDE.md pide que coincidan). No medí tiempos con volumen real.

Resumen de lo encontrado:

- **Crítico (3):**
  - 2 llaves primarias de tipo texto: `otp_code.phone` y `schema_migrations.name`.
  - Las políticas RLS impiden usar los índices por municipio en la cola, el panel y las bitácoras.
- **Alto (6):** privilegios de la app, `tenant` sin RLS, el trigger de ruteo, una fuga de coordenadas tras la supresión, tablas sin purga y el pool de conexiones en picos.
- **Medio (8) y Bajo (5).**
- **Lo más urgente en escala** no es el número de filas, que es manejable. Son los planes de consulta bajo RLS y las tablas que crecen sin purga.

---

## 1. Hallazgos

### CRÍTICO

#### C1. `otp_code.phone` es llave primaria de tipo texto
- **Evidencia:** `0001_init.sql:207-213` declara `phone text PRIMARY KEY`. En la base, `pg_constraint` da `otp_code | phone | text`. El espejo está en `schema.ts:205-206`.
- **Agravantes:** el teléfono no tiene el CHECK de formato que sí tiene `citizen.phone`. Tampoco hay índice sobre `expires_at` para purgar (C3 de la sección 3, A5 abajo).
- **SQL (0009):**
```sql
ALTER TABLE otp_code ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE otp_code DROP CONSTRAINT otp_code_pkey;
ALTER TABLE otp_code ADD CONSTRAINT otp_code_pkey PRIMARY KEY (id);
ALTER TABLE otp_code ADD CONSTRAINT otp_code_phone_key UNIQUE (phone);
ALTER TABLE otp_code ADD CONSTRAINT otp_code_phone_fmt
  CHECK (phone ~ '^\+[1-9][0-9]{6,14}$') NOT VALID;
ALTER TABLE otp_code VALIDATE CONSTRAINT otp_code_phone_fmt;
CREATE INDEX otp_code_expires_idx ON otp_code (expires_at);
```
- **Efecto en código:**
  - En `schema.ts`, `otpCode` pasa a tener `id: uuid('id').primaryKey().defaultRandom()` y `phone: text('phone').notNull().unique()`.
  - `auth.service.ts:53` (`onConflictDoUpdate({ target: otpCode.phone ... })`) sigue funcionando sin cambios, porque `ON CONFLICT (phone)` infiere la restricción UNIQUE.
  - Las líneas 63, 76, 77 y 83 filtran por `phone` y siguen igual. El `DELETE ... WHERE phone = v_phone` de `erase_citizen` (`0002:53`) también.
  - Mejora menor: el `set` del upsert debería incluir `createdAt: new Date()`. Hoy `created_at` queda con la fecha del primer código.

#### C2. `schema_migrations.name` es llave primaria de tipo texto
- **Evidencia:** la crea `apps/api/src/db/migrator.ts:24-27` (`name text PRIMARY KEY`), no una migración. En la base, `schema_migrations | name | text`. Es la única otra PK de texto.
- **SQL (0009, idempotente):**
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='id') THEN
    ALTER TABLE schema_migrations ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE schema_migrations DROP CONSTRAINT schema_migrations_pkey;
    ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);
    ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_name_key UNIQUE (name);
  END IF;
END $$;
```
- **Efecto en código:**
  - En `migrator.ts`, cambiar el `CREATE TABLE IF NOT EXISTS` inicial a `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL UNIQUE, applied_at timestamptz NOT NULL DEFAULT now()`, para que las bases nuevas nazcan correctas.
  - El `INSERT INTO schema_migrations (name)` y el `SELECT name` siguen válidos en ambas formas.
  - `spatial_ref_sys` (PostGIS) tiene PK `srid integer`, que cumple el criterio.

#### C3. Las políticas RLS impiden usar los índices por municipio (cola, panel, bitácoras, outbox)
Este es el hallazgo de mayor impacto a escala.

**Causa, con tres elementos que se combinan:**
1. Cada tabla tiene hasta tres políticas permisivas: `system`, `operator` y `citizen`. Postgres las une con OR. El filtro resultante es `app_role()='system' OR (app_role()='operator' AND tenant_id = app_tenant_id()) OR (... citizen ...)`. Ese OR contiene un brazo sin columnas, así que no puede ser condición de índice. Queda como `Filter` evaluado fila por fila.
2. Las consultas de operador no llevan `tenant_id` explícito (`alert-read.service.ts:88-117`, todo `stats.service.ts`, shifts, contactos). Dependen solo de la RLS.
3. Los enums no son "leakproof". En `pg_proc`, `enum_eq` tiene `proleakproof = f`. Lo mismo `geography_overlaps` y `st_dwithin`. En cambio `uuid_eq`, `texteq`, `timestamptz_*`, `float8*` e `int4eq` sí lo son. Bajo RLS, un filtro de usuario no leakproof no puede ser condición de índice.

**Evidencia, EXPLAIN como `guardia_app` en contexto operador:**
- **Cola de la central** (la consulta de `alert-read.service.ts`): `Seq Scan on alert` con `Sort` encima y el OR completo en `Filter`. Ordena y filtra la tabla entera, con todos los municipios.
- **Panel** (`count ... WHERE created_at >= ...`): `Bitmap Index Scan on alert_citizen_created_idx` con `created_at` como columna no inicial. Es un barrido completo del índice.
- **Bitácora de eventos:** `Bitmap Index Scan on alert_event_alert_idx` con `created_at` como columna no inicial, más un `SubPlan` de la rama ciudadano.
- **Bitácora del sistema** (`audit_log ORDER BY created_at DESC LIMIT 51`): `Index Only Scan` más un `Sort` completo. El índice `(tenant_id, created_at DESC, id DESC)` no sirve para ordenar sin `tenant_id` fijo.
- **Con `tenant_id` explícito:** `alert WHERE tenant_id = X AND status = ANY(...)` usa `Recheck Cond: (tenant_id = ...)`, pero `status` queda como `Filter`. El índice `alert_tenant_status_created_idx` está aprovechado solo a medias (la parte `status` y `created_at` no es condición de índice).
  - `idx_scan` de ese índice en la base es 0.
- **Incidentes:** con `tenant_id` explícito, `incident_tenant_type_last_idx` recibe `tenant_id` y `last_alert_at` como condición. `type` (enum) y `ST_DWithin` quedan en `Filter`, y la columna `type` en medio hace que el rango de tiempo recorra todo el tenant.
  - El índice GiST `incident_location_gix` nunca se usa: `idx_scan` es 0 y `ST_DWithin` no es leakproof.
- **Outbox de la IA** (`ai-outbox.cron.ts`, cada minuto): `Bitmap Heap Scan` sobre `alert_tenant_updated_idx` con condición `tenant_id IS NOT NULL`, o sea el índice completo. No hay índice por `ai_status`.
- **Casos que sí funcionan:**
  - Los predicados de índices parciales sobreviven a la RLS. `dispatch_unit_open_uidx`, cuyo predicado es un enum, se usa bajo `guardia_app` (EXPLAIN B).
  - `refresh_token`, `otp_code` (políticas solo `system`) y `media_retention_idx` funcionan bien.
- **`app_tenant_id()` es STABLE, no IMMUTABLE** (`0001:39-40`), y está bien: depende de un GUC. Cuando va sola como condición, el planificador la usa como condición de índice. Se vio en el `SubPlan`: `Index Cond: (citizen_id = (NULLIF(current_setting('app.citizen_id'...))::uuid)`. El problema es el OR, no la función.

**Corrección, nivel 1 (sin rediseñar la RLS).** Es necesaria.
1. Agregar `tenant_id = $tenant` explícito en toda consulta de operador. `uuid_eq` es leakproof, así que se vuelve condición de índice.
2. Crear los índices parciales y compuestos, con `tenant_id` primero.
3. No depender de `status` ni `type` como columnas de índice. Usarlos como predicado de índice parcial o dejarlos de filtro.

```sql
-- 0009
ALTER TABLE alert ADD COLUMN priority_rank smallint GENERATED ALWAYS AS (
  CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 1 END) STORED;
-- enum_eq es IMMUTABLE (verificado), la columna generada es válida. ADD COLUMN STORED reescribe la tabla:
-- hacerlo ahora, mientras es chica.

-- cola de la central: solo alertas abiertas, ordenadas como la UI
CREATE INDEX alert_open_queue_idx ON alert (tenant_id, priority_rank, created_at, id)
  WHERE status IN ('PENDING','ACKNOWLEDGED','DISPATCHED');
-- panel y bitácoras por rango de fechas
CREATE INDEX alert_tenant_created_idx ON alert (tenant_id, created_at DESC);
-- outbox de IA: el índice casi siempre queda vacío
CREATE INDEX alert_ai_queued_idx ON alert (created_at)
  WHERE ai_status = 'QUEUED' AND tenant_id IS NOT NULL;
DROP INDEX alert_tenant_status_created_idx;   -- el status del enum no es condición de índice bajo RLS

-- incidentes: la ventana de tiempo debe ser contigua dentro del tenant
CREATE INDEX incident_tenant_last_idx ON incident (tenant_id, last_alert_at DESC);
DROP INDEX incident_tenant_type_last_idx;
```
- **Efecto en código:**
  - `alert-read.service.ts`: agregar `tenantId` a `ListFilters`, agregar `eq(alert.tenantId, f.tenantId)` al `where`, y ordenar y comparar el cursor por `alert.priorityRank` en lugar del `CASE`.
  - `ops.service.ts:50-58`: pasar `op.tenantId`.
  - `stats.service.ts`: agregar `AND tenant_id = ${op.tenantId}::uuid` en cada consulta cruda sobre `alert`, `alert_event`, `unit`, `audit_log` y `operator`.
  - Servicios de `shifts`, `contacts`, `units` y `operators`: `eq(<tabla>.tenantId, op.tenantId)`.
  - Añadir a `test:db` una prueba de plan: con 100.000 filas sintéticas, la cola de la central bajo `guardia_app` no debe usar `Seq Scan`.
  - `schema.ts`: declarar `priorityRank` con `generatedAlwaysAs`.

**Corrección, nivel 2 (opcional, estructural).** Hoy hay un solo rol de base y el contexto viaja por GUC. Se puede cambiar a un rol de base por contexto:
- Crear `guardia_operator`, `guardia_citizen` y `guardia_system` como `NOLOGIN`. Heredan los privilegios de tabla de un rol base. `guardia_app` (NOINHERIT) es miembro de los tres.
- En `db.service.ts`, `withContext` agrega `SET LOCAL ROLE guardia_operator` (o el que corresponda) a su `set_config`.
- Las políticas pasan a ser `TO guardia_operator USING (tenant_id = app_tenant_id())`. Ya no se combinan en OR, el `tenant_id` queda como condición de índice sin que la consulta lo repita, y cada contexto puede tener privilegios mínimos distintos.
- Costo: reescribir unas 40 políticas y re-emitir los GRANT sobre el rol base. Lo dejaría como segunda fase y validaría con `test:db`. El nivel 1 es suficiente para empezar.
- Nota: las políticas llaman `app_role()` sin envolver en `(SELECT ...)`. Se ve en el plan: `NULLIF(current_setting(...))` evaluado por fila. Es barato, pero con el rol por contexto desaparece.

---

### ALTO

#### A1. Privilegios excesivos de `guardia_app`
- **Evidencia, `information_schema.role_table_grants` en la base:**
  - `schema_migrations`, `spatial_ref_sys`, `geometry_columns` y `geography_columns` tienen `DELETE, INSERT, SELECT, UPDATE` para `guardia_app`. Se otorgaron con `GRANT ... ON ALL TABLES` (`0001:267`). Ninguna tiene RLS. Una app comprometida podría reescribir el historial de migraciones o la tabla de SRID.
  - `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE` (`0001:271`) hace que toda tabla futura nazca con permisos totales. Las particiones del punto S3 también.
  - `refresh_token` y `otp_code`: `UPDATE` sobre todas las columnas (`token_hash`, `subject_id`, `expires_at`, `phone`...). El código solo necesita `revoked_at`/`replaced_by` y `code_hash`/`attempts`/`expires_at`.
  - `unit`: `UPDATE` sobre `id`, `tenant_id` y `code`. El código (`units.service.ts:64-72`, `ops.service.ts`) solo cambia `status`, `kind`, `last_lat`, `last_lng`, `last_seen_at`.
  - `device`: `UPDATE` sobre `id`.
  - `DELETE` sin uso en `citizen`, `operator`, `dispatch`, `media` y `unit`. La búsqueda de `.delete(` en la API solo encuentra `shift` y `otpCode`. Los vecinos se anonimizan y los operadores se desactivan.
- **SQL (0009):**
```sql
REVOKE ALL ON schema_migrations FROM guardia_app;
REVOKE INSERT, UPDATE, DELETE ON spatial_ref_sys, geometry_columns, geography_columns FROM guardia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM guardia_app;
-- desde ahora, cada migración declara sus GRANT explícitos

REVOKE UPDATE ON refresh_token FROM guardia_app;
GRANT  UPDATE (revoked_at, replaced_by) ON refresh_token TO guardia_app;
REVOKE UPDATE ON otp_code FROM guardia_app;
GRANT  UPDATE (code_hash, expires_at, attempts, created_at) ON otp_code TO guardia_app;
REVOKE UPDATE ON unit FROM guardia_app;
GRANT  UPDATE (kind, status, last_lat, last_lng, last_seen_at) ON unit TO guardia_app;
REVOKE UPDATE ON device FROM guardia_app;
GRANT  UPDATE (citizen_id, platform, app_version, last_seen_at) ON device TO guardia_app;
REVOKE DELETE ON citizen, operator, dispatch, media, unit FROM guardia_app;
```
- **Efecto en código:** ninguno si se respetan los `set` actuales. `onConflictDoUpdate` de `device` usa `citizenId, platform, appVersion, lastSeenAt`, que quedan permitidos. Las migraciones futuras deben incluir sus `GRANT`.

#### A2. `tenant` no tiene RLS: cualquier contexto lee todos los municipios
- **Evidencia:** `0001:367-368` lo dice (`tenant no tiene RLS; guardia_app solo tiene SELECT`). La base lo confirma: `relrowsecurity = f`. Un operador o un vecino puede leer `settings` y la geocerca `boundary` de cientos de municipios. La regla 3 del CLAUDE.md dice que la RLS es la frontera.
- **Quién lee `tenant` hoy:** `alerts.service.ts:242` (vecino), `alert-read.service.ts:164`, `stats.service.ts:46` y `operators.service.ts:180` (operador), `auth.service.ts:173` y `ai.processor.ts:55` (sistema). Ninguno lee `boundary`, y el espejo Drizzle ni la declara.
- **SQL (0009):**
```sql
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_system   ON tenant FOR SELECT TO guardia_app USING (app_role() = 'system');
CREATE POLICY tenant_operator ON tenant FOR SELECT TO guardia_app
  USING (app_role() = 'operator' AND id = app_tenant_id());
CREATE POLICY tenant_citizen  ON tenant FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND EXISTS (
    SELECT 1 FROM alert a WHERE a.tenant_id = tenant.id AND a.citizen_id = app_citizen_id()));
-- la app no necesita la geocerca (el trigger de ruteo es SECURITY DEFINER y salta la RLS)
REVOKE SELECT ON tenant FROM guardia_app;
GRANT SELECT (id, name, slug, cut_code, timezone, audio_retention_days, settings, active, created_at)
  ON tenant TO guardia_app;
```
- **Efecto en código:** ninguno. La lectura del vecino ocurre en la misma transacción que insertó la alerta, así que el `EXISTS` la ve. Los controladores no deben hacer `SELECT *` sobre `tenant`.

#### A3. El trigger de ruteo hace Seq Scan de `tenant` en cada SOS
- **Evidencia:** `0001:239` usa `ST_Contains(t.boundary::geometry, v_point)`. El índice `tenant_boundary_gix` está sobre la columna `geography`, así que la conversión a `geometry` lo anula. EXPLAIN: `Seq Scan on tenant t, Filter: (active AND st_contains((boundary)::geometry, ...))`. Con `ST_Covers(boundary, punto::geography)` el índice sí se usa, pero eso cambia la semántica (bordes geodésicos y borde incluido). Hoy `tenant` tiene 1 fila con 5 vértices, así que no se nota.
- **Por qué importa:** el trigger corre dentro de la inserción del SOS (regla 1). Con cientos de municipios y límites de miles de vértices, cada SOS deserializa todas las geocercas.
- **SQL (0009):**
```sql
CREATE INDEX tenant_boundary_geom_gix ON tenant USING GIST ((boundary::geometry));
```
- **Efecto en código:** ninguno. Hay que validar con EXPLAIN en una copia que el planificador usa el índice funcional con `ST_Contains` (no pude crearlo en modo solo lectura). Como alternativa más robusta, una columna `boundary_geom geometry(MultiPolygon,4326) GENERATED ALWAYS AS (boundary::geometry) STORED` con su GiST.
- **Complemento:**
```sql
ALTER TABLE tenant ADD CONSTRAINT tenant_boundary_valid CHECK (ST_IsValid(boundary::geometry));
```
  `ST_IsValid` es IMMUTABLE. En el piloto, `demo` es válido.

#### A4. `erase_citizen` deja las coordenadas exactas en `incident`
- **Evidencia:** `0002:41-49` redondea `alert.lat/lng` a 3 decimales, pero no toca `incident`. Un incidente de una sola alerta copia las coordenadas de esa alerta (`incidents.service.ts:62-73`). En la base: 12 de 16 incidentes son de 1 alerta con latitud y longitud idénticas a la alerta. Tras suprimir al vecino, la ubicación exacta sigue en `incident.lat/lng` y en `incident.location` (generada). Contradice el comentario de la migración (ubicación a ~100 m) y la Ley 21.719.
- **SQL (0009): `CREATE OR REPLACE FUNCTION erase_citizen` con el cuerpo vigente (`0005_triage.sql`, que ya borra `ai_triage`) más este bloque, justo después del `UPDATE alert`:**
```sql
UPDATE incident i
   SET lat = round(i.lat::numeric, 3)::double precision,
       lng = round(i.lng::numeric, 3)::double precision
 WHERE i.id IN (SELECT incident_id FROM alert
                 WHERE citizen_id = p_citizen AND incident_id IS NOT NULL);
```
  La función es SECURITY DEFINER, así que salta los privilegios por columna de `incident`.
- **Efecto en código:** ninguno. `recompute` promedia después con valores ya redondeados.

#### A5. Tablas sin purga y una purga de media con tope diario
- **`refresh_token`:** no hay ningún `DELETE` en `apps/api/src/jobs` ni en `token.service.ts`. En la base: 75 filas, 28 revocadas, 5 vencidas. `EXPLAIN` de las vencidas: `Seq Scan` (no hay índice por `expires_at`). Cada rotación del refresh inserta una fila. El access token del vecino dura 15 min, el refresh 30 días (`env.ts:23-24`).
- **`otp_code`:** solo se borra al verificar con éxito o agotar intentos. Un número que pide código y no lo usa deja la fila indefinidamente. Una ráfaga de números aleatorios (SMS pumping) la engorda.
- **Media (`media.service.ts:107-129`):** `purgeExpired(limit = 500)` corre una vez al día (04:00), y borra las filas por soft delete (`deleted_at`), nunca físicamente. Con la hipótesis de ~4.200 archivos vencidos al día a escala nacional (ver sección 3, ítem 6), el atraso crece ~3.700 por día. El flujo de supresión (`privacy.service.ts:87`) también llama a `purgeExpired()` y depende de que su fila caiga dentro de esos 500, sin `ORDER BY`.
- **SQL (0009):** `otp_code_expires_idx` ya está en C1, más:
```sql
CREATE INDEX refresh_token_expires_idx ON refresh_token (expires_at);
```
  Se deja la restricción `DELETE` para `refresh_token` y `otp_code` (no están en la lista de A1).
- **Efecto en código:** un `MaintenanceCron` nuevo:
  - Cada 10 min: `DELETE FROM refresh_token WHERE id IN (SELECT id FROM refresh_token WHERE expires_at < now() - interval '1 day' ORDER BY expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED)`. Un token rotado debe permanecer hasta su vencimiento para detectar reutilización.
  - Lo mismo para `otp_code` con `expires_at < now() - interval '1 hour'`.
  - Cambiar la purga de media a `@Cron('*/5 * * * *')`, con `ORDER BY retention_until`, `FOR UPDATE SKIP LOCKED`, lote de 500 repetido hasta vaciar, `UPDATE` por lote en una sentencia y borrado en el storage en paralelo (chunks de 20).

#### A6. El advisory lock del agrupador puede dejar sin conexiones al pool
- **Evidencia:**
  - `incidents.service.ts:52` toma `pg_advisory_xact_lock(hashtextextended(tenant:type, 0))`. Serializa todo el agrupamiento de un municipio y tipo.
  - `alerts.service.ts:299-301` llama a `attach` con `withTimeout(..., 200)`. Ese `withTimeout` es un `Promise.race` que no cancela la transacción.
  - `DATABASE_POOL_MAX` por defecto es 10 (`env.ts:18`). Una transacción esperando el lock retiene su conexión hasta `lock_timeout` (5 s en el rol, `0001:264`).
- **Riesgo:** en un pico del mismo municipio (terremoto, evento masivo), hasta 10 transacciones esperando el lock ocupan todo el pool, y el `INSERT` del siguiente SOS espera conexión. Es el camino que la regla 1 protege.
- **Corrección:** al inicio de `attachInTx`, `SET LOCAL lock_timeout = '150ms'`, para que la espera se corte y la conexión se libere. Alternativa: `pg_try_advisory_xact_lock` y, si devuelve falso, `return null`. El worker de IA reagrupa después (`attach` es idempotente, `ai.processor.ts:225`).
- **Efecto en código:** solo `incidents.service.ts`. Sin SQL.

---

### MEDIO

#### M1. Referencias polimórficas sin FK
**`refresh_token.subject_id`** (`0001:219`): apunta a `citizen` u `operator` según `kind`. En la base no hay huérfanos hoy (0 de 75), pero nada lo garantiza.
```sql
ALTER TABLE refresh_token
  ADD COLUMN citizen_id  uuid REFERENCES citizen(id)  ON DELETE CASCADE,
  ADD COLUMN operator_id uuid REFERENCES operator(id) ON DELETE CASCADE;
UPDATE refresh_token SET citizen_id  = subject_id WHERE kind = 'CITIZEN';
UPDATE refresh_token SET operator_id = subject_id WHERE kind = 'OPERATOR';
ALTER TABLE refresh_token ADD CONSTRAINT refresh_token_subject_chk CHECK (
  (kind = 'CITIZEN'  AND citizen_id  IS NOT NULL AND operator_id IS NULL) OR
  (kind = 'OPERATOR' AND operator_id IS NOT NULL AND citizen_id  IS NULL));
DROP INDEX refresh_token_subject_idx;
ALTER TABLE refresh_token DROP COLUMN subject_id;
ALTER TABLE refresh_token ADD COLUMN subject_id uuid
  GENERATED ALWAYS AS (COALESCE(citizen_id, operator_id)) STORED;
CREATE INDEX refresh_token_subject_idx ON refresh_token (subject_id) WHERE revoked_at IS NULL;
```
- **Decisión de diseño:** no se indexan `citizen_id` ni `operator_id`. Los padres nunca se borran (A1 revoca el `DELETE`), y esta tabla es la que más crece. Tampoco se agrega FK en `replaced_by`: su `ON DELETE SET NULL` exigiría un índice más y encarecería la purga.
- **Efecto en código:** `token.service.ts:62-68` inserta `citizenId` u `operatorId` según el `kind`, en lugar de `subjectId`. Las lecturas de `row.subjectId` (líneas 101, 105, 121, 148) siguen igual. En `schema.ts`: `subjectId: uuid('subject_id').generatedAlwaysAs(sql\`COALESCE(citizen_id, operator_id)\`)`.
- **Sobre `erase_citizen`:** el `DELETE ... WHERE subject_id = p_citizen AND kind = 'CITIZEN'` de `0002:52` sigue válido.

**`alert_event.actor_id`:** guarda el id del vecino o del operador según `actor_type`. En la base: CITIZEN 39 con id, OPERATOR 68 con id, SYSTEM 40 y AI 37 sin id. Se resuelve al reconstruir la tabla en la migración 0010 (sección 3, S1) con `actor_operator_id` y `actor_citizen_id`, ambos con FK, y un CHECK que los liga a `actor_type`.

**`audit_log.target_id`:** apunta a operador, turno, unidad o contacto. Dejarlo sin FK es correcto: la bitácora debe sobrevivir al objeto (por ejemplo, `SHIFT_REMOVED` borra el turno). `audit_log.actor_id` ya tiene FK a `operator`.

#### M2. Claves foráneas sin índice
Resultado de cruzar las 24 FKs con `pg_index` en la base:

| FK | Índice | Acción |
|---|---|---|
| `dispatch.unit_id` | solo el parcial `dispatch_unit_open_uidx` | Crear índice. Evidencia: `SELECT ... WHERE unit_id = X` bajo `guardia_app` da `Seq Scan on dispatch` |
| `shift.operator_id` | solo el parcial `shift_open_uidx` | Crear índice |
| `operator.tenant_id` | ninguno | Crear índice (listados del municipio) |
| `media.tenant_id` | ninguno | Se dejará sin índice (se usa vía `alert_id`) |
| `dispatch.operator_id`, `alert.acknowledged_by`, `audit_log.actor_id`, `operator.created_by`, `shift.created_by`, `contact.created_by` | ninguno | Sin índice a propósito: `operator` no se borra (A1) y ninguna consulta los usa |

```sql
CREATE INDEX dispatch_unit_idx    ON dispatch (unit_id, created_at DESC);
CREATE INDEX shift_operator_idx   ON shift (operator_id, planned_start) WHERE planned_start IS NOT NULL;
CREATE INDEX operator_tenant_idx  ON operator (tenant_id, active, name);
CREATE INDEX shift_tenant_open_idx ON shift (tenant_id) WHERE started_at IS NOT NULL AND ended_at IS NULL;
```
Efecto en código: ninguno.

#### M3. Invariantes entre municipios sin garantía en la base
Los FK comprueban la existencia del padre, y esa comprobación salta la RLS. Hoy nada impide que:
- Un `dispatch` de un municipio apunte a una `unit`, `operator` o `alert` de otro.
- Un `shift` se asigne a un operador de otro municipio.
- Una `alert` apunte a un `incident` de otro municipio.
- `alert_event.tenant_id` y `media.tenant_id` (copias de `alert.tenant_id`) se desalineen.

Hoy los datos son consistentes: las siete comprobaciones cruzadas que corrí dan 0 diferencias. La garantía es solo de código.
```sql
ALTER TABLE operator ADD CONSTRAINT operator_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE unit     ADD CONSTRAINT unit_id_tenant_key     UNIQUE (id, tenant_id);
ALTER TABLE incident ADD CONSTRAINT incident_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE alert    ADD CONSTRAINT alert_id_tenant_key    UNIQUE (id, tenant_id);  -- índice extra en la tabla del SOS

ALTER TABLE dispatch
  ADD CONSTRAINT dispatch_alert_tenant_fk    FOREIGN KEY (alert_id, tenant_id)    REFERENCES alert (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT dispatch_unit_tenant_fk     FOREIGN KEY (unit_id, tenant_id)     REFERENCES unit (id, tenant_id),
  ADD CONSTRAINT dispatch_operator_tenant_fk FOREIGN KEY (operator_id, tenant_id) REFERENCES operator (id, tenant_id);
ALTER TABLE shift ADD CONSTRAINT shift_operator_tenant_fk FOREIGN KEY (operator_id, tenant_id) REFERENCES operator (id, tenant_id);
ALTER TABLE alert ADD CONSTRAINT alert_incident_tenant_fk FOREIGN KEY (incident_id, tenant_id) REFERENCES incident (id, tenant_id);

-- el tenant de un evento o archivo lo decide la alerta, no el código (mismo patrón que alert_route_tenant)
CREATE OR REPLACE FUNCTION tenant_from_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  SELECT a.tenant_id INTO NEW.tenant_id FROM alert a WHERE a.id = NEW.alert_id;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_event_tenant BEFORE INSERT ON alert_event FOR EACH ROW EXECUTE FUNCTION tenant_from_alert();
CREATE TRIGGER media_tenant       BEFORE INSERT ON media       FOR EACH ROW EXECUTE FUNCTION tenant_from_alert();
```
- Se conservan los FK simples existentes. Los compuestos usan MATCH SIMPLE y no se aplican si `tenant_id` es NULL (alertas UNROUTED), así que los simples cubren la existencia en ese caso.
- Evaluar si vale el índice `alert_id_tenant_key` en la tabla caliente. Es opcional: se puede omitir el FK compuesto desde `alert` hacia `incident` y mantener los demás.
- Efecto en código: ninguno. `events.record` y `media.store` siguen pasando `tenantId`; el trigger lo sobrescribe.

#### M4. Índices sin uso, redundantes o inútiles bajo RLS
- **`alert_location_gix`** (GiST sobre `alert.location`): ninguna consulta usa `alert.location` (la búsqueda de `grep` solo encuentra `incident.location`), y `idx_scan` es 0. En la tabla del SOS encarece cada inserción. Eliminar el índice. La columna generada también es candidata, pero es opcional.
  ```sql
  DROP INDEX alert_location_gix;
  ```
- **`incident_location_gix`:** `ST_DWithin` y `&&` de geography no son leakproof (`pg_proc`), así que bajo RLS el GiST no se puede usar nunca, con ningún diseño de política. `findOpenMatch` ya funciona con el rango de tiempo de `incident_tenant_last_idx` (ventana de minutos).
  - `closedNearby` mira 90 días y hace `ST_DWithin` fila por fila sobre todos los incidentes de ese periodo. Con un municipio grande puede ser costoso y ocurre dentro del advisory lock. Conviene medir con datos sintéticos (1 M de incidentes) antes de decidir; si hace falta, mover la búsqueda a una función SECURITY DEFINER (el dueño no pasa por RLS y el GiST sí se usa).
- **`alert_tenant_status_created_idx`:** ver C3.
- **Tablas append-only y BRIN:** ver sección 3.

#### M5. Las políticas del vecino permiten más de lo necesario
- **Evidencia:** `alert_citizen`, `media_citizen` y `alert_event_citizen` son `FOR ALL`. Los `GRANT` por columna (`0001:276-279`) no distinguen el contexto, de modo que un código defectuoso en contexto ciudadano puede:
  - `UPDATE alert SET status/priority/...` en una alerta propia.
  - Insertar un `alert_event` con `actor_type = 'OPERATOR'` y `kind = 'ACKNOWLEDGED'`, falsificando la auditoría.
  - `DELETE` de `media`.
- **SQL (0009, para `alert` y `media`; el de `alert_event` va en la reconstrucción de 0010):**
```sql
DROP POLICY alert_citizen ON alert;
CREATE POLICY alert_citizen_select ON alert FOR SELECT TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id());
CREATE POLICY alert_citizen_insert ON alert FOR INSERT TO guardia_app
  WITH CHECK (app_role() = 'citizen' AND citizen_id = app_citizen_id()
              AND status IN ('PENDING','UNROUTED') AND acknowledged_by IS NULL
              AND resolved_at IS NULL AND incident_id IS NULL AND priority IS NULL);
CREATE POLICY alert_citizen_cancel ON alert FOR UPDATE TO guardia_app
  USING (app_role() = 'citizen' AND citizen_id = app_citizen_id() AND status = 'PENDING')
  WITH CHECK (status = 'CANCELLED');
DROP POLICY media_citizen ON media;
CREATE POLICY media_citizen_select ON media FOR SELECT TO guardia_app USING (app_role() = 'citizen' AND EXISTS (
  SELECT 1 FROM alert a WHERE a.id = media.alert_id AND a.citizen_id = app_citizen_id()));
CREATE POLICY media_citizen_insert ON media FOR INSERT TO guardia_app WITH CHECK (app_role() = 'citizen' AND EXISTS (
  SELECT 1 FROM alert a WHERE a.id = media.alert_id AND a.citizen_id = app_citizen_id()));
```
- **Efecto en código:** ninguno. El INSERT del SOS deja que el trigger fije `status`/`ai_status` antes del `WITH CHECK`, por eso se aceptan `PENDING` y `UNROUTED`. Es el único paso a probar con cuidado: correr `test:db` completo y el simulador.
- **Un caso que no se puede cerrar con RLS:** un operador puede cambiar `citizen.name`, `blocked_at` y `consent_*` de cualquier vecino con una alerta en su municipio (`citizen_operator_update` más el GRANT por columna). Solo `trust_score` es necesario. Si se quiere cerrar, el ajuste de `trust_score` debe pasar por una función SECURITY DEFINER y quitar la política `citizen_operator_update`.

#### M6. Integridad de datos faltante
```sql
-- email: el login normaliza a minúsculas (shared/admin.ts:52, auth.service.ts:148) pero la base no lo exige
ALTER TABLE operator ADD CONSTRAINT operator_email_lower CHECK (email = lower(email) AND char_length(email) <= 160);

-- turnos: el chequeo de solape es solo de código (shifts.service.ts:54-65) y tiene carrera
CREATE EXTENSION IF NOT EXISTS btree_gist;      -- disponible en el servidor (pg_available_extensions)
ALTER TABLE shift ADD CONSTRAINT shift_no_overlap
  EXCLUDE USING gist (operator_id WITH =, tstzrange(planned_start, planned_end) WITH &&)
  WHERE (planned_start IS NOT NULL);
-- (en la base hoy: 0 solapes, la constraint se puede crear)

-- tenant
ALTER TABLE tenant ADD CONSTRAINT tenant_slug_fmt CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE tenant ADD CONSTRAINT tenant_cut_fmt  CHECK (cut_code IS NULL OR cut_code ~ '^[0-9]{4,5}$');
CREATE UNIQUE INDEX tenant_cut_code_uidx ON tenant (cut_code) WHERE cut_code IS NOT NULL;
ALTER TABLE tenant ADD CONSTRAINT tenant_settings_obj CHECK (jsonb_typeof(settings) = 'object');

-- textos sin tope (la API limita user_text a 1000 y el resumen de IA a 200; la base no)
ALTER TABLE alert
  ADD CONSTRAINT alert_user_text_len     CHECK (char_length(user_text)     <= 1000) NOT VALID,
  ADD CONSTRAINT alert_transcription_len CHECK (char_length(transcription) <= 5000) NOT VALID,
  ADD CONSTRAINT alert_ai_summary_len    CHECK (char_length(ai_summary)    <= 500)  NOT VALID,
  ADD CONSTRAINT alert_address_hint_len  CHECK (char_length(address_hint)  <= 300)  NOT VALID,
  ADD CONSTRAINT alert_ai_error_len      CHECK (char_length(ai_error)      <= 1000) NOT VALID,
  ADD CONSTRAINT alert_accuracy_chk      CHECK (accuracy_m IS NULL OR accuracy_m >= 0) NOT VALID,
  ADD CONSTRAINT alert_ai_flags_obj      CHECK (ai_flags IS NULL OR jsonb_typeof(ai_flags) = 'object') NOT VALID;
ALTER TABLE alert VALIDATE CONSTRAINT alert_user_text_len;  -- repetir para cada una
ALTER TABLE media  ADD CONSTRAINT media_duration_chk CHECK (duration_s IS NULL OR duration_s >= 0);
ALTER TABLE device ADD CONSTRAINT device_token_len   CHECK (char_length(expo_push_token) BETWEEN 10 AND 200);

-- updated_at coherente (hoy lo escribe el código en incident y contact)
CREATE TRIGGER incident_updated_at BEFORE UPDATE ON incident FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contact_updated_at  BEFORE UPDATE ON contact  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```
- La zona horaria (`tenant.timezone`) no tiene validación. Un valor inválido hace fallar `AT TIME ZONE ${tz}` en `stats.service.ts:66-74`. Validarla con un trigger contra `pg_timezone_names`, no con CHECK (un CHECK con subconsulta no se revalida).
- **Efecto en código:** en `shifts.service.ts`, agregar `23P01` (exclusion_violation) al manejo de `isUniqueViolation`, que hoy solo reconoce `23505`.

#### M7. Concurrencia: bloqueos y contadores
- **Orden de bloqueos inconsistente.** `ops.service.ts:266-270` hace `.for('update')` sobre las alertas del incidente sin `ORDER BY`. Dos operadores resolviendo alertas distintas del mismo incidente con "incluir agrupadas" pueden bloquearse mutuamente y Postgres aborta una transacción. Agregar `.orderBy(asc(alert.id))` antes de `.for('update')`.
- **`recompute` sin bloqueo propio.** Cuando la alerta ya tiene incidente, `attachInTx` llama `recompute` (`incidents.service.ts:44-46`) antes de tomar el advisory lock. Dos recomputaciones simultáneas del mismo incidente pueden pisarse en READ COMMITTED: la que commitea última escribe sus conteos aunque no haya visto una alerta que acaba de unirse. Hacer `SELECT ... FOR UPDATE` del incidente como primera sentencia de `recompute`.
- **Contadores.** `incident.alert_count` y `citizen_count` no se incrementan, se recalculan desde las alertas (`incidents.service.ts:151-212`), así que no se desvían, pero cuestan O(n) por alerta. En una fila caliente (un incidente con 1.000 alertas en minutos) son ~1.000 `UPDATE` serializados sobre la misma fila, con cambio de columnas indexadas (`last_alert_at`, `lat`, `lng` y la geography generada), o sea sin HOT. Si se mide como problema, recalcular con un límite de frecuencia (por ejemplo, cada 2 s por incidente) en lugar de en cada alerta.
- Los demás bloqueos son correctos: `FOR UPDATE` de la alerta y la unidad en el despacho, `FOR UPDATE` del refresh en la rotación, y el índice único parcial `dispatch_unit_open_uidx` como respaldo.
- No hay secuencias ni columnas autoincrementales (todo es UUID), así que no existe una secuencia caliente.

#### M8. Autovacuum, fillfactor y actualizaciones no HOT
- **Evidencia:** `pg_settings` tiene los valores por defecto (`autovacuum_vacuum_scale_factor = 0.2`) y `reloptions` está vacío en todas las tablas. Con 0.2, una tabla de 100 M de filas espera 20 M de filas muertas antes de limpiarse.
- **Qué actualizaciones pueden ser HOT:** una actualización es HOT solo si ninguna columna indexada (ni usada en el predicado de un índice parcial) cambia.
  - `alert`: todo `UPDATE` cambia `updated_at` (trigger), que está en `alert_tenant_updated_idx`, y casi siempre `status`, que está en predicados de índices. Nunca es HOT. El `fillfactor` no ayuda ahí.
  - `unit` (status, last_lat/lng, last_seen_at, ninguno indexado), `device`, `citizen` (`trust_score`) y `operator` (`last_login_at`) sí pueden serlo.
```sql
ALTER TABLE unit    SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 50);
ALTER TABLE device  SET (fillfactor = 80);
ALTER TABLE citizen SET (fillfactor = 90);
ALTER TABLE alert   SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE refresh_token SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE otp_code SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 1000);
```
- **Opción de mayor alcance (no urgente):** mover las columnas `ai_*` de `alert` a una tabla 1:1 reduce la rotación de la tabla caliente. Tiene un impacto de código grande, así que lo dejaría fuera.

---

### BAJO

- **B1. Espejo Drizzle (`schema.ts`) desalineado del SQL.** No afecta la ejecución, solo los tipos:
  - Sin `.references(...)` en `operator.createdBy` (línea 106), `alert.incidentId` (152), `auditLog.actorId` (234), `shift.createdBy` (254) y `contact.createdBy` (274).
  - `incident.importance` está como `integer` (línea 294) y en SQL es `smallint`.
  - El comentario de cabecera dice "espejo de 0001"; ya cubre 0001-0004.
  - Tras 0009/0010 hay que reflejar: `otpCode.id`, `refreshToken` (citizen/operator), `alertEvent` (actores), `priorityRank`, `uuidv7` por defecto.
- **B2. `refresh_token.token_hash` es `text` con 64 caracteres hex.** Guardarlo como `bytea` (32 bytes) reduce a la mitad el índice único más grande de la tabla más grande. Implica cambiar `hash()` en `token.service.ts` para devolver `Buffer` y declarar un tipo `bytea` en Drizzle.
- **B3. Clave del advisory lock.** `hashtextextended(texto, 0)` comparte espacio de claves con cualquier otro uso de advisory locks. Usar la forma de dos enteros `pg_advisory_xact_lock(int4, int4)` con un id de feature fijo.
- **B4. `tenant_boundary_gix`** (geography) no se usa, ya que el trigger convierte a geometry (A3). Si se adopta el índice funcional, queda como respaldo; `idx_scan` es 0.
- **B5. `otp_code.created_at`** no se refresca al reenviar el código (C1).

---

## 2. Llaves foráneas: resumen

- **Presentes y correctas (24 en la base):** todas las relaciones de dominio tienen FK. Las `ON DELETE` son coherentes: `CASCADE` en `device.citizen_id`, `media.alert_id`, `dispatch.alert_id`, `alert_event.alert_id`; el resto es `NO ACTION`. `NO ACTION` es adecuado para `alert.citizen_id` (los vecinos se anonimizan) y para `tenant` (se desactiva con `active`).
- **Faltantes:** `refresh_token.subject_id` (M1), `alert_event.actor_id` (M1), cruces de municipio (M3) y `refresh_token.replaced_by` (sin FK a propósito, M1).
- **Sin índice:** ver M2.

---

## 3. Multi-tenant y escala

### 3.1 Aislamiento por municipio, tabla por tabla

| Tabla | `tenant_id` | FK | RLS que lo usa | Veredicto |
|---|---|---|---|---|
| `tenant` | es la raíz | n/a | **ninguna** | Riesgoso (A2) |
| `operator` | NOT NULL | sí | sí (select/insert/update) | Correcto. `email` único global por diseño |
| `unit` | NOT NULL | sí | sí | Correcto. `UNIQUE (tenant_id, code)` |
| `alert` | **nullable** (UNROUTED) | sí | operador por `tenant_id`, vecino por `citizen_id` | Correcto. Las UNROUTED (2 en la base) solo las ve `system` y su dueño |
| `incident` | NOT NULL | sí | sí | Correcto. `alert.incident_id` puede cruzar municipios (M3) |
| `dispatch` | NOT NULL | sí | sí | Riesgoso: `unit_id`, `operator_id`, `alert_id` pueden ser de otro municipio (M3) |
| `shift`, `contact`, `audit_log` | NOT NULL | sí | sí | Correcto. `shift.operator_id` puede cruzar (M3) |
| `alert_event` | **nullable**, copia de `alert` | sí | operador por `tenant_id`, vecino por `EXISTS` | Correcto hoy (0 diferencias); sin garantía (M3). Sus 2 filas NULL son de alertas UNROUTED |
| `media` | **nullable**, copia de `alert` | sí | operador por `tenant_id` | Igual que `alert_event` |
| `citizen` | no tiene | n/a | self, operador por `EXISTS (alert del tenant)`, system | Correcto: global por diseño. Un operador puede tocar más columnas de las necesarias (M5) |
| `device` | no tiene | n/a | self, system | Correcto: global |
| `refresh_token`, `otp_code` | no tienen | n/a | solo `system` | Correcto: autenticación global previa al municipio. El municipio se deduce del `operator` |

Conclusión: el modelo de aislamiento es el adecuado (vecino global, alertas fuera de cobertura sin tenant, el operador acotado a su municipio). Lo que falta es la RLS en `tenant`, las invariantes entre municipios en la base y que las consultas puedan usar índices por tenant (C3).

### 3.2 Índices con `tenant_id` primero

| Consulta | Índice hoy | Problema | Índice propuesto |
|---|---|---|---|
| Cola de la central | `alert_tenant_status_created_idx` | sin `tenant_id` explícito no se usa; `status` es enum | `alert_open_queue_idx` (parcial) |
| Panel por rango | ninguno que sirva | barrido por `citizen_created` | `alert_tenant_created_idx` |
| Sincronización `since` | `alert_tenant_updated_idx` | bien | conservar |
| Bitácora de eventos | `alert_event_tenant_created_idx` | requiere `tenant_id` explícito | conservar (queda en la tabla particionada) |
| Bitácora del sistema | `audit_log_tenant_created_idx` | ídem | conservar |
| Incidentes (ventana) | `incident_tenant_type_last_idx` | `type` en medio | `incident_tenant_last_idx` |
| Outbox IA | ninguno | barrido de `tenant_updated` | `alert_ai_queued_idx` (parcial) |
| Purga de media | `media_retention_idx` (parcial) | bien | conservar |
| Refresh por hash | `token_hash` único | bien | conservar |

### 3.3 Crecimiento y estrategia concreta

**S1. Particionar `alert_event` y `audit_log` por mes (0010).**
- **Por qué esas dos.** Son append-only, sin FKs entrantes, y se consultan siempre con `tenant_id` y rango de fechas.
- **Por qué no las demás:**
  - `alert`: recibe FKs de `media`, `dispatch` y `alert_event`, y su `UNIQUE (citizen_id, client_ref)` (idempotencia del SOS) no puede incluir `created_at` sin perder la garantía.
  - `refresh_token`: la búsqueda por `token_hash` debe ser única globalmente.
  - Con 2,5 M de alertas al año, `alert` se sostiene con buenos índices.
- **PK compuesta.** Toda tabla particionada exige la clave de partición dentro de la PK. Queda `PRIMARY KEY (id, created_at)` con `uuid` + `timestamptz`, sin texto, así que se mantiene el criterio.
- **Por qué hacerlo ahora.** `alert_event` tiene 188 filas; reconstruirla hoy es trivial y más adelante es una migración larga.

```sql
-- 0010_scale.sql
CREATE TABLE alert_event_new (
  id                uuid        NOT NULL DEFAULT uuidv7(),          -- ver S2
  alert_id          uuid        NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
  tenant_id         uuid        REFERENCES tenant(id),
  actor_type        actor_type  NOT NULL,
  actor_operator_id uuid        REFERENCES operator(id),
  actor_citizen_id  uuid        REFERENCES citizen(id),
  actor_id          uuid GENERATED ALWAYS AS (COALESCE(actor_operator_id, actor_citizen_id)) STORED,
  kind              alert_event_kind NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CHECK ((actor_type = 'OPERATOR' AND actor_operator_id IS NOT NULL AND actor_citizen_id IS NULL)
      OR (actor_type = 'CITIZEN'  AND actor_citizen_id  IS NOT NULL AND actor_operator_id IS NULL)
      OR (actor_type IN ('SYSTEM','AI') AND actor_operator_id IS NULL AND actor_citizen_id IS NULL))
) PARTITION BY RANGE (created_at);
CREATE TABLE alert_event_default PARTITION OF alert_event_new DEFAULT;

-- creación de particiones: función SECURITY DEFINER con lista blanca; la llama el Cron de Nest y cada deploy
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(p_table text, p_months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m timestamptz; i int;
BEGIN
  IF p_table NOT IN ('alert_event', 'audit_log') THEN RAISE EXCEPTION 'tabla no permitida'; END IF;
  FOR i IN 0..p_months_ahead LOOP
    m := date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i);
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      p_table || '_' || to_char(m, 'YYYY_MM'), p_table,
      to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00',
      to_char(m + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+00');
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION ensure_monthly_partitions(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_monthly_partitions(text, int) TO guardia_app;
```
Los límites se fijan en UTC explícito, para que no dependan de la zona horaria de la sesión. Los pasos siguientes de la reconstrucción:
1. Crear con `ensure_monthly_partitions` las particiones de los meses que cubren los datos.
2. `INSERT INTO alert_event_new (...) SELECT ... FROM alert_event`, mapeando `actor_id` al operador o al vecino según `actor_type`.
3. `DROP TABLE alert_event` y `ALTER TABLE alert_event_new RENAME TO alert_event`, renombrando los índices y la PK a sus nombres originales.
4. Recrear `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, las políticas (con el vecino acotado como en M5: solo `SELECT` e `INSERT` con `actor_type='CITIZEN' AND actor_citizen_id = app_citizen_id() AND kind IN ('CREATED','CANCELLED')`), el trigger `tenant_from_alert` y los `GRANT` (`SELECT, INSERT`).
5. Crear `alert_event_alert_idx (alert_id, created_at)` y `alert_event_tenant_created_idx (tenant_id, created_at DESC, id DESC)`.

Para `audit_log` el procedimiento es el mismo, con PK `(id, created_at)` y `actor_id` con FK a `operator`.

- **Seguridad de las particiones.** Una partición consultada directamente no hereda las políticas del padre. Por eso A1 quita los privilegios por defecto: las particiones nuevas no tienen `GRANT` para `guardia_app`, y el acceso solo ocurre a través del padre.
- **Retención.** Definir con el municipio y con asesoría legal cuántos meses se conservan (por ejemplo 24 a 60). Se aplica con `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` y luego `DROP TABLE`, que no deja filas muertas ni requiere VACUUM.
- **BRIN.** Aporta poco hoy: el índice B-tree `(tenant_id, created_at ...)` ya sirve a toda consulta de la UI. Solo valdría para consultas globales por rango de fechas dentro de una partición ya cerrada (exportaciones, auditoría transversal). En ese caso, `CREATE INDEX ... USING BRIN (created_at) WITH (pages_per_range = 32)` por partición.
- **`refresh_token`.** Purga por lotes (A5) más autovacuum agresivo (M8). La opción de fondo es un diseño de sesión: una fila por dispositivo que se actualiza en lugar de una fila nueva por rotación (la tabla pasa de ~75 M filas al año a ~1 M), a costa de reescribir `token.service.ts`. Recomendada si el número de vecinos activos es alto.
- **`otp_code`.** El tamaño queda acotado por el número de teléfonos distintos. Se puede dejar `UNLOGGED` (se pierde al caer el servidor, aceptable para códigos de 5 minutos) o llevarlo a Redis con TTL.
- **Índices parciales ya propuestos** para las filas activas: `alert_open_queue_idx`, `alert_ai_queued_idx`, `refresh_token_subject_idx`, `shift_tenant_open_idx`.

**S2. Identificadores: UUID v4 contra v7.**
- **El problema.** `gen_random_uuid()` inserta en posiciones aleatorias del B-tree. En tablas grandes eso rompe la localidad: cada inserción toca una página distinta, y el índice deja de caber en memoria y genera más escritura de WAL. La base tiene `shared_buffers` en 16384 páginas (128 MB), valor por defecto.
- **Postgres 18 trae `uuidv7()` nativo; la 16 no.** Verifiqué en la base que este SQL puro produce UUID de versión 7 (nibble `7`, variante `8`/`9`) con prefijo de tiempo correcto:
```sql
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) from 3)
              from 1 for 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;
ALTER TABLE alert         ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE media         ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE incident      ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE dispatch      ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE refresh_token ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE audit_log     ALTER COLUMN id SET DEFAULT uuidv7();
-- alert_event ya nace con uuidv7() en la reconstrucción de S1
```
- **Dentro del mismo milisegundo el orden no es estrictamente monótono** (mi prueba de orden total dio `false` por eso). Para la localidad del índice basta la precisión de milisegundo. Las consultas con cursor usan `(created_at, id)` y no dependen del orden del id.
- **Recomendación.** Sí conviene, para las tablas de mayor volumen: `alert_event`, `audit_log`, `refresh_token`, `media`, `alert`. Con 2,5 M de alertas al año, el beneficio en `alert` es modesto; el real está en las tablas de decenas de millones de filas. Dejar v4 en `tenant`, `operator`, `citizen`, `device`, `unit`, `contact` y `shift` (poco volumen, y un id v7 revela cuándo se creó el registro).
- **Cumple el requisito:** sigue siendo `uuid`, ninguna PK es texto.
- **Efecto en código: ninguno.** Drizzle omite `id` en el `INSERT` y la base aplica el `DEFAULT`. Solo hay que reflejarlo en `schema.ts` como `.default(sql\`uuidv7()\`)`. Al migrar a Postgres 18, `pg_catalog.uuidv7()` tiene prioridad en el `search_path` y se puede eliminar la función propia.

**S3. Cuellos de botella de concurrencia.** Detalle en A6 y M7. Resumen:
- El advisory lock por municipio y tipo es el punto de serialización. Es correcto como idea, pero hay que acotar la espera.
- `incident` es la única fila caliente real. Solo se calienta en eventos masivos.
- Ninguna otra tabla tiene contadores compartidos ni secuencias.

### 3.4 Límites prácticos

Estimaciones por año, a escala nacional, con tus cifras (7.000 alertas al día y ~10 eventos por alerta) y estas hipótesis que **no vienen de los datos**: 100.000 vecinos activos al día con 2 renovaciones de sesión cada uno, 300 municipios con 10 operadores y 0,6 archivos por alerta. El tamaño por fila es el medido en la base (`pg_column_size`) más ~24 bytes de cabecera, e índices estimados en ≈1× el montón:

| Tabla | Filas/año | Bytes/fila medidos | Tamaño/año (con índices) | Crece sin tope |
|---|---|---|---|---|
| `alert` | 2,6 M | 381 | ~2 GB | no |
| `alert_event` | 25,6 M | 208 | ~9 GB | sí, sin retención |
| `audit_log` | ~3,7 M | 130 | ~1 GB | sí, sin retención |
| `refresh_token` | ~75 M | 152 | ~25 GB | sí, sin purga |
| `media` | ~1,5 M | 252 | ~1 GB | sí (soft delete) |
| `incident` | ≤ 2,6 M | n/m | ~1 GB | no |
| `otp_code` | ≤ nº de teléfonos | n/m | pequeño | acotada por teléfono |

**Qué se rompe primero (de antes a después):**
1. **Latencia de la cola, el panel y las bitácoras (C3).** Bastan ~10^6 alertas en total y varios cientos de operadores refrescando para saturar la CPU, porque cada lectura recorre todos los municipios. A 7.000 alertas al día son unos 5 meses. En un piloto de pocos municipios no se nota.
2. **Camino del SOS con muchos municipios (A3).** El trigger deserializa todas las geocercas en cada inserción.
3. **Backlog de la purga de media (A5):** crece ~3.700 archivos al día desde el primer día de carga completa. Es un tema de cumplimiento de retención, no solo de espacio.
4. **Outbox de IA (C3):** barrido de índice completo cada minuto; con ~10 M de alertas se acerca al `statement_timeout` de 10 s.
5. **`refresh_token` (A5):** decenas de GB sin purga, con índices que ya no caben en memoria hacia el segundo año. Las búsquedas siguen siendo logarítmicas; lo que sufre es el almacenamiento y el vacuum.
6. **Inanición del pool en un pico (A6):** depende de la carga puntual, no del volumen.
7. **Índice de `alert_event` con UUID aleatorio:** deja de caber en memoria después de 2 o 3 años.

El número de filas por sí solo no es el límite: 2,6 M de alertas al año se manejan con índices correctos.

---

## 4. Plan de entrega

> Numeración (13-10-2026): `0005_triage.sql` (agente de clasificación), `0006_geo_routing.sql` (comunas y
> traspaso entre municipios), `0007_comuna_parts.sql` (comunas en trozos para el ruteo) y `0008_misuse_field.sql`
> (faltas por aviso falso y resultado en terreno) se aplicaron antes que estas correcciones, así que el endurecimiento pasa a `0009_hardening.sql` y el particionado a `0010_scale.sql`. **A3 ya está resuelto en `0006_geo_routing.sql`**
> (el trigger de ruteo usa `ST_Covers` sobre geography, con índice GIST); sácalo de `0009`.
> `0005_triage.sql` ya cumple las reglas de este informe: `triage_label` tiene PK uuid, `tenant_id` con FK e
> índice, RLS por municipio, sin DELETE para la app y UPDATE solo por columna.

1. **Sin migración, ya:** `tenant_id` explícito en las consultas de operador (C3); `lock_timeout` en `attachInTx` (A6); `.orderBy(asc(alert.id))` en `resolve` (M7); `MaintenanceCron` con las purgas (A5).
2. **`0009_hardening.sql`:** C1, C2, A1, A2, A3, A4, M1 (refresh_token), M2, M3, M4, M5 (alert y media), M6, M8, y los índices de C3.
3. **`0010_scale.sql`:** reconstrucción particionada de `alert_event` y `audit_log`, función de particiones, `uuidv7()` y sus defaults. Hacerla antes del piloto, mientras las tablas son pequeñas.
4. **Fase 2, opcional:** rol de base por contexto (C3 nivel 2); sesiones en lugar de una fila por rotación; `token_hash` como `bytea`.
5. **Pruebas:** `pnpm --filter @guardia/api test:db` (RLS contra base real), `pnpm typecheck` y `pnpm simulate`. Añadir la prueba de plan de C3 y una prueba que verifique que `guardia_app` no puede escribir en `schema_migrations`.

Puntos que no pude comprobar en modo solo lectura y que hay que validar en una copia: que el índice funcional `((boundary::geometry))` lo use el trigger, que PostgreSQL 16 acepte la columna generada `actor_id` dentro de la tabla particionada (si no, quitarla y cambiar `mappers.ts:100` y `stats.service.ts:113-146, 234`), y que el planificador pruebe los predicados de los índices parciales nuevos igual que hizo con `dispatch_unit_open_uidx`.

---

## 5. Tabla resumen de llaves primarias

| Tabla | Columna | Tipo | ¿Cumple? |
|---|---|---|---|
| `alert` | `id` | uuid | Sí |
| `alert_event` | `id` | uuid | Sí (tras 0010: `(id, created_at)`, uuid y timestamptz, también cumple) |
| `audit_log` | `id` | uuid | Sí (igual, tras 0010) |
| `citizen` | `id` | uuid | Sí |
| `contact` | `id` | uuid | Sí |
| `device` | `id` | uuid | Sí |
| `dispatch` | `id` | uuid | Sí |
| `incident` | `id` | uuid | Sí |
| `media` | `id` | uuid | Sí |
| `operator` | `id` | uuid | Sí |
| **`otp_code`** | **`phone`** | **text** | **No (C1)** |
| `refresh_token` | `id` | uuid | Sí |
| **`schema_migrations`** | **`name`** | **text** | **No (C2)** |
| `shift` | `id` | uuid | Sí |
| `spatial_ref_sys` (PostGIS) | `srid` | integer | Sí |
| `tenant` | `id` | uuid | Sí |
| `unit` | `id` | uuid | Sí |

Las dos PK de texto se corrigen en 0009 con `id uuid` (y `id bigint IDENTITY` para `schema_migrations`) más `UNIQUE` sobre la columna natural. `onConflict` de `otp_code` no cambia.

---

## Archivos relevantes

- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\db\migrations\0001_init.sql`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\db\migrations\0002_erase_citizen.sql`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\db\migrations\0003_admin.sql`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\db\migrations\0004_incidents.sql`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\db\schema.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\db\migrator.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\db\db.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\alerts\alert-read.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\alerts\alerts.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\incidents\incidents.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\admin\stats.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\admin\shifts.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\auth\auth.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\auth\token.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\ops\ops.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\ops\units.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\media\media.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\privacy\privacy.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\events\events.service.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\jobs\ai-outbox.cron.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\jobs\retention.cron.ts`
- `C:\Claude\Dev\Guard-IA\guard-ia\apps\api\src\config\env.ts`
