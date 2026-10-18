# Desplegar Guard-IA en un VPS de Hostinger

Todo corre con Docker Compose desde `docker-compose.yml`, en la raíz del repositorio:

| Servicio | Qué hace |
| --- | --- |
| db, redis, minio | Base, colas y archivos |
| migrate | Migraciones; termina al completar |
| api, command, platform | API, central y consola de plataforma |
| caddy | Única entrada (80/443) con TLS automático |

Los secretos viven solo en el `.env` del servidor (o en el panel de Hostinger), nunca en GitHub.

## 0. Antes de empezar

- **VPS**: Ubuntu 24.04, con Docker. Hostinger ofrece la plantilla «Ubuntu 24.04 with Docker».
  - **4 GB de RAM como mínimo**, 8 GB recomendado: construir la central y la consola consume memoria.
  - Con 4 GB, agregar swap (ver «Problemas frecuentes»).
- **Cuatro dominios** con registro **A** apuntando a la IP del VPS **antes** de levantar Caddy:

  | Uso | Ejemplo |
  | --- | --- |
  | API | `api.dominio.cl` |
  | Central | `central.dominio.cl` |
  | Consola de plataforma | `plataforma.dominio.cl` |
  | Audio y fotos | `media.dominio.cl` |

- **Cuentas**:
  - **Twilio**, para el SMS del OTP; en producción no se acepta `console`.
  - **Proveedor de IA**: opcional; sin él, la clasificación corre sin red.
  - **Bucket S3 externo** para el respaldo: Cloudflare R2, Backblaze B2 o AWS.
- **Firewall** (hPanel → VPS → Firewall): abrir solo 22, 80 y 443. MinIO, Postgres y Redis no publican puertos.
- **Regla 20**: en este servidor van datos reales. Los de prueba se quedan en local.

## 1. Acceso del VPS al repositorio privado (clave de despliegue)

El repositorio `TESTMODOPACK/GUARD-IA` es privado. El VPS lo lee con una clave propia **de solo lectura**: nunca con tu
contraseña ni con un token personal.

