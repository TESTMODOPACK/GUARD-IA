#!/usr/bin/env bash
# Instalación de Guard-IA en un VPS Ubuntu (Hostinger u otro), como root. En un servidor nuevo, un solo comando
# (clona el repositorio en /opt/guard-ia y sigue desde ahí):
#   curl -fsSL https://raw.githubusercontent.com/TESTMODOPACK/GUARD-IA/main/infra/install.sh | bash
# Con el repositorio ya clonado:
#   bash /opt/guard-ia/infra/install.sh              instala o completa la instalación
#   bash /opt/guard-ia/infra/install.sh --env-only   solo prepara el .env y termina
#
# Hace: .env con secretos al azar (pregunta lo demás), Docker y herramientas, memoria de intercambio si falta,
# revisión del DNS, contenedores, primer superadministrador de la consola, comunas de Chile y respaldo diario.
# Se puede repetir: no cambia secretos ya generados, no vuelve a preguntar lo que ya está en .env y salta lo hecho.
#
# Sin preguntas: cada respuesta puede venir como variable de entorno con el nombre de la clave del .env, más
# DOMAIN (dominio principal), ADMIN_EMAIL, ADMIN_NAME, LOAD_COMUNAS (s/n) y ASSUME_YES=1. Una variable definida
# aunque vacía cuenta como respuesta. Ejemplo:
#   DOMAIN=midominio.cl PRIVACY_CONTACT_EMAIL=privacidad@midominio.cl ... bash infra/install.sh
# Guía completa: infra/HOSTINGER.md.
set -euo pipefail

ENV_ONLY=0
if [[ "${1:-}" == "--env-only" ]]; then ENV_ONLY=1; fi

# Arranque: si el script llegó por curl | bash (no hay archivo propio) o está fuera del repositorio, clona o
# actualiza el repositorio y corre su copia. Las preguntas leen de /dev/tty, así que la entrada estándar sobra.
REPO_URL=${REPO_URL:-https://github.com/TESTMODOPACK/GUARD-IA.git}
INSTALL_DIR=${INSTALL_DIR:-/opt/guard-ia}
self=${BASH_SOURCE[0]:-}
if [[ -z "$self" || ! -f "$(dirname "$self")/../docker-compose.yml" ]]; then
  if [[ $EUID -ne 0 ]]; then
    echo "Corre el instalador como root." >&2
    exit 1
  fi
  if ! command -v git >/dev/null; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git
  fi
  # Permisos normales para el código: las imágenes corren con un usuario sin privilegios que debe poder leerlo.
  umask 022
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" pull --ff-only
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  exec bash "$INSTALL_DIR/infra/install.sh" "$@" </dev/null
fi

cd "$(dirname "$self")/.."
ROOT=$(pwd)
# Lo que crea el instalador (.env y sus temporales) queda solo para root.
umask 077

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2
  exit 1
}

# Lee de la terminal aunque el script llegue por una tubería. La pregunta va a stderr; la respuesta, a stdout.
prompt() { # prompt "Pregunta" [secret]
  local answer
  if [[ "${2:-}" == secret ]]; then
    read -r -s -p "$1: " answer </dev/tty
    echo >&2
  else
    read -r -p "$1: " answer </dev/tty
  fi
  printf '%s' "$answer"
}

get_env() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- || true; }

# Reemplaza la línea CLAVE=… (o la agrega) sin pasar el valor por sed: admite cualquier carácter salvo saltos de línea.
set_env() { # set_env CLAVE valor
  local tmp
  tmp=$(mktemp "$ROOT/.env.XXXXXX")
  if grep -q "^$1=" .env; then
    KEY="$1" VAL="$2" awk 'index($0, ENVIRON["KEY"] "=") == 1 { print ENVIRON["KEY"] "=" ENVIRON["VAL"]; next } { print }' .env >"$tmp"
  else
    cat .env >"$tmp"
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
  fi
  mv "$tmp" .env
}

