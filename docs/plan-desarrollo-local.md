# Guard-IA — Plan de desarrollo en local

Versión 12-10-2026. Todo se desarrolla y prueba en el equipo local (Windows 11, 7,7 GB RAM) y en un
teléfono en la misma red wifi. El VPS, los dominios, TLS y las cuentas reales (Twilio, S3, push en
producción) quedan fuera hasta decidir el piloto.

## Principios

- Cada etapa termina en una **compuerta** verificable; no se pasa a la siguiente con la anterior roja.
- "Terminado" = `pnpm typecheck` + tests + simulador verdes (regla del `CLAUDE.md`), más la compuerta
  de la etapa.
- Cambios de contrato empiezan en `packages/shared`.
- Un commit por paso con mensaje en español; nada se sube a un remoto hasta que se decida.

## Entorno local objetivo

| Pieza | En local | Nota |
| --- | --- | --- |
| Postgres 16 + PostGIS | Ubuntu en WSL2 (`apt`) | La API en Windows conecta por `localhost:5432` |
| Redis | Ubuntu en WSL2 | Solo para BullMQ y rate limit; el SOS no depende de él |
| Archivos (audio, foto) | `STORAGE_DRIVER=local` | MinIO opcional en la etapa 4 |
| SMS | `SMS_PROVIDER=console` + `OTP_DEBUG_ENDPOINT=true` | El código OTP sale en la consola de la API |
| IA | `mock` (palabras clave) | `OPENAI_API_KEY` opcional para probar Whisper y GPT de verdad |
| API | `pnpm --filter @guardia/api dev` en `:3000` | Expuesta en la IP local para el teléfono |
| Central | `pnpm --filter @guardia/command dev` en `:3001` | |
| App | Expo (Metro) + Expo Go en el teléfono | Push real requiere *development build* (ver riesgos) |

Alternativa al WSL: Docker Desktop con el `docker-compose.yml` de la raíz (más pesado con 7,7 GB de RAM).

## Etapas

> Avance: etapas 0, 1 y 2 ✅ · etapa 3: 3a–3f ✅ (12-10-2026) · pendiente de la fase 3: prueba en Android real y push con development build · etapa 4: derechos ARCO ✅ (API + app), media pública de MinIO ✅, administración de la central ✅ (usuarios, turnos, directorio, panel y bitácora).

### Etapa 0 — Base de trabajo (1 sesión)

1. `git init`, `.gitignore` (node_modules, .next, dist, .env, storage local), commit inicial con el estado actual.
2. Ubuntu en WSL2; instalar `postgresql-16`, `postgresql-16-postgis-3`, `redis-server`; crear rol y base.
3. `cp .env.example .env`; secretos de desarrollo; `pnpm migrate && pnpm seed`.
4. Regla de firewall de Windows para `:3000` en red privada (para el teléfono más adelante).
5. Script `pnpm dev:all` (API + central) y un `docs/entorno-local.md` corto con los pasos.

**Compuerta:** `pnpm --filter @guardia/api test:db` verde (los 12 tests hoy omitidos) y `GET /health` ok.

### Etapa 1 — Cerrar la Fase 2 (1 sesión)

1. `pnpm simulate --text "…"`, `--concurrency 25`, `--lat 0 --lng 0` (UNROUTED), `--external-dispatch`.
2. Compuerta en navegador `apps/command/scripts/ui-gate.mjs` contra la API real.
3. Probar a mano lo corregido en la revisión: reconexión WS (reiniciar la API con la central abierta),
   dos pestañas, caída de la API sin perder sesión, diálogos con teclado.
4. Corregir regresiones; actualizar `README.md` y `CLAUDE.md` (Fase 2 cerrada).

**Compuerta:** simulador (`alert.created` < 1 s) y `ui-gate.mjs` verdes; checklist manual completo.

### Etapa 2 — Endurecer sesión y calidad (1–2 sesiones)

1. `POST /auth/logout` que revoca la familia de refresh (patrón "efectos antes del throw").
2. `JWT_OPERATOR_REFRESH_TTL_SECONDS` separado (13 h: un turno + margen); test.
3. CSP para la central en `infra/Caddyfile` (self, API, tiles de OSM, Google Fonts).
4. La central llama a logout al cerrar sesión.
5. ESLint con reglas de hooks en `apps/command`; íconos del mapa memorizados; limpiar cerradas viejas del store.

