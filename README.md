# Guard-IA

Ecosistema de seguridad ciudadana para municipios chilenos: SOS por botón o voz, reporte urbano y
central de monitoreo con triage por IA. Documento de arquitectura (Fase 0): `docs/fase-0-arquitectura.md`.

## Estado

| Fase | Qué | Estado |
| --- | --- | --- |
| 0 | Arquitectura, modelo de datos, contratos | aprobada |
| 1 | `apps/api` (NestJS + PostGIS/RLS + BullMQ + IA), Docker Compose, simulador | entregada |
| 2 | `apps/command` (central Next.js: cola, mapa, audio, ficha IA, despacho) | cerrada |
| 3 | `apps/mobile` (Expo) | pendiente |
| 4 | Despliegue y piloto | pendiente |

## Estructura

```
apps/api            Guard-IA Core: REST + Socket.io + worker IA (mismo proceso)
apps/command        Guard-IA Command: central de monitoreo (Next.js 16, react-leaflet, Tailwind 4)
apps/platform       Guard-IA Plataforma: consola del equipo Guard-IA (regiones, comunas, municipios), dominio propio
packages/shared     enums, schemas zod y eventos WS compartidos por API, central y app
infra/              docker-compose.yml, Caddyfile, backup.sh, .env.production.example
docs/               arquitectura y decisiones
```

## Desarrollo local

Requisitos: Node 22, pnpm 10, PostgreSQL 16 con PostGIS, Redis. En Windows, ver `docs/entorno-local.md`
(Postgres y Redis en WSL). (O `docker compose -f infra/docker-compose.yml up db redis minio`.)

```bash
cp .env.example .env            # editar JWT_* y, si corresponde, OPENAI_API_KEY
pnpm install
pnpm build                      # compila shared y api
pnpm migrate                    # crea esquema, rol guardia_app, RLS y trigger de ruteo
pnpm seed                       # Municipio Demo + 2 operadores + 4 unidades
pnpm --filter @guardia/api dev  # API en :3000
```

En otra terminal, el simulador recorre el flujo completo sin app móvil:

```bash
pnpm simulate --text "me están asaltando con un cuchillo en la plaza"
pnpm simulate --audio ./grabacion.m4a            # con OPENAI_API_KEY transcribe de verdad
pnpm simulate --type CIVIC_REPORT --text "bache en Concha y Toro"
pnpm simulate --lat 0 --lng 0                    # fuera de cobertura → UNROUTED
pnpm simulate --concurrency 25                   # + ráfaga de 25 reportes en paralelo (pool, timeouts)
```

Sale con código 0 si `alert.created` llega a la central en menos de 1 s y todo el flujo
(acuse, despacho, push al vecino, cierre, audio firmado) funciona.

Credenciales del seed: `admin@demo.guardia.cl` / `Demo1234!` (ADMIN) y `operador@demo.guardia.cl` (OPERATOR).

### Central (apps/command)

```bash
pnpm --filter @guardia/command dev     # http://localhost:3001 (usa NEXT_PUBLIC_API_URL, por defecto :3000)
```

Entra con las credenciales del seed. Lanza `pnpm simulate --external-dispatch` en otra terminal: la alerta
aparece en la cola al instante, la IA la clasifica, y al despachar una unidad desde la central el simulador
confirma que el vecino recibió el aviso.

Compuerta de la Fase 2, operada en Chromium headless (login, selección, acuse, despacho, push al vecino):

```bash
cd apps/command && pnpm build && cp -r .next/static .next/standalone/apps/command/.next/ && cp -r public .next/standalone/apps/command/
PORT=3001 node .next/standalone/apps/command/server.js &
node scripts/ui-gate.mjs            # usa @sparticuz/chromium; con Chrome instalado: --chrome /usr/bin/google-chrome
```

Deja capturas en `apps/command/screenshots/`.

### Consola de plataforma (apps/platform)

Para el equipo Guard-IA: comunas por región, alta de municipios desde su comuna, puesta en marcha, activar,
suspender y dar de baja, administrador municipal, teléfonos de prueba y bitácora (`docs/plan-plataforma.md`).
Requiere `PLATFORM_JWT_SECRET` y `PLATFORM_ENCRYPTION_KEY` en `.env` (sin ellas `/v1/platform` responde 404).

```bash
pnpm --filter @guardia/api platform:user --email persona@ejemplo.cl --name "Nombre Apellido"   # primer superadministrador
pnpm --filter @guardia/platform dev    # http://localhost:3002
```

El comando imprime una contraseña temporal una sola vez. Al entrar, la consola muestra la clave del segundo factor
(TOTP) para cargarla en una app de autenticación y luego pide definir una contraseña propia (12+ caracteres).

## Tests

```bash
pnpm --filter @guardia/shared test     # schemas y transiciones
pnpm --filter @guardia/api test        # unitarios (IA mock, validación de entorno)
pnpm --filter @guardia/api test:db     # aislamiento RLS y ruteo por geocerca (requiere base migrada)
```

