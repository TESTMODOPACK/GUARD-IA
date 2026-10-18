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
| 3 | `apps/mobile` (Expo SDK 57, Expo Router) | implementada (3a–3f), probada en web contra la API real; falta Android real y push (development build) |
| 4 | Despliegue en VPS y piloto | preparada (`docker-compose.yml` en la raíz, guía `infra/HOSTINGER.md`), sin ejecutar |
| P1 | Consola de plataforma (`apps/platform`, migración 0010) | implementada y probada en local (13-10-2026) |
| PU | Uso indebido: faltas (0008), restricción, bloqueo con aprobación y revisión (0011) | implementado y probado en local (13-10-2026) |
| PT | Terreno: rol FIELD, página `/terreno` de la central, avisos de terreno (0012) | implementado y probado en local (14-10-2026); falta Web Push (PT-4) |
| PA | Áreas municipales: derivación por área, carácter de seguridad, rol Apoyo administrativo, agente `triage-v3` (0013) | implementado y probado en local (14-10-2026) |
| PL | Ley 21.719 (rige el 01-12-2026): análisis en `docs/legal/`, plan en `docs/plan-ley-21719.md` (etapas 0–5 + pista legal) | etapas 0 y 1 implementadas y probadas en local (15-10-2026, migración 0014); siguen 2–5 y la pista legal |
| PN | SOS para negocios: botón de pánico discreto para comercios con video de sus cámaras como evidencia (`docs/plan-sos-negocios.md`) | idea analizada (15-10-2026), sin iniciar; después del piloto, partiendo por la opinión legal (Ley 21.659) y la etapa N0 sin cámaras |

## Comandos

```bash
pnpm install && pnpm build          # compila packages/shared, apps/api y apps/command
cp .env.example .env                # editar JWT_ACCESS_SECRET (32+), OPENAI_API_KEY opcional
pnpm migrate && pnpm seed           # requiere Postgres 16 + PostGIS y Redis (o Docker con el docker-compose.yml de la raíz)
pnpm --filter @guardia/api dev      # API en :3000
pnpm --filter @guardia/command dev  # central en :3001
pnpm --filter @guardia/platform dev # consola de plataforma en :3002 (requiere PLATFORM_JWT_SECRET y PLATFORM_ENCRYPTION_KEY)
pnpm --filter @guardia/api platform:user --email x@y.cl --name "..." [--role SUPERADMIN]   # crea o restablece una cuenta de la consola
pnpm simulate --text "..."          # flujo e2e sin app móvil; compuerta Fase 1 (alert.created < 1 s)
pnpm simulate --external-dispatch   # crea un SOS y espera que la central despache
pnpm --filter @guardia/shared test && pnpm --filter @guardia/api test:db   # tests (RLS contra base real)
pnpm --filter @guardia/api eval:triage [--provider mock|openai] [--gate]   # agente de clasificación: 65 casos
pnpm --filter @guardia/api load-comunas --geojson comunas.geojson [--srid 32719]   # 346 comunas (datos públicos)
cd apps/command && node scripts/ui-gate.mjs   # compuerta Fase 2 en Chromium headless (central corriendo en standalone)
```

Antes de dar algo por terminado: `pnpm typecheck`, los tests de arriba y el simulador deben pasar.

## Estructura

- `packages/shared`: enums, schemas zod, eventos WS, transiciones de estado. Es el contrato entre API,
  central y app: cualquier cambio de API empieza aquí.