Por SSH en el VPS:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/guardia_deploy -N "" -C "vps-guardia"
```

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/guardia_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

```bash
cat ~/.ssh/guardia_deploy.pub
```

1. En GitHub, ir a **Settings → Deploy keys → Add deploy key** del repositorio.
2. Pegar la línea `ssh-ed25519 …` que imprimió el último comando.
3. Ponerle el título «VPS Hostinger» y **no** marcar «Allow write access».

Comprobar (debe saludar con el nombre del repositorio):

```bash
ssh -T git@github.com
```

## 2. Desplegar

Hay dos caminos. El A es el recomendado.

### A. Por SSH (recomendado)

```bash
git clone git@github.com:TESTMODOPACK/GUARD-IA.git /opt/guard-ia
```

```bash
cd /opt/guard-ia && cp .env.production.example .env && chmod 600 .env && nano .env
```

Completar el `.env` siguiendo los comentarios del archivo. Cada secreto se genera con:

```bash
openssl rand -base64 48 | tr -d '/+=' | cut -c1-40
```

- Los secretos `JWT_ACCESS_SECRET`, `PLATFORM_JWT_SECRET` y `PLATFORM_ENCRYPTION_KEY` deben ser **distintos** entre sí.
- **Respaldar `PLATFORM_ENCRYPTION_KEY` fuera del VPS**: si se pierde, todo el equipo debe volver a enrolar el segundo
  factor.

Levantar (la primera vez tarda varios minutos: construye las tres imágenes):

```bash
docker compose up -d --build
```

### B. Docker Manager de Hostinger

En hPanel, ir a **VPS → Docker Manager → Compose → «Compose from URL»**:
1. Indicar la URL del repositorio, `git@github.com:TESTMODOPACK/GUARD-IA.git`. El acceso funciona gracias a la clave
   del paso 1.
2. Nombrar el proyecto exactamente **`guardia`**. `backup.sh` y los comandos de esta guía lo buscan con ese nombre.
3. Cargar en el panel las variables de `.env.production.example`, con sus valores reales.

Hostinger documenta poco cómo construye las imágenes desde un repositorio privado. Si la construcción falla, usar el
camino A: el resultado es el mismo y los comandos de esta guía funcionan igual.

## 3. Primer arranque

Desde la raíz del repositorio (`/opt/guard-ia`):

```bash
docker compose ps
```

`migrate` y `minio-init` deben aparecer como terminados (Exited 0) y el resto como «running». Luego comprobar la API:

```bash
curl -s https://api.dominio.cl/v1/health
```

Si la API no arranca, revisar su registro con `docker compose logs api`. `validateEnv` lista exactamente qué variable
falta o no sirve para producción.

## 4. Datos iniciales

**Primer superadministrador** de la consola. Corre en `migrate` porque necesita al dueño de la base. Imprime una
contraseña temporal **una sola vez**: entregarla por un canal seguro. Al entrar se cambia la contraseña y se enrola el
segundo factor.

```bash
docker compose run --rm migrate node dist/cli/platform-user.js --email persona@dominio.cl --name "Nombre Apellido" --role SUPERADMIN
```

**Comunas de Chile**: sin ellas no hay ruteo por comuna. El archivo y el procedimiento están en
`docs/entorno-local.md`, sección «Comunas de Chile». Copiar el GeoJSON al VPS (por ejemplo a `/root/comunas`) y
cargarlo:

```bash
docker compose run --rm -v /root/comunas:/datos:ro migrate node dist/cli/load-comunas.js --geojson /datos/comunas.geojson
```

**Municipios**: se crean desde la consola de plataforma, con su lista de puesta en marcha. **No correr `seed.js` en
producción**: crea un municipio de demostración con cuentas de contraseña conocida.

## 5. Respaldo diario

Detalle y restauración en `infra/RESTAURAR.md`.

1. Instalar `age` y crear la carpeta del respaldo:
   ```bash
   apt install -y age && mkdir -p /var/backups/guardia
   ```
2. En **otro equipo** (nunca en el VPS), generar el par de claves con `age-keygen -o clave.txt`. Copiar en
   `BACKUP_AGE_RECIPIENT` del `.env` solo la línea pública `age1…`.
3. Completar `BACKUP_S3_*` en el `.env` con el bucket externo.
4. Programar el cron (`crontab -e`):
   ```
   15 3 * * * /opt/guard-ia/infra/backup.sh >> /var/log/guardia-backup.log 2>&1
   ```
5. Probarlo una vez a mano (`/opt/guard-ia/infra/backup.sh`) y hacer el primer simulacro de restauración.

## 6. Actualizar a una versión nueva

Las migraciones nuevas se aplican solas: `migrate` corre antes de la API en cada `up`.

```bash
cd /opt/guard-ia && git pull && docker compose up -d --build
```

Los datos están en volúmenes de Docker con nombre (`guardia_pgdata`, `guardia_miniodata`, …): una actualización o
un nuevo clon no los toca. **Nunca correr `docker compose down -v`**: la opción `-v` borra los volúmenes, es decir,
la base y los archivos.

## Problemas frecuentes

- **El certificado no se emite**: los registros A aún no apuntan al VPS o el puerto 80 está cerrado. Caddy reintenta
  solo; revisar con `docker compose logs caddy`.
- **Los puertos 80/443 están ocupados**: alguna plantilla de Hostinger trae su propio proxy. Detenerlo, porque Caddy
  debe ser la única entrada.
- **La construcción se corta por memoria**: agregar 4 GB de swap.
  ```bash
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```
- **La central abre pero no conecta**: revisar que `PUBLIC_API_URL` y `CORS_ORIGINS` usen los dominios reales.
  `PUBLIC_API_URL` se fija al **construir** la central: después de cambiarlo, correr
  `docker compose up -d --build command platform`.
