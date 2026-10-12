#!/usr/bin/env bash
# Instala y prepara Postgres 16 + PostGIS y Redis de desarrollo en Ubuntu (WSL), como root.
# Uso (desde Windows, en la raíz del repo, con el .env ya creado):
#   wsl -d Ubuntu-24.04 -u root -- bash infra/dev/wsl-setup.sh .env
set -euo pipefail
ENV_FILE="${1:-.env}"

export DEBIAN_FRONTEND=noninteractive
if ! command -v psql >/dev/null || ! command -v redis-server >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq postgresql-16 postgresql-16-postgis-3 redis-server >/dev/null
fi

service postgresql start >/dev/null
service redis-server start >/dev/null

# Contraseña del dueño tomada de DATABASE_ADMIN_URL del .env.
PW="$(sed -n 's|^DATABASE_ADMIN_URL=postgres://postgres:\([^@]*\)@.*|\1|p' "$ENV_FILE")"
[ -n "$PW" ] || { echo "No encontré DATABASE_ADMIN_URL en $ENV_FILE"; exit 1; }
su postgres -c "psql -q -v pw='$PW'" <<'SQL'
ALTER ROLE postgres WITH PASSWORD :'pw';
SQL

if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='guardia'\"" | grep -q 1; then
  su postgres -c "createdb guardia"
fi

echo "Base: $(su postgres -c "psql -d guardia -tAc 'SELECT current_database()'") · Redis: $(redis-cli ping)"
echo "Siguiente: pnpm migrate && pnpm seed"