- `apps/api/src`: `auth/` (OTP, JWT, refresh rotativo), `alerts/` (camino crítico del SOS), `ops/`
  (acciones de la central), `ai/` (worker BullMQ, proveedores openai/mock, `triage.prompt.ts`), `realtime/` (Socket.io
  `/ops`, `/citizen` y `/field`), `media/` (S3 o disco local), `geo/` (comunas, traspaso entre municipios), `notifications/` (push Expo), `db/` (Drizzle +
  migraciones SQL a mano en `db/migrations`), `jobs/` (purga de retención, outbox IA, tokens y códigos vencidos), `cli/`
  (migrate, seed), `admin/` (usuarios, turnos, contactos, panel y bitácora; migración 0003), `accounts/` (estado de cuenta
  del vecino, bloqueos, anulación de faltas y revisiones; migración 0011), `field/` (terreno: turno con unidad, estado,
  informe, posición, pánico, avisos y reloj de plazos; migración 0012), `areas/` (áreas del municipio, reglas por
  categoría, modo compartido y alcance de cada cuenta; migración 0013), `legal/` (Ley 21.719: aviso al vecino, prueba del
  consentimiento, regla de subencargados para el worker y «Privacidad» de la central; migración 0014). `scripts/simulate.ts` es el
  simulador.
- `apps/command/src`: `lib/` (api, session, store zustand, realtime, field-realtime, labels en español), `components/`
  (TopBar, AlertQueue, MapView, AlertDetail, TriagePanel, Dialogs, UnitsBar, Dashboard, ShiftControl, ContactsHint,
  FieldAlarmsBar, `admin/AdminShell`). Páginas: `/` central, `/terreno` (funcionario de terreno, en el teléfono), `/admin` panel, `/admin/usuarios`, `/admin/areas` (solo ADMIN), `/admin/turnos`,
  `/admin/cuentas` (bloqueos por aprobar, revisiones, faltas), `/admin/privacidad` (contacto, subencargados e incidentes; 0014), `/admin/bitacora`, `/directorio`, `/cambiar-clave`. `scripts/ui-gate.mjs` es la
  compuerta en navegador.
- `apps/api/src/platform/`: consola de plataforma (TOTP propio sin dependencias, tokens y sesiones propias,
  guard propio, regiones y comunas, municipios, equipo, bitácora). `apps/platform/src`: `lib/` (api, sesión en
  sessionStorage, labels), `components/` (Shell, ComunaMap, TenantDialogs). Páginas: `/` Chile, `/region/[cut]`,
  `/municipio/[id]`, `/municipios`, `/subencargados`, `/incidentes` (0014), `/usuarios`, `/bitacora`, `/login`, `/cambiar-clave`.
- `docker-compose.yml` en la raíz (db, redis, minio, migrate, api, command, platform, caddy), con `.dockerignore` y
  `.env.production.example`. Cada contenedor recibe solo sus variables (lista explícita: si se agrega una en
  `config/env.ts`, se agrega también ahí) y los datos van en volúmenes con nombre. `infra/`: `install.sh` (instalador del
  VPS, idempotente; `curl … | bash` clona en `/opt/guard-ia`; si cambian las variables obligatorias, se actualiza
  también), Caddyfile, backup.sh, `HOSTINGER.md` (despliegue) y `RESTAURAR.md`.

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
   `alert_route_tenant` por geocerca. La única vía para cambiar el municipio de una alerta es la función
   `transfer_alert()` (migración 0006, SECURITY DEFINER, auditada): la usan el agente y la central.
   Toda consulta de operador filtra además `tenant_id` explícito (la RLS no usa índices por municipio por sí
   sola; 0009). `tenant` tiene RLS: el operador solo ve el suyo; para nombres o límites de otros municipios se
   lee la vista `tenant_directory`, nunca `tenant`.
4. **Efectos secundarios antes del `throw`.** Un `throw` dentro de una transacción la revierte. La
   revocación de refresh tokens y el contador de intentos OTP se confirman en su propia transacción
   antes de responder 401. Repite el patrón si agregas lógica parecida.
5. **Las emisiones WS y los push van después del commit**, nunca dentro del callback de `withContext`.
6. **Invariantes en la base, no solo en código**: índice único parcial `dispatch_unit_open_uidx`
   (una unidad, un despacho abierto), `UNIQUE (citizen_id, client_ref)` para idempotencia.