**Compuerta:** tests nuevos verdes; logout invalida el refresh (verificado con curl); etapa 1 sigue verde.

### Etapa 3 — App del vecino en Expo (Fase 3; 6 entregas)

Diseño de referencia: prototipo "Guard-IA · App del vecino" (modo nocturno, SOS con pulso, mapa de seguimiento).

| Entrega | Contenido | Compuerta |
| --- | --- | --- |
| 3a | `apps/mobile` con Expo + TypeScript, navegación, `@guardia/shared` en el monorepo, tema del prototipo, barra fija 133/131/132 | La app abre en Expo Go en el teléfono y lee `/health` de la API local |
| 3b | Ingreso por SMS (OTP), refresh rotativo, consentimiento versionado (`CONSENT_VERSION`), `PUT /me/devices` | Login completo con el código de la consola; consentimiento guardado en la base |
| 3c | SOS por botón: cuenta regresiva 5 s, `POST /alerts` con GPS y `clientRef` (idempotencia), cancelación ≤ 30 s, UNROUTED | El SOS aparece en la central en < 1 s; cancelar lo saca de la cola |
| 3d | Seguimiento: WS `/citizen` (`alert.status`), pantalla de estado, "Mis casos" (`GET /alerts/mine`) | Acusar y despachar desde la central cambia el estado en el teléfono sin recargar |
| 3e | SOS por voz (mantener presionado, `expo-av`), modo discreto (pantalla negra, 15 s), subida multipart | El audio llega, la IA (mock u OpenAI) lo clasifica y la central lo reproduce |
| 3f | Reporte urbano con foto y categoría; permisos (ubicación, micrófono, cámara) con textos claros; estados sin red | Reporte con foto visible en la central; la app no se cae sin red |

**Compuerta de la fase:** un SOS real desde el teléfono llega a la central y el vecino ve "unidad en
camino". El push se valida con un *development build* (ver riesgos); si aún no hay, basta el estado por WS.

### Etapa 4 — Ensayo de piloto en local (1–2 sesiones)

1. Stack completo con Docker Compose en el equipo (o WSL), incluido MinIO, para ensayar lo que irá al VPS.
2. `GET /me/export` y `DELETE /me` (derechos ARCO, Ley 21.719).
3. `infra/backup.sh`: respaldo y **restauración** probada.
4. Carga: `simulate --concurrency 25` + 2 centrales abiertas + 2 teléfonos.
5. Guion de demo para el municipio (10 minutos, con datos del seed o el GeoJSON real de la comuna).

**Compuerta:** demo completa sin intervención manual; respaldo restaurado en una base limpia.

## Decisiones pendientes

| Decisión | Cuándo | Recomendación |
| --- | --- | --- |
| WSL o Docker Desktop | Etapa 0 | WSL (menos RAM) |
| TTL del refresh del operador | Etapa 2 | 12 h |
| Modo claro además del nocturno en la app | Antes de 3a | Solo nocturno para el piloto; claro después |
| ¿OpenAI real en local? | Etapa 3e | Mock hasta 3e; una prueba con clave real antes del piloto |
| Municipio y polígono reales | Etapa 4 | Pedir el GeoJSON comunal al municipio |
| Remoto Git (GitHub privado) | Cuando quieras respaldo fuera del equipo | Repositorio privado |

## Riesgos y cómo se mitigan

- **Push en Expo Go:** desde Expo SDK 53, Expo Go en Android no recibe push remotos. Para validar el
  push hace falta un *development build* (`npx expo run:android` con Android Studio, o EAS Build en la
  nube). Mitigación: el estado del caso llega también por WS; el push se valida al final de la etapa 3.
- **Teléfono no alcanza la API:** usar la IP local del equipo (no `localhost`) en la app y abrir el
  puerto en el firewall de Windows; misma red wifi.
- **RAM (7,7 GB):** API + central + Metro + WSL caben; Docker Desktop completo puede no caber. Cerrar lo
  que no se use.
- **Audio en Android/iOS:** formatos distintos (m4a/aac); la API ya acepta multipart; probar en el
  teléfono real temprano (3e).

## Fuera de alcance mientras sea local

VPS y Caddy con TLS real, dominios, Twilio con cuenta real, S3/MinIO en producción, publicación en
tiendas (App Store / Play Store), monitoreo y alertas de operación.