# Un valor de ejemplo (example.cl) cuenta como no definido.
is_set() {
  local v
  v=$(get_env "$1")
  [[ -n "$v" && "$v" != *example.cl* ]]
}

# ask CLAVE "Pregunta" [secret]: solo si la clave aún no tiene valor. Toma la variable de entorno si existe.
ask() {
  local key=$1 value
  if is_set "$key"; then return 0; fi
  if [[ -n "${!key+x}" ]]; then value=${!key}; else value=$(prompt "$2" "${3:-}"); fi
  if [[ -n "$value" ]]; then set_env "$key" "$value"; fi
}

confirm() { # confirm "Pregunta (s/N)"
  if [[ "${ASSUME_YES:-}" == 1 ]]; then return 0; fi
  [[ $(prompt "$1") == [sS]* ]]
}

secret() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40; }

[[ -f docker-compose.yml && -f .env.production.example ]] ||
  die "No encuentro docker-compose.yml: corre el instalador desde el repositorio clonado."

# --- 1. Configuración -------------------------------------------------------------------------------------------
say "Configuración (.env)"
if [[ ! -f .env ]]; then
  cp .env.production.example .env
  echo "  Creado .env desde .env.production.example."
fi
chmod 600 .env

for k in POSTGRES_PASSWORD APP_DB_PASSWORD JWT_ACCESS_SECRET PLATFORM_JWT_SECRET PLATFORM_ENCRYPTION_KEY \
  S3_SECRET_KEY LOCAL_STORAGE_SECRET METRICS_TOKEN; do
  if ! is_set "$k"; then
    set_env "$k" "$(secret)"
    echo "  $k: generado al azar"
  fi
done

