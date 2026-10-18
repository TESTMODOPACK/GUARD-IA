#!/usr/bin/env bash
# Backup diario: pg_dump cifrado + copia externa de la base y espejo del bucket de media (sección 10).
# Programar con cron en el VPS:  15 3 * * * /opt/guard-ia/infra/backup.sh >> /var/log/guardia-backup.log 2>&1
#
# Ley 21.719 (art. 14 quinquies): el dump sale cifrado con age y nunca se escribe en claro. En el VPS solo vive
# la clave PÚBLICA (BACKUP_AGE_RECIPIENT); la privada se guarda fuera del servidor y solo se usa para restaurar
# (procedimiento en infra/RESTAURAR.md). Sin clave pública el script no respalda: un respaldo en claro es peor que
# ninguno. Requiere `age` en el VPS (apt install age).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

if [[ -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  echo "[$(date -Is)] backup NO realizado: falta BACKUP_AGE_RECIPIENT (clave pública age) en .env" >&2
  exit 1
fi
command -v age >/dev/null || { echo "[$(date -Is)] backup NO realizado: falta age (apt install age)" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M)
DEST=${BACKUP_DIR:-./data/backups}
mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd)
FILE="guardia-$STAMP.dump.age"

# Se escribe a un .partial y se renombra al final: un respaldo a medias nunca parece válido.
docker compose exec -T db pg_dump -U postgres -d guardia --no-owner --format=custom \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$DEST/$FILE.partial"
mv "$DEST/$FILE.partial" "$DEST/$FILE"

# Copia externa compatible S3 (R2, B2, S3) si está configurada: la base cifrada y el espejo de la media.
# El contenedor de mc es efímero: los alias se crean en cada corrida. Las llaves viajan como variables de entorno
# (comillas simples: se expanden dentro del contenedor, no en la línea de comandos).
#
# El espejo usa --remove: lo que la purga borró (audio y fotos a los 90 días, supresión de una cuenta) también se
# borra del respaldo. Para no perder la media por un borrado accidental en el origen, activar en el bucket de
# respaldo el versionado con vencimiento de versiones no vigentes a 30 días (se configura en el proveedor).
if [[ -n "${BACKUP_S3_URL:-}" ]]; then
  docker compose run --rm -T --entrypoint sh \
    -v "$DEST:/backups:ro" \
    -e BACKUP_S3_URL -e BACKUP_S3_ACCESS_KEY -e BACKUP_S3_SECRET_KEY -e BACKUP_S3_BUCKET -e BACKUP_S3_DB_BUCKET \
    -e FILE="$FILE" \
    minio-init -c '
      set -e
      DB_BUCKET="${BACKUP_S3_DB_BUCKET:-guardia-db-backup}"
      mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
      mc alias set backup "$BACKUP_S3_URL" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
      mc cp --quiet "/backups/$FILE" "backup/$DB_BUCKET/$FILE"
      mc rm --recursive --force --older-than 30d "backup/$DB_BUCKET/" >/dev/null || true
      mc mirror --quiet --overwrite --remove "local/$S3_BUCKET" "backup/${BACKUP_S3_BUCKET:-guardia-media-backup}"
    '
fi

# Retención local 30 días (incluye los dump en claro que hubiera dejado la versión anterior del script).
find "$DEST" -name 'guardia-*.dump*' -mtime +30 -delete
find "$DEST" -name 'guardia-*.partial' -mmin +120 -delete
echo "[$(date -Is)] backup ok: $DEST/$FILE"
