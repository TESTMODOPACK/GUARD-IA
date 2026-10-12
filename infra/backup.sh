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

# Espejo del bucket a un destino externo si está configurado (R2/B2 compatibles S3).
if [[ -n "${BACKUP_S3_ALIAS:-}" ]]; then
  docker compose run --rm -T minio-init sh -c \
    "mc alias set local http://minio:9000 $S3_ACCESS_KEY $S3_SECRET_KEY && mc mirror --overwrite local/${S3_BUCKET:-guardia-media} ${BACKUP_S3_ALIAS}/guardia-media"
fi

# Retención 30 días.
find "$DEST" -name 'guardia-*.dump' -mtime +30 -delete
echo "[$(date -Is)] backup ok: $DEST/guardia-$STAMP.dump"
