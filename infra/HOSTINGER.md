# Desplegar Guard-IA en un VPS de Hostinger

Todo corre con Docker Compose desde `docker-compose.yml`, en la raíz del repositorio:

| Servicio | Qué hace |
| --- | --- |
| db, redis, minio | Base, colas y archivos |
| migrate | Migraciones; termina al completar |
| api, command, platform | API, central y consola de plataforma |
| caddy | Única entrada (80/443) con TLS automático |

Los secretos viven solo en el `.env` del servidor, nunca en GitHub. El repositorio es público
(`TESTMODOPACK/GUARD-IA`), así que el VPS lo descarga sin credenciales.

## 0. Antes de empezar

- **VPS**: Ubuntu 24.04. Si no trae Docker, el instalador lo instala.
  - **4 GB de RAM como mínimo**, 8 GB recomendado.
  - Con menos de 6 GB y sin memoria de intercambio, el instalador agrega 4 GB de swap.
- **Cuatro dominios** con registro **A** apuntando a la IP del VPS **antes** de instalar. Con un dominio principal,
  por ejemplo `midominio.cl`, son:

  | Uso | Dominio |
  | --- | --- |
  | API | `api.midominio.cl` |
  | Central | `central.midominio.cl` |
  | Consola de plataforma | `plataforma.midominio.cl` |
  | Audio y fotos | `media.midominio.cl` |

- **Cuenta de Twilio**: sin ella la API no arranca en producción, porque el código de acceso del vecino va por SMS.
- **Opcionales**:
  - clave del proveedor de IA (sin ella, la clasificación corre sin red);
  - bucket S3 externo para el respaldo: Cloudflare R2, Backblaze B2 o AWS.
- **Firewall** (hPanel → VPS → Firewall): abrir solo 22, 80 y 443.
- **Regla 20**: en este servidor van datos reales. Los de prueba se quedan en local.

## 1. Instalación automática (recomendada)

En hPanel → VPS → **Consola web** (o por SSH como root), un solo comando:

```bash
curl -fsSL https://raw.githubusercontent.com/TESTMODOPACK/GUARD-IA/main/infra/install.sh | bash
```

**Te pregunta:**
- el dominio principal;
- el correo de contacto de privacidad;
- los datos de Twilio;
- la clave de IA (opcional);
- la clave pública `age` del respaldo (opcional);
- el correo y nombre del primer superadministrador de la consola;
- si descargar y cargar las comunas.

**Hace, en orden:**
1. Clona el repositorio en `/opt/guard-ia`.
2. Crea `/opt/guard-ia/.env` con todos los secretos generados al azar (permisos 600).
3. Instala Docker, `age` y `cron` si faltan, y agrega swap si hace falta.
4. Revisa que los cuatro dominios apunten al VPS.
5. Construye y levanta los contenedores y espera a que la API esté sana.
6. Crea el primer superadministrador. Imprime su contraseña temporal **una sola vez**: anótala.
7. Descarga de SUBDERE (262 MB) y carga las 345 comunas.
8. Programa el respaldo diario a las 03:15.

Se puede correr de nuevo cuantas veces haga falta, por ejemplo después de completar Twilio. No cambia los secretos
ya generados, no vuelve a preguntar lo que ya está en `.env` y salta lo que ya está hecho. Con el repositorio ya
clonado se corre con:

```bash
bash /opt/guard-ia/infra/install.sh
```

**Al terminar:**
1. Guarda fuera del servidor una copia de `PLATFORM_ENCRYPTION_KEY`, que está en `/opt/guard-ia/.env`. Si se pierde,
   todo el equipo debe volver a enrolar el segundo factor.
2. Entra a la consola de plataforma, cambia la contraseña temporal y enrola el segundo factor.
3. Crea el municipio desde la consola. `seed.js` no va en producción: crea cuentas de demostración con contraseña
   conocida.

**Sin preguntas** (para automatizar del todo): cada respuesta puede ir como variable de entorno, con el nombre de la
clave del `.env`, más estas:
- `DOMAIN`, `ADMIN_EMAIL` y `ADMIN_NAME`;
- `LOAD_COMUNAS=s`;
- `ASSUME_YES=1`, que sigue aunque el DNS aún no apunte al VPS.

