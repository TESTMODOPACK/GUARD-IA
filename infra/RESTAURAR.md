# Restaurar un respaldo de Guard-IA

`backup.sh` deja cada noche un `guardia-AAAAMMDD-HHMM.dump.age`: un `pg_dump --format=custom` cifrado con
[age](https://age-encryption.org). Se guarda en `BACKUP_DIR` y, si hay destino externo, también en `BACKUP_S3_DB_BUCKET`.
La media (audio y fotos) se copia en espejo a `BACKUP_S3_BUCKET`.

## Claves

- **Pública** (`age1…`): va en `BACKUP_AGE_RECIPIENT` del `.env` del VPS. Solo sirve para cifrar.
- **Privada** (`clave.txt`, generada con `age-keygen -o clave.txt`): fuera del VPS, en un gestor de contraseñas o
  una bóveda, con al menos dos personas que sepan dónde está. **Nunca se copia al servidor.** Si se pierde, los
  respaldos no se pueden leer. Si se filtra, hay que rotar: generar un par nuevo, cambiar `BACKUP_AGE_RECIPIENT`, y
  tratar el hecho como incidente (`docs/legal/procedimiento-incidentes.md`).

## Restaurar en una base limpia

Desde el equipo que tiene la clave privada. El dump se descifra en ese equipo y viaja por SSH directo a
`pg_restore`, así que en el VPS nunca queda en claro.

Los comandos `docker compose` van en la raíz del repositorio clonado en el VPS (donde están `docker-compose.yml` y
`.env`; en estos ejemplos, `/opt/guard-ia`).

```bash
# 1. En el VPS: base vacía y el rol de la aplicación (pg_dump no incluye roles).
docker compose up -d db
docker compose exec -T db psql -U postgres -c "CREATE ROLE guardia_app LOGIN NOINHERIT NOBYPASSRLS"

# 2. En el equipo con la clave: descifrar y restaurar en un paso.
age -d -i clave.txt guardia-AAAAMMDD-HHMM.dump.age \
  | ssh vps 'cd /opt/guard-ia && docker compose exec -T db pg_restore -U postgres -d guardia --no-owner --exit-on-error'

# 3. En el VPS: migraciones posteriores al respaldo y contraseña del rol (migrate las detecta por schema_migrations).
docker compose run --rm migrate

# 4. Media: del respaldo al bucket local (las variables BACKUP_S3_* se leen del .env y se pasan al contenedor).
set -a; . ./.env; set +a
docker compose run --rm -e BACKUP_S3_URL -e BACKUP_S3_ACCESS_KEY -e BACKUP_S3_SECRET_KEY -e BACKUP_S3_BUCKET \
  --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null &&
  mc alias set backup "$BACKUP_S3_URL" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null &&
  mc mirror --overwrite "backup/$BACKUP_S3_BUCKET" "local/$S3_BUCKET"'

# 5. Levantar el resto y comprobar: la central entra y la cola carga.
docker compose up -d
```

## Después de restaurar: supresiones posteriores al respaldo

Un respaldo anterior trae de vuelta las cuentas que un vecino suprimió después de esa fecha (Ley 21.719, art. 6).
Antes de abrir el servicio hay que volver a suprimirlas.

**Pendiente:** hoy la API no deja registro de las supresiones. Ese registro llega con la etapa 2 de
`docs/plan-ley-21719.md` (`data_subject_request`). Mientras tanto, anotar a mano cada supresión hecha después del
último respaldo verificado.

## Simulacro trimestral (art. 14 quinquies c)

1. Restaurar el respaldo más reciente en una base aparte del mismo servidor (el rol ya existe):
   `docker compose exec -T db createdb -U postgres guardia_restore_test` y luego el paso 2 cambiando `-d guardia`
   por `-d guardia_restore_test`.
2. Comparar conteos con producción, por ejemplo con
   `SELECT count(*) FROM alert; SELECT count(*) FROM citizen; SELECT max(created_at) FROM alert;`.
3. Borrar la base de prueba: `docker compose exec -T db dropdb -U postgres guardia_restore_test`.
4. Anotar la fecha, quién lo hizo, el archivo usado y el resultado en la bitácora de operación. Es la prueba de que
   la medida de seguridad existe y funciona.
