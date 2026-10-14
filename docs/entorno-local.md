# Entorno local (Windows + WSL)

Postgres 16 + PostGIS y Redis corren en Ubuntu dentro de WSL2; la API, la central y Metro (Expo)
corren en Windows y se conectan por `localhost`.

## Primera vez

```powershell
wsl --install -d Ubuntu-24.04 --no-launch      # una vez; puede pedir reiniciar Windows
```

```bash
cp .env.example .env                            # luego cambiar contraseñas y JWT_ACCESS_SECRET (32+)
wsl -d Ubuntu-24.04 -u root -- bash infra/dev/wsl-setup.sh .env
pnpm install && pnpm build
pnpm migrate && pnpm seed
```

En `.env` de desarrollo: `AI_PROVIDER=mock` (sin clave de OpenAI), `SMS_PROVIDER=console` y
`OTP_DEBUG_ENDPOINT=true` (el código OTP aparece en la consola de la API).

## Cada día

```bash
pnpm infra:wsl        # terminal 1: levanta Postgres y Redis y mantiene WSL encendido
pnpm dev              # terminal 2: API en :3000, central en :3001 y consola de plataforma en :3002
```

Comprobar: `curl localhost:3000/v1/health` → `{"ok":true,"db":true,"redis":true,…}`.

## Pruebas

```bash
pnpm typecheck
pnpm test             # unitarios (los de base quedan omitidos)
pnpm test:db          # RLS y geocerca contra la base real
pnpm simulate --text "me están asaltando en la plaza"
```

## Teléfono en la misma red (etapa 3)

La app usa la IP local del equipo (`ipconfig` → IPv4), no `localhost`. Windows debe permitir el
puerto 3000 en red privada; en PowerShell **como administrador**:

```powershell
New-NetFirewallRule -DisplayName "Guard-IA API (dev)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -Action Allow
```

## Terreno en el navegador (migración 0012)

La central guarda la sesión en `localStorage`: en el mismo origen, entrar como funcionario de terreno cierra la
sesión del operador en las otras pestañas. Para probar las dos a la vez, abre `/terreno` en
`http://terreno.localhost:3001` (otro origen; Next lo permite en desarrollo) y agrega ese origen a `CORS_ORIGINS` del
`.env` (reinicia la API). La cuenta de terreno se crea en la central (Usuarios → rol Terreno). El navegador de
escritorio no tiene GPS: la posición y el pánico llegan sin ubicación (la página lo dice). En un teléfono de la misma
red, Next en desarrollo bloquea la página si la IP no está en `allowedDevOrigins` (`apps/command/next.config.ts`),
y la ubicación exige HTTPS; sin HTTPS se prueba el resto del flujo.

## Comunas de Chile (migraciones 0006 y 0007)

El ruteo por comuna, el traspaso entre municipios y el aviso "estás en la comuna X" necesitan la tabla
nacional de comunas. Fuente oficial: División Político Administrativa 2023 de SUBDERE
(`https://ide.subdere.gov.cl/descargas/SHP/Limite_DPA_03082023.rar`, 262 MB, publicada el 21-02-2024;
anuncio en subdere.gov.cl/node/82960). Trae 345 comunas en SIRGAS-Chile (Antártica no viene).

Se carga una vez por base (también en el VPS). En WSL, con GDAL (`apt-get install gdal-bin libarchive-tools`):

```bash
mkdir -p ~/dpa && cd ~/dpa
curl -fSLO https://ide.subdere.gov.cl/descargas/SHP/Limite_DPA_03082023.rar
bsdtar -xf Limite_DPA_03082023.rar DPA_2023/COMUNAS
# WGS84 y simplificado a ~9 m (bajo el error del GPS): de 109 MB a 56 MB
ogr2ogr -f GeoJSON -t_srs EPSG:4326 -simplify 0.00008 -lco COORDINATE_PRECISION=6 -lco RFC7946=YES   comunas.geojson DPA_2023/COMUNAS/COMUNAS_v1.shp
```

Y desde el repositorio: `pnpm --filter @guardia/api load-comunas --geojson <ruta>/comunas.geojson` (detecta
`CUT_COM`, `COMUNA`, `CUT_REG` y `REGION`; tarda ~1 min). Rehace también `comuna_part`. Para enlazar un municipio
con su comuna, fija `tenant.cut_code` con el CUT (p. ej. `13201` Puente Alto) y vuelve a correr el comando.



- `Variables de entorno inválidas`: falta `.env` en la raíz del repo.
- `ECONNREFUSED 5432`: WSL se apagó; vuelve a correr `pnpm infra:wsl`.
- Reiniciar la base desde cero: `wsl -d Ubuntu-24.04 -u root -- su postgres -c "dropdb guardia && createdb guardia"`, luego `pnpm migrate && pnpm seed`.