7. **Migraciones**: SQL a mano, un archivo nuevo numerado en `apps/api/src/db/migrations/`; nunca
   editar `0001_init.sql` una vez desplegado. El schema Drizzle (`db/schema.ts`) es espejo tipado,
   no genera migraciones. Enums de Postgres y de `shared/enums.ts` deben coincidir. Desde 0009 los
   privilegios por defecto no otorgan nada: cada tabla nueva declara sus `GRANT` a `guardia_app` (UPDATE por
   columna, sin DELETE salvo que haga falta) y su RLS. Ninguna PK de texto. Correos de operador en minúsculas
   (CHECK `operator_email_lower`).
8. **Errores de API**: `AppError(code, message, details?)` con códigos de `shared` (`ERROR_CODES`).
   Validación con zod vía `zod(Schema)` en controladores.
9. **Central**: selectores de zustand devuelven primitivos o referencias estables; derivar listas con
   `useMemo`. Contenido del vecino (transcripción, texto, notas) siempre como texto, nunca HTML.
   Vocabulario de la UI en `src/lib/labels.ts`; una sola palabra por concepto.
10. **Administración**: el guard toma rol y estado del operador desde la base (`OperatorStatusService`,
    caché 30 s; invalidar tras cambiar una cuenta), no del JWT. Toda acción de administración escribe
    `audit_log` en la MISMA transacción (`AuditService.record(tx, …)`); `audit_log` es de solo inserción.
    Contraseña temporal → solo `@AllowPendingPassword()` pasa. Los contactos se desactivan, no se borran.
11. **Incidentes** (migración 0004): alertas de la misma situación se agrupan (reglas en
    `shared/schemas/incident.ts`); la importancia sale de `incidentImportance` (reglas explícitas, un SOS
    nunca baja de MEDIA). Agrupar va DESPUÉS del commit con tope de 200 ms y es idempotente (el worker
    reintenta); nunca bloquea el SOS. La central muestra una tarjeta por situación, de la más nueva a la
    más antigua y sin ocultar ninguna; la importancia informa y regula el sonido, no filtra.
12. **Agente de clasificación** (migración 0005, `TRIAGE_VERSION` en shared): modelo → `normalizeClassification`
    → `applyTriageRules`; las reglas fijas (`shared/src/triage-rules.ts`) solo suben prioridad, agregan
    instituciones y marcan señales, y solo reemplazan la categoría genérica (o la que declaran en `replaces`). La clasificación del operador
    (`triage_label`) manda: el worker no la pisa al reanalizar. Cambiar el prompt o las reglas es cambiar de
    versión: correr `eval:triage` antes y después; el recall de riesgo vital no puede bajar del 100 %.
    `erase_citizen` borra `ai_triage` (repite lo que dijo el vecino). Si la IA falla del todo, el worker
    clasifica con el clasificador sin red + reglas (queda `FAILED`, no "sin clasificar").
13. **Redirección entre municipios** (migración 0006, `geo/`, `AUTO_TRANSFER` en shared): el agente traspasa
    solo si el vecino nombra una comuna atendida por otro municipio de Guard-IA, el hecho ocurre lejos de él
    o está a menos de 3 km de esa comuna, la alerta sigue nueva y la central de destino tiene operadores
    conectados; si no, la central ve la sugerencia y traspasa a mano. Solo alertas abiertas sin despacho.
    Tras el traspaso: `alert.transferred` a origen, `alert.created` a destino, aviso al vecino.
14. **Uso indebido y terreno** (migración 0008, `docs/plan-plataforma.md` §5b y §5c): solo `FALSE_ALARM`
    (aviso falso intencional) es falta del vecino: exige evidencia escrita (≥ 10 caracteres), queda en
    `citizen_strike` por 90 días y escala la advertencia; `ACCIDENTAL`, `MISREPORTED`, duplicada, etc. no
    sancionan. El diálogo de rechazo no trae motivo marcado. Lo que se le dice al vecino vive en
    `shared/src/citizen-notices.ts` (push y app). La central registra lo que informa la unidad
    (`dispatch.outcome`); "era otra situación" corrige la categoría como clasificación de terreno
    (`triage_label.field_*`) y "falsa alarma confirmada" permite rechazar una alerta ya despachada.
    Una prueba (`TEST`) repetida en 90 días también es falta.
