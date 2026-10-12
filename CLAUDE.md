# Guard-IA — contexto para Claude Code

Plataforma de seguridad ciudadana municipal (Chile): SOS por botón/voz, reporte urbano, central de
monitoreo con triage por IA. Monorepo pnpm + Turborepo. Idioma del código y los commits: español en
comentarios, mensajes y UI; identificadores en inglés.

Lee primero: `README.md` (cómo correr y probar) y `docs/fase-0-arquitectura.md` (decisiones, modelo
de datos, contratos, fases). Si una decisión está ahí, no la cambies sin decirlo explícitamente.

## Estado

| Fase | Qué | Estado |
| --- | --- | --- |
| 0 | Arquitectura y contratos | aprobada |
| 1 | `apps/api` (NestJS 11, PostGIS/RLS, BullMQ, IA), infra, simulador | entregada y revisada |
| 2 | `apps/command` (central Next.js 16) | cerrada: revisada, simulador y `ui-gate.mjs` verdes contra base real (12-10-2026) |
| 3 | `apps/mobile` (Expo) | siguiente |
| 4 | Despliegue en VPS y piloto | preparada en `infra/`, sin ejecutar |

## Comandos

```bash
pnpm install && pnpm build          # compila packages/shared, apps/api y apps/command
cp .env.example .env                # editar JWT_ACCESS_SECRET (32+), OPENAI_API_KEY opcional
pnpm migrate && pnpm seed           # requiere Postgres 16 + PostGIS y Redis (o docker compose -f infra/docker-compose.yml up db redis)
pnpm --filter @guardia/api dev      # API en :3000
pnpm --filter @guardia/command dev  # central en :3001
pnpm simulate --text "..."          # flujo e2e sin app móvil; compuerta Fase 1 (alert.created < 1 s)
pnpm simulate --external-dispatch   # crea un SOS y espera que la central despache
pnpm --filter @guardia/shared test && pnpm --filter @guardia/api test:db   # tests (RLS contra base real)
cd apps/command && node scripts/ui-gate.mjs   # compuerta Fase 2 en Chromium headless (central corriendo en standalone)
```

Antes de dar algo por terminado: `pnpm typecheck`, los tests de arriba y el simulador deben pasar.

## Estructura

- `packages/shared`: enums, schemas zod, eventos WS, transiciones de estado. Es el contrato entre API,
  central y app: cualquier cambio de API empieza aquí.
- `apps/api/src`: `auth/` (OTP, JWT, refresh rotativo), `alerts/` (camino crítico del SOS), `ops/`
  (acciones de la central), `ai/` (worker BullMQ, proveedores openai/mock), `realtime/` (Socket.io
  `/ops` y `/citizen`), `media/` (S3 o disco local), `notifications/` (push Expo), `db/` (Drizzle +
  migraciones SQL a mano en `db/migrations`), `jobs/` (purga de retención, outbox IA), `cli/`
  (migrate, seed). `scripts/simulate.ts` es el simulador.
- `apps/command/src`: `lib/` (api, session, store zustand, realtime, labels en español), `components/`
  (TopBar, AlertQueue, MapView, AlertDetail, Dialogs, UnitsBar, Dashboard). `scripts/ui-gate.mjs` es la
  compuerta en navegador.
- `infra/`: docker-compose (db, redis, minio, migrate, api, command, caddy), Caddyfile, backup.sh.

## Reglas que no se rompen

1. **El SOS nunca espera a la IA ni a Redis.** `POST /alerts` inserta, guarda media, emite
   `alert.created` y responde. La IA corre en el worker; el rate limit del SOS es fail-open; si
   encolar falla, `AiOutboxCron` reencola.
2. **Una transacción por contexto, nunca anidadas.** Toda consulta va dentro de
   `DbService.asSystem/asCitizen/asOperator`. Llamar `withContext` dentro de otro lanza error a
   propósito (agotaba el pool bajo carga). Si necesitas datos de otro contexto, léelos antes o
   después, o usa la misma `tx`.
3. **RLS es la frontera.** La API conecta como `guardia_app` sin BYPASSRLS. `tenant_id`, `citizen_id`,
   `lat/lng`, `type` de una alerta y `phone` de un vecino no son actualizables ni en contexto system
   (privilegios por columna en la migración). El ciudadano nunca elige municipio: lo decide el trigger
   `alert_route_tenant` por geocerca.
4. **Efectos secundarios antes del `throw`.** Un `throw` dentro de una transacción la revierte. La
   revocación de refresh tokens y el contador de intentos OTP se confirman en su propia transacción
   antes de responder 401. Repite el patrón si agregas lógica parecida.
5. **Las emisiones WS y los push van después del commit**, nunca dentro del callback de `withContext`.
6. **Invariantes en la base, no solo en código**: índice único parcial `dispatch_unit_open_uidx`
   (una unidad, un despacho abierto), `UNIQUE (citizen_id, client_ref)` para idempotencia.
