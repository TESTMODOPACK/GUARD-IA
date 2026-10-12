#!/usr/bin/env bash
# Backup diario: pg_dump comprimido + espejo del bucket de media (sección 10).
# Programar con cron en el VPS:  15 3 * * * /opt/guard-ia/infra/backup.sh >> /var/log/guardia-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

STAMP=$(date +%Y%m%d-%H%M)
DEST=${BACKUP_DIR:-./data/backups}
mkdir -p "$DEST"

docker compose exec -T db pg_dump -U postgres -d guardia --no-owner --format=custom \
  > "$DEST/guardia-$STAMP.dump"

# Espejo del bucket a un destino externo compatible S3 (R2, B2, S3) si está configurado.
# El contenedor de mc es efímero: los dos alias se crean en cada corrida. Las llaves viajan como
# variables de entorno (comillas simples: se expanden dentro del contenedor, no en la línea de comandos).
if [[ -n "${BACKUP_S3_URL:-}" ]]; then
  docker compose run --rm -T --entrypoint sh \
    -e BACKUP_S3_URL -e BACKUP_S3_ACCESS_KEY -e BACKUP_S3_SECRET_KEY -e BACKUP_S3_BUCKET \
    minio-init -c '
      mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null &&
      mc alias set backup "$BACKUP_S3_URL" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null &&
      mc mirror --overwrite "local/$S3_BUCKET" "backup/${BACKUP_S3_BUCKET:-guardia-media-backup}"
    '
fi

# Retención 30 días.
find "$DEST" -name 'guardia-*.dump' -mtime +30 -delete
echo "[$(date -Is)] backup ok: $DEST/guardia-$STAMP.dump"