15. **Producción**: `validateEnv` rechaza `STORAGE_DRIVER=local`, `OTP_DEBUG_ENDPOINT=true`,
    `SMS_PROVIDER=console`, secretos por defecto, la falta de `PLATFORM_JWT_SECRET`/`PLATFORM_ENCRYPTION_KEY`
    (distintos entre sí y del de la API) y `PLATFORM_TOTP_REQUIRED=false` (solo desarrollo: la consola entra
    sin segundo factor). No lo relajes.
16. **Plataforma** (migración 0010, `docs/plan-plataforma.md` P1): contexto RLS `platform` (`DbService.asPlatform`)
    que ve municipios, comunas y sus tablas, y de las cuentas del municipio solo las de ADMIN; nunca alertas,
    vecinos ni casos: las cifras salen de funciones SECURITY DEFINER que devuelven conteos
    (`platform_tenant_activity`, `platform_unserved`, `tenant_readiness`). El estado del municipio
    (`tenant.status`; `active` es generada = ACTIVE o SUSPENDED) solo cambia con `set_tenant_status()`, que valida
    transiciones, la lista de puesta en marcha y que no haya alertas abiertas al dar de baja; el alta solo con
    `create_tenant()`. ONBOARDING solo rutea teléfonos de prueba (`tenant_test_phone`); SUSPENDED nunca corta el
    SOS (solo bloquea cuentas nuevas); TERMINATED deja la comuna fuera de cobertura y sus cuentas sin acceso.
    Toda acción escribe `platform_audit_log` en la misma transacción y, si toca un municipio, también su
    `audit_log` con `platform_actor_id` (la central lo muestra como "Equipo Guard-IA"). Tokens, secreto y
    sesiones de la consola no se mezclan con los de vecinos y operadores; segundo factor TOTP obligatorio.
17. **Restricción y bloqueo** (migración 0011, `accounts/`): con 2 faltas vigentes la cuenta queda restringida; con 3
    se propone un bloqueo (`citizen_block` PROPOSED; 30 días, 180 si ya cumplió uno en el último año; sin plazo solo
    ADMIN) que decide otra persona (SUPERVISOR o ADMIN; CHECK `citizen_block_two_people_chk`). El trigger
    `alert_account` (BEFORE INSERT, corre antes que el ruteo) rechaza toda alerta de una cuenta bloqueada (GIA10 →
    `ACCOUNT_BLOCKED`) y el reporte urbano de una restringida (GIA11 → `ACCOUNT_RESTRICTED`), y marca
    `alert.citizen_restricted`. **Nunca toca `priority`**: el vecino inserta sin prioridad (política
    `alert_citizen_insert`); el worker deja en media el SOS restringido o de baja confianza salvo frase de riesgo
    vital (`capPriority`, `hasCriticalPhrase`). La app bloqueada solo muestra los números de emergencia, el plazo y
    "Pedir revisión" (`citizen_review`, la resuelve el municipio que sancionó). Cada decisión escribe `audit_log` en
    la misma transacción; el aviso (`account.updated` por WS y push) va después del commit.