7. **Migraciones**: SQL a mano, un archivo nuevo numerado en `apps/api/src/db/migrations/`; nunca
   editar `0001_init.sql` una vez desplegado. El schema Drizzle (`db/schema.ts`) es espejo tipado,
   no genera migraciones. Enums de Postgres y de `shared/enums.ts` deben coincidir.
8. **Errores de API**: `AppError(code, message, details?)` con códigos de `shared` (`ERROR_CODES`).
   Validación con zod vía `zod(Schema)` en controladores.
9. **Central**: selectores de zustand devuelven primitivos o referencias estables; derivar listas con
   `useMemo`. Contenido del vecino (transcripción, texto, notas) siempre como texto, nunca HTML.
   Vocabulario de la UI en `src/lib/labels.ts`; una sola palabra por concepto.
10. **Producción**: `validateEnv` rechaza `STORAGE_DRIVER=local`, `OTP_DEBUG_ENDPOINT=true`,
    `SMS_PROVIDER=console` y secretos por defecto. No lo relajes.

## Decisiones tomadas (resumen; detalle en README y docs)

NestJS 11 CommonJS (no 12, es ESM-only). Drizzle sobre postgres-js. `lat/lng` como columnas +
`location` generada. Push Expo por HTTP sin SDK. Storage `local` solo en desarrollo/CI. IA `mock` si
no hay `OPENAI_API_KEY`. Email de operador único global. Dashboard único con filtro por tipo (no una
vista separada para Obras/Aseo). Cursor de la central `(prioridad, created_at µs, id)`.
`NEXT_PUBLIC_API_URL` se fija en el build de la central (una imagen por entorno).

## Preguntas abiertas (sección 13 del doc de Fase 0; lecturas provisionales en vigor)

- Proveedor SMS: `console` en dev; Twilio por REST implementado, sin probar con cuenta real.
- Municipio piloto: seed con "Municipio Demo" (rectángulo del Gran Santiago); cargar el real con
  `pnpm seed --geojson limite.geojson --name "..." --slug ...`.
- Audio ambiente de 15 s: un clip (Fase 3); encadenado post-piloto.
- VPS y dominios: `infra/.env.production.example`.
- Repositorio: aún sin remoto.

## App del vecino (apps/mobile) — cómo está hecha

`pnpm mobile` (en PowerShell: `pnpm.cmd mobile`; si cambian dependencias o rutas: `--clear`). Rutas en
`src/app` con `Stack.Protected`: sin sesión → `login`/`verify`; sin `CONSENT_VERSION` vigente →
`consent`; si no → `index`, `sos`, `voice`, `discreet`, `report`, `alert/[id]`, `cases`. Sesión en
SecureStore (`lib/session.ts`), cliente con refresh de una vez (`lib/api.ts`), WS `/citizen`
(`lib/realtime.ts`), envío multipart con `clientRef` y 3 reintentos (`sendAlert`). La URL de la API sale
de la IP que sirve Metro (o `EXPO_PUBLIC_API_URL`). Usar `npx expo install` para dependencias y revisar
la doc versionada de Expo (cambia por SDK; ver `apps/mobile/AGENTS.md`). Probar en web: el navegador no
tiene GPS ni micrófono (simularlos); Expo Go Android no recibe push.

## Fase 3 (referencia: alcance original)

Compuerta: un SOS real desde un teléfono llega a la central y vuelve como push. Alcance: OTP SMS,
consentimiento versionado (`CONSENT_VERSION` en shared), registro de dispositivo (`PUT /me/devices`),
botón SOS con cuenta regresiva de 5 s y cancelación hasta 30 s (`POST /alerts/:id/cancel`), SOS por voz
(mantener presionado, `expo-av`), modo discreto (pantalla negra, 15 s de ambiente), reporte urbano con
foto y categoría, estado del caso por `/citizen` WS y push, aviso permanente "llamar al 133/131/132",
manejo de `UNROUTED` (fuera de cobertura). Reutilizar `@guardia/shared` para schemas y eventos. El
contrato REST está en la sección 6 del doc de Fase 0 y en `apps/api/src/alerts/alerts.controller.ts`
(multipart: campo `meta` JSON + `audio` + `photo`). Mantener compuertas y simulador verdes.

## Pendiente conocido

- Plan en curso: `docs/plan-desarrollo-local.md` (etapas 0, 1 y 2 hechas; siguiente: etapa 3, app Expo).
  Entorno: `docs/entorno-local.md` (Postgres/Redis en WSL; `pnpm infra:wsl` + `pnpm dev`).
- Para la etapa 4 (ensayo con Docker): con `S3_ENDPOINT=http://minio:9000` las URLs firmadas de media
  apuntan a un host interno que el navegador no alcanza (falta un endpoint público de MinIO y
  agregarlo a la CSP de la central); `infra/.env.production.example` no existe aunque se cita.
- `next build` con `output: 'standalone'` falla en Windows al copiar node_modules enlazados por pnpm
  (symlinks); compila bien y la imagen Docker se construye en Linux. CSP de la central sin nonce.
- `GET /me/export` y `DELETE /me` (derechos ARCO) están en Fase 4.
- Twilio, MinIO/S3 y push Expo reales no se han ejercitado con cuentas reales.
