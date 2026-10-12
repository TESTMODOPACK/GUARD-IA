# Guard-IA — Fase 0: Arquitectura y contratos

Versión repo del documento de Fase 0 (11-10-2026). La versión viva, con diagramas y comentarios, está en
Claude Docs: https://claude.ai/code/artifact/f6b255b9-761f-4a34-92d7-51a34ab7c244

## 1. Alcance del MVP

Piloto con un municipio real: su Dirección de Seguridad Ciudadana recibe alertas SOS y reportes urbanos
de vecinos y despacha sus propias unidades. No se integra con Carabineros, SAMU ni Bomberos: no existen
APIs públicas, el operador deriva por teléfono y la app mantiene siempre visible la llamada al 133, 131 y 132.

Decisiones fijadas: Expo (app), NestJS + Socket.io + PostgreSQL/PostGIS + Redis/BullMQ + MinIO (backend),
Next.js + react-leaflet (central), multi-tenant con RLS desde el día 1 (tenant = municipio, ruteo por
polígono comunal), OpenAI Whisper + GPT con JSON schema estricto, monorepo pnpm + Turborepo con `shared`.

Dentro del MVP: SOS por botón (cuenta regresiva) y por voz, modo discreto de 15 s, reporte urbano con foto
y GPS, central con mapa/cola/audio/ficha IA/despacho, push al vecino, OTP SMS, retención configurable y
consentimiento versionado. Fuera: wake-word, ClaveÚnica, GPS en vivo de patrullas, integración con cámaras, BI.

## 2. ADRs

| ADR | Decisión | Consecuencia |
| --- | --- | --- |
| 001 Monorepo TS | pnpm + Turborepo, `packages/shared` con zod | Un lenguaje; schemas compartidos por API, central y app |
| 002 IA asíncrona | `POST /alerts` inserta y emite en <1 s; STT y clasificación en BullMQ | `alert.created` y `alert.updated`; `ai_status` separado de `status`; SOS sin IA = HIGH |
| 003 Tenant por geocerca + RLS | Trigger `BEFORE INSERT` con `ST_Contains`; RLS por `app.tenant_id` | Fuera de cobertura → `UNROUTED`; aislamiento vive en la base |
| 004 Push + WS | Estado al vecino por Expo Push y por WS con app abierta | Tabla `device`; cada cambio genera push y evento WS |
| 005 Audio en S3 con retención | URLs firmadas de 5 min, purga por `retention_until` | Cron diario; la transcripción queda como texto |
| 006 Auth dual | Ciudadano OTP SMS + JWT; operador email/contraseña con roles por tenant | Refresh tokens rotativos |
| 007 Sin wake-word | Botón, mantener presionado, widget/Action Button, modo discreto | Picovoice como ADR futuro |

## 3. Flujo del SOS

1. La app envía `POST /alerts` con audio y GPS.
2. El gateway guarda el audio, inserta la alerta (el trigger asigna el municipio), encola el job y emite
   `alert.created` a la central. Responde 201 antes de cualquier IA.
3. El worker toma el job, transcribe con Whisper y clasifica con GPT.
4. El worker actualiza la alerta; la central recibe `alert.updated`.
5. La central acusa y despacha por REST.
6. El gateway envía el push "unidad en camino" al vecino.

Gateway y worker corren en el mismo proceso Node en el MVP; Redis los desacopla.

## 4. Modelo de datos

Tablas: `tenant`, `citizen`, `device`, `operator`, `unit`, `alert`, `media`, `dispatch`, `alert_event`,
`otp_code`, `refresh_token` (esta última se agregó en Fase 1). Detalle de columnas en
`apps/api/src/db/migrations/0001_init.sql`; enums en `packages/shared/src/enums.ts`.

RLS: la API conecta como `guardia_app` (sin `BYPASSRLS`); cada transacción ejecuta `SET LOCAL app.role`,
`app.tenant_id`, `app.citizen_id`. Políticas `operator` (tenant propio), `citizen` (filas propias) y
`system` (workers). El ciudadano nunca elige `tenant_id`: lo calcula el trigger. `alert_event` es de solo
inserción para la app. `tenant` es solo lectura para la app.

## 5. Máquinas de estado

- Alerta: `PENDING → ACKNOWLEDGED → DISPATCHED → RESOLVED`; `PENDING → CANCELLED` (vecino, ≤30 s);
  `PENDING|ACKNOWLEDGED → REJECTED` (operador); `ACKNOWLEDGED → RESOLVED` sin despacho; `UNROUTED` nace así;
  `DISPATCHED → ACKNOWLEDGED` cuando se cancela el último despacho abierto (vuelve a ser despachable).
