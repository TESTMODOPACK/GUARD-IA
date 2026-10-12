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
pnpm dev              # terminal 2: API en :3000 y central en :3001
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

## Problemas comunes

- `Variables de entorno inválidas`: falta `.env` en la raíz del repo.
- `ECONNREFUSED 5432`: WSL se apagó; vuelve a correr `pnpm infra:wsl`.
- Reiniciar la base desde cero: `wsl -d Ubuntu-24.04 -u root -- su postgres -c "dropdb guardia && createdb guardia"`, luego `pnpm migrate && pnpm seed`.