## Decisiones de implementación que no están en el documento de Fase 0

- **NestJS 11 (CommonJS)**, no 12: NestJS 12 es ESM-only y rompe tooling conocido (tsx, decoradores con
  metadata). Migrar después es mecánico.
- **ORM: Drizzle** sobre `postgres` (postgres-js). Las migraciones son SQL a mano en
  `apps/api/src/db/migrations`; el schema Drizzle es solo un espejo tipado para consultar.
- **`lat`/`lng` como columnas** y `location` como columna generada `geography(Point)`: Drizzle no habla
  PostGIS, el índice GIST y `ST_Contains` sí lo usan.
- **Rol `guardia_app`** sin `BYPASSRLS`; cada transacción hace `SET LOCAL app.role/app.tenant_id/app.citizen_id`.
  Los workers usan `app.role = system`. Ver `DbService.withContext`.
- **`refresh_token`** tabla adicional para rotación con detección de reutilización.
- **Push Expo** vía HTTP directo (sin SDK): `expo-server-sdk` 7 es ESM-only.
- **Storage `local`** (disco + URL firmada HMAC) para desarrollo y CI; MinIO/S3 en producción.
- **IA `mock`** automática si no hay `OPENAI_API_KEY`: clasifica por palabras clave, no transcribe.
- **Una transacción por contexto, nunca anidadas**: `DbService.withContext` lanza si se llama dentro de otra
  (anidar reservaba dos conexiones por request y agotaba el pool bajo carga). El rol tiene
  `idle_in_transaction_session_timeout=15s`, `statement_timeout=10s`, `lock_timeout=5s`.
- **Redis no es dependencia dura del SOS**: el rate limit del SOS es fail-open (300 ms) y si encolar la IA
  falla, `AiOutboxCron` reencola cada minuto las alertas `QUEUED` sin job.
- **Invariantes en la base, no solo en código**: índice único parcial `dispatch_unit_open_uidx` (una unidad,
  un despacho abierto) y privilegios por columna (`tenant_id`, `citizen_id`, `lat/lng`, `type` de una alerta
  y `phone` de un vecino no son actualizables por la app, ni siquiera en contexto `system`).
- **Efectos antes del `throw`**: revocación de familia de refresh tokens y contador de intentos OTP se confirman
  en su propia transacción antes de responder 401 (un throw dentro de la transacción los revertía).
- **Cursor de la central** codifica `(prioridad, created_at con microsegundos, id)` para no repetir ni omitir.

## Decisiones de la central (Fase 2)

- **Sin framework de estado pesado**: zustand con selectores primitivos; la cola se ordena en cliente por
  prioridad y antigüedad (misma regla que la API).
- **Sesión en `localStorage`** con access token de 12 h y refresh rotativo; el cliente renueva en 401 una vez.
  Para el piloto es suficiente; si la central corre en equipos compartidos, pasar a cookie `HttpOnly` servida por
  la API (sección 11).
- **WebSocket con `since`**: al reconectar pide `sync` desde el último evento visto; notas y despachos tocan
  `updated_at` para entrar en ese sync.
- **Mapa**: OpenStreetMap atenuado con un filtro CSS para la sala oscura; marcadores `divIcon` coloreados por
  prioridad; la alerta nueva pulsa hasta que se abre.
- **Sonido**: dos tonos con Web Audio (SOS entrante; IA confirma prioridad alta), desactivable; el navegador
  exige una interacción previa.
- **Imagen por entorno**: `NEXT_PUBLIC_API_URL` queda fijada en el bundle de Next; Compose la pasa como
  `build-arg` desde `PUBLIC_API_URL`.

## Variables de entorno

Ver `.env.example` (desarrollo) e `infra/.env.production.example` (VPS). La app valida todas al arrancar
(`apps/api/src/config/env.ts`) y se niega a correr en producción con `STORAGE_DRIVER=local`,
`OTP_DEBUG_ENDPOINT=true`, `SMS_PROVIDER=console` o MinIO interno sin `S3_PUBLIC_ENDPOINT`. Una variable
vacía (`VAR=`) cuenta como no definida.

Media en el VPS: el navegador de la central no alcanza `minio:9000`. La API sube por la red interna y firma
las URLs contra `https://MEDIA_DOMAIN`, que Caddy sirve desde MinIO solo para lectura (el bucket es privado:
sin firma vigente no se lee nada).

## Despliegue (Fase 4, ya preparado)

```bash
cd infra && cp .env.production.example .env   # completar (4 dominios: API, central, consola y media)
docker compose up -d --build                  # db, redis, minio, migrate, api, command, platform, caddy
docker compose run --rm api node dist/cli/platform-user.js --email persona@ejemplo.cl --name "Nombre"   # primer superadministrador
docker compose run --rm api node dist/cli/seed.js --name "Municipalidad de X" --slug x --geojson /ruta/limite.geojson
```