- Despacho: `ASSIGNED → EN_ROUTE → ON_SITE → CLOSED`; cualquiera → `CANCELLED`.
- IA: `QUEUED → PROCESSING → DONE`; fallo → reintento (máx. 3) → `FAILED` con falla segura; `SKIPPED`
  si no hay audio ni texto.

Transiciones en código: `packages/shared/src/enums.ts` (`ALERT_TRANSITIONS`, `DISPATCH_TRANSITIONS`).

## 6. Contratos API REST (`/v1`)

Ciudadano (JWT `citizen`): `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh`,
`GET /me`, `POST /me/consent`, `PUT /me/devices`, `POST /alerts` (multipart `meta` + `audio` + `photo`),
`POST /alerts/:id/cancel`, `GET /alerts/mine`, `GET /alerts/:id`.

Central (JWT `operator`): `POST /ops/auth/login`, `GET /ops/alerts`, `GET /ops/alerts/:id`,
`POST /ops/alerts/:id/ack|reject|dispatch|resolve|notes`, `PATCH /ops/dispatches/:id`,
`GET|POST /ops/units`, `PATCH /ops/units/:id`, `GET /ops/media/:id/url`.

Sistema: `GET /health`, `GET /metrics`. Desarrollo: `GET /dev/otp/:phone` (solo con `OTP_DEBUG_ENDPOINT=true`).

Errores: `{ code, message, details? }`; códigos en `packages/shared/src/schemas/common.ts`.

## 7. WebSocket

Socket.io, JWT en `handshake.auth.token`. `/ops` (room `tenant:{id}`): `alert.created`, `alert.updated`,
`dispatch.updated`, `unit.updated`, `sync` (al conectar con `since`). `/citizen` (room `citizen:{id}`):
`alert.status`. Tipos en `packages/shared/src/ws-events.ts`.

## 8. Pipeline IA

Job `alerts/process`, 3 reintentos con backoff exponencial. Whisper (`language: es`, prompt de contexto
chileno) + GPT con `response_format: json_schema` estricto. Falla segura: SOS sin clasificar queda HIGH /
OTRO_EMERGENCIA / `ai_status = FAILED`. Prompt y schema en `apps/api/src/ai/ai.provider.ts` y
`packages/shared/src/schemas/ai.ts`. Proveedor `mock` (palabras clave) si no hay `OPENAI_API_KEY`.

## 9. Activación discreta y falsas alarmas

Ninguna app de terceros captura el botón de encendido. Vías del MVP: botón con cuenta regresiva de 5 s,
mantener presionado, modo discreto (pantalla negra, 15 s de ambiente), widget, Action Button.
`trust_score` por ciudadano: parte en 100, −25 por rechazo `FALSE_ALARM`, +5 por alerta resuelta; bajo 25
un SOS entra como MEDIUM aunque la IA diga HIGH. Cancelación hasta 30 s. Rate limits: OTP 3/h, login 5/min,
SOS 3/10 min, reportes 10/día.

## 10. Infraestructura

VPS con Docker Compose (`infra/docker-compose.yml`): `db` (postgis), `redis`, `minio` + `minio-init`,
`migrate`, `api`, `caddy`. Backups con `infra/backup.sh`. CI en `.github/workflows/ci.yml`.

## 11. Seguridad y Ley 21.719

Consentimiento versionado, minimización (sin RUT), retención 90 días de media, URLs firmadas,
refresh rotativo, sesiones de operador de 12 h, auditoría inmutable para la app, rate limits,
transferencia a OpenAI informada en el consentimiento. ARCO (`GET /me/export`, `DELETE /me`) en Fase 4.

## 12. Fases

| Fase | Entregable | Compuerta |
| --- | --- | --- |
| 0 | Este documento | Aprobado |
| 1 | API, RLS, IA, Docker, simulador | Simulador e2e: `alert.created` < 1 s (pasó: 40–90 ms) |
| 2 | Central Next.js | Despacho e2e con push (pasó: `scripts/ui-gate.mjs` en Chromium) |
| 3 | App Expo | SOS real desde un teléfono |
| 4 | Despliegue y piloto | Municipio recibe alertas reales |

## 13. Preguntas abiertas y lecturas tomadas en Fase 1

| Pregunta | Lectura tomada en Fase 1 (cambiable) |
| --- | --- |
| ORM | Drizzle sobre postgres-js; migraciones SQL a mano |
| SMS | Interfaz `SmsProvider`: `console` en desarrollo, `twilio` por REST listo |
| Municipio piloto | Seed `Municipio Demo` con rectángulo del Gran Santiago; `pnpm seed --geojson` carga uno real |
| Reportes urbanos | Misma central, filtro por `type` |
| Audio ambiente | Un clip (Fase 3) |
| Dominio y VPS | Compose aislado; dominios por variables `API_DOMAIN` y `CENTRAL_DOMAIN` |
| Repositorio | Entregado como archivo; `git init` hecho, sin remoto |