18. **Terreno** (migración 0012, `field/`, `docs/plan-plataforma.md` §5c): cada funcionario con su cuenta (rol
    `FIELD`) en `/terreno`. **Denegado por defecto**: `AuthGuard` lo deja pasar solo donde `@Roles` nombra `FIELD`
    (`/ops/field/*` y cambiar su contraseña); el socket `/ops` lo rechaza y usa `/field`, que no trae datos del caso
    (`field.refresh` hace que la página relea su estado). Todo lo suyo corre en el contexto RLS `field`
    (`DbService.asField`): su turno, su unidad (`app_field_unit()`), y el caso al que la despacharon
    (`field_can_see_alert()`); nunca vecinos, la cola ni otros casos. Lo que se emite a la central se lee después
    del commit en contexto system. La unidad informa y la central cierra (RT-8): un informe no resuelve ni rechaza
    la alerta; "era otra situación" queda en `dispatch.proposed_category` hasta que la central la aplica;
    `dispatch.outcome_via` dice quién informó. Avisos (`field_alarm`): pánico (nunca se limita; con o sin turno),
    apoyo y plazos vencidos (`FieldWatchCron`, `FIELD_DEADLINES`, solo unidades con alguien de terreno en turno); el
    trigger `dispatch_field_alarm_clear` cierra los plazos cuando el despacho se mueve. La posición se guarda solo con
    un despacho abierto (última posición de la unidad, sin historial).
19. **Áreas** (migración 0013, `areas/`, `/admin/areas`): las define el administrador municipal: nombre, la que
    recibe los SOS (una sola, siempre activa), qué categoría o subcategoría urbana atiende cada una y qué cuentas
    pertenecen a cuál. Las categorías son nacionales (`shared`); el municipio solo decide quién las atiende. Al
    insertar, el trigger `alert_set_area` fija el área (`area_for`); al clasificar, `refresh_alert_area()` la recalcula
    (salvo que una persona la haya reasignado: `area_source = 'OPERATOR'` manda), fija `security_relevant` (solo
    urbanos: marca del agente o regla `SEGURIDAD_EN_REPORTE`) y deja el evento `AREA_CHANGED`. La única vía para mover
    una alerta de área a mano es `reassign_alert_area()` (SECURITY DEFINER, evento y `audit_log`). Lo que ve cada
    cuenta lo deciden políticas RESTRICTIVE en `alert` y sus tablas hijas (`operator_sees_all()`,
    `operator_area_ids()`, `operator_in_sos_area()`): ADMIN, modo compartido (`tenant_area_mode`, la excepción) o
    municipio sin áreas activas → todo; si no, sus áreas, las alertas sin área y, si es del área de los SOS, los
    reportes con carácter de seguridad. Una cuenta sin área en un municipio con áreas solo ve alertas sin área.
    Emisiones por sala (`alerts:{tenant}`, `area:{id}`, `security:{tenant}`); quien deja de ver una alerta recibe
    `alert.removed`. Si cambia lo que ve una cuenta (áreas, rol, modo), `reconnectOperators` corta su socket y la
    central relee `/ops/me` y recarga la cola. Tras un cambio de área, la ficha que se emite se lee en contexto system
    después del commit. Rol `ASSISTANT` (apoyo administrativo): consulta, notas, panel y bitácora; nunca acciones
    sobre la alerta (`OPERATING_ROLES` en `@Roles`). Las reglas nuevas rigen para alertas nuevas; despachos, unidades y
    avisos de terreno siguen yendo a todo el municipio (`tenant:{id}`).