if ! is_set API_DOMAIN || ! is_set CENTRAL_DOMAIN || ! is_set PLATFORM_DOMAIN || ! is_set MEDIA_DOMAIN; then
  base=${DOMAIN:-}
  if [[ -z "$base" ]]; then
    base=$(prompt "Dominio principal (ej. midominio.cl; se usan api., central., plataforma. y media.)")
  fi
  base=${base#https://}
  base=${base#http://}
  base=${base%/}
  [[ "$base" == *.* && "$base" != *" "* ]] || die "Dominio inválido: '$base'"
  is_set API_DOMAIN || set_env API_DOMAIN "api.$base"
  is_set CENTRAL_DOMAIN || set_env CENTRAL_DOMAIN "central.$base"
  is_set PLATFORM_DOMAIN || set_env PLATFORM_DOMAIN "plataforma.$base"
  is_set MEDIA_DOMAIN || set_env MEDIA_DOMAIN "media.$base"
fi
API=$(get_env API_DOMAIN)
CENTRAL=$(get_env CENTRAL_DOMAIN)
PLATFORM=$(get_env PLATFORM_DOMAIN)
MEDIA=$(get_env MEDIA_DOMAIN)
is_set PUBLIC_API_URL || set_env PUBLIC_API_URL "https://$API"
is_set CORS_ORIGINS || set_env CORS_ORIGINS "https://$CENTRAL,https://$PLATFORM"
echo "  Dominios: $API, $CENTRAL, $PLATFORM, $MEDIA"

ask PRIVACY_CONTACT_EMAIL "Correo de contacto de privacidad para los vecinos (obligatorio, Ley 21.719)"
is_set PRIVACY_CONTACT_EMAIL || die "PRIVACY_CONTACT_EMAIL es obligatoria."
ask PRIVACY_POLICY_URL "URL de la política de privacidad (Enter para dejarla en blanco)"

ask TWILIO_ACCOUNT_SID "Twilio Account SID (AC…; Enter si aún no tienes cuenta)"
ask TWILIO_AUTH_TOKEN "Twilio Auth Token" secret
ask TWILIO_FROM "Número de Twilio que envía los SMS (formato +56…)"

ask OPENAI_API_KEY "Clave del proveedor de IA (Enter = sin IA externa; el SOS funciona igual)" secret
if is_set OPENAI_API_KEY; then
  ask OPENAI_BASE_URL "URL del proveedor compatible con OpenAI (Enter = OpenAI; Groq: https://api.groq.com/openai/v1)"
  if is_set OPENAI_BASE_URL; then
    warn "Proveedor distinto de OpenAI: revisa OPENAI_CLASSIFY_MODEL y OPENAI_STT_MODEL en .env."
  fi
fi

ask BACKUP_AGE_RECIPIENT "Clave PÚBLICA age para cifrar el respaldo (age1…; Enter para agregarla después)"

missing=()
for k in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM; do
  if ! is_set "$k"; then missing+=("$k"); fi
done
echo "  Configuración guardada en $ROOT/.env (permisos 600)."
if ((ENV_ONLY)); then
  if ((${#missing[@]})); then warn "Falta para arrancar la API: ${missing[*]}"; fi
  exit 0
fi
if ((${#missing[@]})); then
  die "Falta ${missing[*]}: sin Twilio la API no arranca en producción (el código de acceso del vecino va por SMS). Completa .env (nano $ROOT/.env) y vuelve a correr el instalador."
fi

# --- 2. Sistema -------------------------------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Para instalar, corre el script como root (sudo bash infra/install.sh)."

say "Docker y herramientas"
need=()
command -v git >/dev/null || need+=(git)
command -v age >/dev/null || need+=(age)
command -v crontab >/dev/null || need+=(cron)
command -v curl >/dev/null || need+=(curl)
command -v docker >/dev/null || need+=(docker.io docker-compose-v2)
if ((${#need[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${need[@]}"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 no está disponible (apt install docker-compose-v2)."
echo "  $(docker --version)"

say "Memoria"
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if ((mem_mb < 6000 && swap_mb == 0)); then
  if fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    echo "  RAM de ${mem_mb} MB: se agregaron 4 GB de intercambio (/swapfile) para construir las imágenes."
  else
    warn "No se pudo crear /swapfile; con ${mem_mb} MB la construcción puede cortarse por memoria."
  fi
else
  echo "  RAM ${mem_mb} MB, intercambio ${swap_mb} MB."
fi

say "DNS"
ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
dns_ok=1
for d in "$API" "$CENTRAL" "$PLATFORM" "$MEDIA"; do
  got=$(getent ahostsv4 "$d" | awk 'NR == 1 {print $1}' || true)
  if [[ -n "$got" && "$got" == "$ip" ]]; then
    echo "  $d → $got"
  else
    warn "$d apunta a '${got:-nada}'; este servidor es $ip"
    dns_ok=0
  fi
done
if ((!dns_ok)); then
  warn "Crea un registro A por dominio hacia $ip. Caddy reintenta solo, pero sin DNS no hay certificados HTTPS."
  confirm "¿Continuar igual? (s/N)" || exit 1
fi

# --- 3. Contenedores --------------------------------------------------------------------------------------------
say "Contenedores (la primera vez tarda varios minutos: construye la API, la central y la consola)"
if ! docker compose up -d --build; then
  docker compose logs --tail 40 migrate >&2 || true
  die "No se pudieron levantar los contenedores (mensajes arriba)."
fi

say "Esperando a la API"
status=starting
for _ in $(seq 1 60); do
  cid=$(docker compose ps -q api || true)
  if [[ -n "$cid" ]]; then
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")
  fi
  if [[ "$status" == healthy ]]; then break; fi
  sleep 5
done
if [[ "$status" != healthy ]]; then
  docker compose logs --tail 40 api >&2 || true
  die "La API no quedó sana (estado: $status). validateEnv indica arriba qué variable falta o no sirve."
fi
echo "  API sana."

count() { docker compose exec -T db psql -U postgres -d guardia -tAc "$1" | tr -d '[:space:]'; }

# --- 4. Datos iniciales -----------------------------------------------------------------------------------------
say "Consola de plataforma"
users=$(count "SELECT count(*) FROM platform_user")
if [[ "$users" == 0 ]]; then
  email=${ADMIN_EMAIL:-}
  [[ -n "$email" ]] || email=$(prompt "Correo del primer superadministrador de la consola")
  name=${ADMIN_NAME:-}
  [[ -n "$name" ]] || name=$(prompt "Nombre y apellido")
  docker compose run --rm -T migrate node dist/cli/platform-user.js --email "$email" --name "$name" --role SUPERADMIN
  warn "Anota la contraseña temporal de arriba: se muestra una sola vez. Al entrar se cambia y se enrola el segundo factor."
else
  echo "  Ya hay $users cuenta(s) en la consola: no se crea otra."
fi

say "Comunas de Chile"
comunas=$(count "SELECT count(*) FROM comuna")
if ((comunas > 0)); then
  echo "  Ya cargadas ($comunas)."
else
  answer=${LOAD_COMUNAS:-}
  [[ -n "$answer" ]] || answer=$(prompt "¿Descargar de SUBDERE (262 MB) y cargar las 345 comunas ahora? (S/n)")
  if [[ "$answer" != [nN]* ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq gdal-bin libarchive-tools
    dpa=/var/lib/guardia-dpa
    mkdir -p "$dpa"
    chmod 755 "$dpa"
    (
      cd "$dpa"
      [[ -f Limite_DPA_03082023.rar ]] ||
        curl -fSL -o Limite_DPA_03082023.rar https://ide.subdere.gov.cl/descargas/SHP/Limite_DPA_03082023.rar
      bsdtar -xf Limite_DPA_03082023.rar DPA_2023/COMUNAS
      rm -f comunas.geojson
      # WGS84 y simplificado a ~9 m (bajo el error del GPS), igual que en docs/entorno-local.md.
      ogr2ogr -f GeoJSON -t_srs EPSG:4326 -simplify 0.00008 -lco COORDINATE_PRECISION=6 -lco RFC7946=YES \
        comunas.geojson DPA_2023/COMUNAS/COMUNAS_v1.shp
      chmod 644 comunas.geojson
    )
    docker compose run --rm -T -v "$dpa:/datos:ro" migrate node dist/cli/load-comunas.js --geojson /datos/comunas.geojson
  else
    echo "  Pendiente: procedimiento en docs/entorno-local.md («Comunas de Chile»)."
  fi
fi

# --- 5. Respaldo ------------------------------------------------------------------------------------------------
say "Respaldo diario"
backup_dir=$(get_env BACKUP_DIR)
mkdir -p "${backup_dir:-/var/backups/guardia}"
if crontab -l 2>/dev/null | grep -qF "$ROOT/infra/backup.sh"; then
  echo "  Ya programado."
else
  {
    crontab -l 2>/dev/null || true
    echo "15 3 * * * bash $ROOT/infra/backup.sh >> /var/log/guardia-backup.log 2>&1"
  } | crontab -
  echo "  Programado todos los días a las 03:15 (registro en /var/log/guardia-backup.log)."
fi
is_set BACKUP_AGE_RECIPIENT || warn "Falta BACKUP_AGE_RECIPIENT: el respaldo no corre hasta agregarla (ver infra/RESTAURAR.md)."
is_set BACKUP_S3_URL || warn "Sin BACKUP_S3_URL el respaldo queda solo en este servidor."

say "Listo"
cat <<EOF
  Central:               https://$CENTRAL
  Consola de plataforma: https://$PLATFORM
  API:                   https://$API/v1/health

Siguientes pasos:
  1. Guarda fuera del servidor una copia de PLATFORM_ENCRYPTION_KEY (grep PLATFORM_ENCRYPTION_KEY $ROOT/.env):
     si se pierde, todo el equipo debe volver a enrolar el segundo factor.
  2. Entra a la consola, cambia la contraseña temporal y enrola el segundo factor.
  3. Crea el municipio desde la consola (seed.js no va en producción).
  4. En hPanel → VPS → Firewall, deja abiertos solo 22, 80 y 443.

Actualizar a una versión nueva:  cd $ROOT && git pull && docker compose up -d --build
EOF