Detalle en el encabezado de `infra/install.sh`.

**Seguridad:** el comando instala lo que haya en la rama `main` de GitHub. Protege la cuenta que puede subir cambios a
ese repositorio con segundo factor.

## 2. Instalación manual (alternativa)

Lo mismo que hace el instalador, paso a paso, desde la Consola web.

```bash
git clone https://github.com/TESTMODOPACK/GUARD-IA.git /opt/guard-ia
```

```bash
cd /opt/guard-ia && bash infra/install.sh --env-only
```

`--env-only` solo prepara el `.env`. También puedes copiar `.env.production.example` a `.env` y completarlo a mano:
cada secreto se genera con `openssl rand -base64 48 | tr -d '/+=' | cut -c1-40`, y deben ser distintos entre sí.

```bash
cd /opt/guard-ia && docker compose up -d --build
```

```bash
cd /opt/guard-ia && docker compose run --rm migrate node dist/cli/platform-user.js --email persona@midominio.cl --name "Nombre Apellido" --role SUPERADMIN
```

Las comunas se cargan según `docs/entorno-local.md` («Comunas de Chile»), con el servicio `migrate`:

```bash
cd /opt/guard-ia && docker compose run --rm -v /root/comunas:/datos:ro migrate node dist/cli/load-comunas.js --geojson /datos/comunas.geojson
```

## 3. Respaldo diario

El instalador lo programa. Para que el respaldo funcione falta:
1. En **otro equipo** (nunca en el VPS), generar el par de claves con `age-keygen -o clave.txt`. Poner en
   `BACKUP_AGE_RECIPIENT` del `.env` solo la línea pública `age1…`.
2. Completar `BACKUP_S3_*` en el `.env` con el bucket externo. Sin eso, el respaldo queda solo en el VPS.
3. Probarlo una vez a mano y hacer el primer simulacro de restauración (`infra/RESTAURAR.md`):
   ```bash
   bash /opt/guard-ia/infra/backup.sh
   ```

## 4. Actualizar a una versión nueva

Las migraciones nuevas se aplican solas: `migrate` corre antes de la API en cada `up`.

```bash
cd /opt/guard-ia && git pull && docker compose up -d --build
```

Los datos están en volúmenes de Docker con nombre (`guardia_pgdata`, `guardia_miniodata`, …): una actualización no
los toca. **Nunca correr `docker compose down -v`**: la opción `-v` borra los volúmenes, es decir, la base y los
archivos.

## Docker Manager de Hostinger

No se usa: el compose exige sus variables (secretos y dominios) antes de arrancar y construye las imágenes desde el
código, y la opción «Compose from URL» del panel no da dónde cargarlas. Si quedó un proyecto a medias creado desde
el panel, bórralo en **Docker Manager** antes de instalar, para que no ocupe los puertos 80 y 443.

## Si el repositorio vuelve a ser privado

El VPS necesitará una clave de despliegue de solo lectura:
1. Generarla en el VPS:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/guardia_deploy -N ""
   ```
2. Pegar el contenido de `~/.ssh/guardia_deploy.pub` en GitHub → Settings → Deploy keys, sin permiso de escritura.
3. Agregar en `~/.ssh/config` una entrada `Host github.com` con `IdentityFile ~/.ssh/guardia_deploy`.
4. Cambiar el remoto del clon:
   ```bash
   git -C /opt/guard-ia remote set-url origin git@github.com:TESTMODOPACK/GUARD-IA.git
   ```

## Problemas frecuentes

- **El certificado no se emite**: los registros A aún no apuntan al VPS o el puerto 80 está cerrado. Caddy reintenta
  solo; revisar con `docker compose logs caddy`.
- **Los puertos 80/443 están ocupados**: un proyecto del Docker Manager o un proxy de alguna plantilla los usa.
  Detenerlo, porque Caddy debe ser la única entrada.
- **La API no queda sana**: correr `docker compose logs api`. `validateEnv` dice qué variable falta o no sirve.
- **La central abre pero no conecta**: revisar que `PUBLIC_API_URL` y `CORS_ORIGINS` usen los dominios reales.
  `PUBLIC_API_URL` se fija al **construir** la central: después de cambiarlo, correr
  `docker compose up -d --build command platform`.