20. **Ley 21.719** (migración 0014, `legal/`, `docs/plan-ley-21719.md`): **ningún dato real fuera de producción** (ni en local,
    tests, `eval:triage`, capturas ni prompts). Lo que se le dice al vecino sobre sus datos sale de `buildLegalNotice` (shared) con
    la configuración vigente (`GET /legal/notice`): nunca un proveedor escrito a mano; si cambia lo que el sistema hace, cambia
    el texto y sube `CONSENT_VERSION`. Aceptar exige la versión vigente y el hash del aviso mostrado; cada aceptación o revocación
    es una fila de `consent_record` (solo inserción) que apunta al texto guardado (`consent_notice`). El SOS nunca depende del
    consentimiento vigente (basta `consent_at`). El contenido de una alerta solo va a la IA externa si el vecino no se opuso
    (`citizen.external_ai`) y el municipio autorizó por escrito a ese proveedor (`tenant_subprocessor`, `AI_PROCESSOR_KEY`);
    si no, el worker clasifica sin red y deja `ai_status = LOCAL` (no es falla). Los avisos push de cuenta y las advertencias van
    neutros (`ACCOUNT_PUSH`, `alertPushText`): el detalle solo dentro de la app. Logs sin coordenadas ni contenido del vecino
    (huella: largo y hash). El municipio fija su contacto de privacidad (`tenant_privacy`, ADMIN) y registra su reporte de cada
    incidente; Guard-IA lleva el registro de incidentes y avisa (consola). La puesta en marcha exige contratos con referencia,
    evaluación de impacto, contacto de privacidad y subencargados en uso autorizados. Respaldos: `backup.sh` cifra con `age` y
    no respalda sin `BACKUP_AGE_RECIPIENT`; restaurar en `infra/RESTAURAR.md`.

## Decisiones tomadas (resumen; detalle en README y docs)

NestJS 11 CommonJS (no 12, es ESM-only). Drizzle sobre postgres-js. `lat/lng` como columnas +
`location` generada. Push Expo por HTTP sin SDK. Storage `local` solo en desarrollo/CI. IA `mock` si
no hay `OPENAI_API_KEY`. Email de operador único global. Una sola central con filtro por tipo y por área (no una
app separada para Obras/Aseo); desde 0013 (14-10-2026) cada cuenta ve solo las alertas de sus áreas, lo que
reemplaza la decisión anterior de "dashboard único para todos" (la excepción del municipio, modo compartido, la
recupera). Cursor de la central `(prioridad, created_at µs, id)`.
`NEXT_PUBLIC_API_URL` se fija en el build de la central (una imagen por entorno).
Marca: colores del logo en `apps/mobile/src/theme.ts` (`brand`, `color`) y `apps/command/app/globals.css`
(mismos valores; el rojo queda solo para SOS/prioridad alta). Íconos y símbolo generados desde
`apps/mobile/assets/brand/guardia-logo.png`.

## Preguntas abiertas (sección 13 del doc de Fase 0; lecturas provisionales en vigor)

- Proveedor SMS: `console` en dev; Twilio por REST implementado, sin probar con cuenta real.
- Municipio piloto: seed con "Municipio Demo" (rectángulo del Gran Santiago); cargar el real con
  `pnpm seed --geojson limite.geojson --name "..." --slug ...`.
- Audio ambiente de 15 s: un clip (Fase 3); encadenado post-piloto.
- VPS y dominios: `.env.production.example` y `infra/HOSTINGER.md` (VPS de Hostinger).
- Repositorio: GitHub **público** `TESTMODOPACK/GUARD-IA` (`origin`, rama `main`, desde el 18-10-2026). Todo lo que se
  sube es visible: nunca secretos ni datos reales. El VPS lo clona sin credenciales; los secretos viven solo en el
  `.env` del servidor.

## App del vecino (apps/mobile) — cómo está hecha

`pnpm mobile` (en PowerShell: `pnpm.cmd mobile`; si cambian dependencias o rutas: `--clear`). Rutas en
`src/app` con `Stack.Protected`: sin sesión → `login`/`verify`; sin `CONSENT_VERSION` vigente →
`consent`; si no → `index`, `sos`, `voice`, `discreet`, `report`, `alert/[id]`, `cases`, `privacy` (Mis datos: export y supresión),
`account` (Estado de tu cuenta y pedir revisión); con la cuenta bloqueada solo `blocked`, `account` y `privacy`. Sesión en
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

- Base de datos: informe en `docs/revision-base-de-datos.md`. `0009_hardening.sql` aplicada en local (PK de
  texto corregidas, índices por municipio, privilegios, FK compuestas, RLS de `tenant` + `tenant_directory`,
  `MaintenanceCron`). Falta la migración de escala (particionado de `alert_event` y `audit_log`, `uuidv7`; toma el
  siguiente número libre), antes del piloto; `0010` es la consola de plataforma, `0011` el bloqueo por uso indebido, `0012`
  terreno, `0013` áreas y `0014` privacidad (Ley 21.719, etapa 1).
- Áreas (0013): las alertas que ya estaban abiertas al definir o cambiar reglas no se mueven solas (se pasan a mano
  desde la ficha). Un incidente puede agrupar alertas de áreas distintas (la tarjeta muestra el área de la que lo
  representa). En el municipio demo, `camila.rojas` no tiene área (solo ve alertas sin área); `aseo@demo` es de Aseo y
  ornato y Alumbrado.
- Comunas: cargadas en la base local las 345 de la DPA 2023 de SUBDERE (Antártica no viene en el archivo).
  Procedimiento en `docs/entorno-local.md` ("Comunas de Chile"); hay que repetirlo en cada base nueva (VPS).
  El ruteo usa `comuna_part` (trozos de ≤ 256 vértices, migración 0007): < 1 ms en todo el país.
- Groq gratis: la cuota diaria de tokens se agota con unas 100 clasificaciones de prueba; para el piloto
  hace falta el plan pagado o un proveedor con más cuota (si se agota, rige el respaldo por reglas).
- Plataforma y operación (borrador 1, 13-10-2026): `docs/plan-plataforma.md` (consola de superadministrador por
  región, planes, contratos, facturación, bitácora de errores, métricas; uso indebido con escalera de faltas;
  unidad en terreno que informa resultados). Etapas 1 (motivos de rechazo, faltas, resultado en terreno),
  2 (endurecimiento 0009 y consola P1) y 3 (resto de PU: restricción, bloqueo con aprobación, "Estado de tu cuenta" y
  revisión) hechas el 13-10-2026. Terreno (PT, 0012) hecho el 14-10-2026 salvo PT-4: Web Push con el teléfono
  bloqueado e instalación como app (hoy suena y vibra con la página abierta). Áreas municipales (PA, 0013) hechas el
  14-10-2026. Siguen P2 (errores y salud) y P3; decisiones en §9.
- Consola de plataforma (P1) sin hacer aún: QR para el segundo factor (hoy la clave se escribe a mano o se abre
  el enlace `otpauth://` en el teléfono; un QR requiere agregar una librería), estado "En negociación" y asignación
  comercial (RF-1.5), acceso de soporte (RF-4.4), avisos por correo al suspender. La primera alerta tras 30 s sin
  uso paga la conexión nueva del pool y la primera ejecución del trigger de ruteo (~100 ms); en caliente, < 10 ms.
- Plan en curso: `docs/plan-desarrollo-local.md` (etapas 0–3 hechas; etapa 4 en curso). Para el piloto se sigue
  ese plan; la arquitectura de escala nacional quedó en un informe aparte (Artifact "Arquitectura de escala
  Guard-IA") y se retoma después del piloto.
  Entorno: `docs/entorno-local.md` (Postgres/Redis en WSL; `pnpm infra:wsl` + `pnpm dev`).
- Media en el VPS: la API sube a `http://minio:9000` y firma con `S3_PUBLIC_ENDPOINT` (`https://MEDIA_DOMAIN`,
  MinIO detrás de Caddy, solo GET/HEAD; ya en la CSP). Falta probarlo en un VPS real (no hay Docker local).
- `next build` con `output: 'standalone'` falla en Windows al copiar node_modules enlazados por pnpm
  (symlinks); compila bien y la imagen Docker se construye en Linux. CSP de la central sin nonce.
- ARCO hecho (API `GET /me/export` y `DELETE /me` por anonimización, migración 0002; app: pantalla `privacy` "Mis datos", probada en web). En el teléfono el export se entrega con el menú Compartir como texto; un archivo .json requiere `expo-file-system` + `expo-sharing`.
- Twilio, MinIO/S3 y push Expo reales no se han ejercitado con cuentas reales.
