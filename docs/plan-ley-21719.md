# Guard-IA — Plan de cumplimiento de la Ley 21.719

Versión 15-10-2026. Parte del análisis `docs/legal/ley-21719-guard-ia.pdf` (fuente en el mismo directorio) y de lo
que el código hace hoy. Es un plan técnico y normativo, no asesoría legal: lo marcado **[abogado]** se valida antes
de darlo por cerrado.

La ley rige desde el **1 de diciembre de 2026**. Desde ese día, todo dato real que trate Guard-IA queda bajo ella.

> **Avance (15-10-2026):** etapas 0 y 1 implementadas y probadas en local (migración `0014_privacy_records.sql`,
> `apps/api/test/legal.test.ts`). Pendiente de esas etapas, fuera del código: instalar `age` y las claves en el VPS,
> versionado del bucket de respaldo y el primer simulacro de restauración (0.3); firmar el procedimiento de incidentes
> (0.6 / L8); revisar con el abogado el texto del aviso (`buildLegalNotice` en shared) y la política para menores (L4, L5).
> Decisiones tomadas al implementar:
> - El aviso de la app sale de la API con la configuración vigente: nombra al proveedor de IA que de verdad se usa.
> - La IA externa se informa y el vecino puede desactivarla al aceptar o después en «Mis datos». Si se desactiva, o si el
>   municipio no autorizó al proveedor, la alerta se clasifica sin red (`ai_status = LOCAL`).
> - Menor de 14: no se crea la cuenta y se borra el número verificado.
> - El modo discreto se avisa en el propio botón («graba 15 s de ambiente»), sin un diálogo que demore un SOS.

## Cómo está ordenado

De lo más simple y barato, que quita problemas hoy, a lo más complejo. Cada paso indica qué infracción evita. Lo
barato no siempre es lo menos grave: varios pasos de la etapa 0 evitan infracciones **graves**. Por eso van primero.

| Etapa | Qué | Esfuerzo | Migración |
| --- | --- | --- | --- |
| 0 | Correcciones inmediatas ✅ | 2–3 días | no |
| 1 | Poder demostrar: consentimiento, contactos, subencargados, incidentes ✅ | 6–8 días | `0014_privacy_records` |
| 2 | Derechos del vecino con plazos | 8–10 días | `data_subject_requests` |
| 3 | Acceso mínimo y trazabilidad | 10–12 días | `access_minimization` |
| 4 | Conservación, anonimización y cifrado | 10–15 días | `retention_anonymization`, `phone_encryption` |
| 5 | Gobierno continuo (después del piloto) | permanente | — |
| L | Pista legal en paralelo (usuario, abogado, municipio) | desde ya | — |

Las migraciones toman el siguiente número libre: la etapa 1 es `0014`; la de escala (antes `0014_scale.sql`) toma el número que siga.

## Qué está en juego

### Escala de sanciones (arts. 34 bis a 35)

| Gravedad | Tope | Aprox. en pesos* | Ejemplos que tocan a Guard-IA |
| --- | --- | --- | --- |
| Leve | Amonestación o 5.000 UTM | ~$345 millones | No informar bien (14 ter); no tener un contacto para ejercer derechos; responder tarde o incompleto |
| Grave | 10.000 UTM | ~$690 millones | Tratar sin base legal; ceder sin autorización; datos innecesarios; obstaculizar derechos; no responder un bloqueo; menores; secreto; seguridad; no registrar incidentes; transferencia internacional irregular |
| Gravísima | 20.000 UTM | ~$1.380 millones | Secreto de datos **sensibles** o de **infracciones administrativas**; omitir a propósito un incidente; no hacer la evaluación de impacto cuando corresponde; incumplir una resolución de la Agencia sobre un reclamo |

\* Con la UTM cerca de $69.000; usar el valor vigente.

Agravantes y atenuantes:
- **Agravan** (arts. 35 y 36):
  - un recargo del **50 %** si no se corrige en 60 días;
  - hasta el **triple** por reincidencia;
  - con reincidencia, hasta el **2 % o 4 % de los ingresos** anuales, salvo empresas de menor tamaño;
  - suspender el tratamiento hasta 30 días, si hay gravísimas reiteradas (art. 38).
- **Atenúan** (art. 36): la autodenuncia, la colaboración, reparar el daño y un modelo de prevención certificado.

### Quién paga

- **El municipio** (órgano público, art. 44):
  - una multa del 20 % al 50 % de la remuneración del **alcalde**;
  - si los datos son sensibles, el 50 % y suspensión hasta 30 días;
  - la sanción se publica;
  - los funcionarios responden en sumario, y una gravísima es falta grave a la probidad (art. 45).
- **Guard-IA** (empresa privada) responde de tres formas:
  1. **Como encargado** cumple el contrato y los arts. 14 bis y 14 quinquies (secreto y seguridad). Debe avisar al municipio de cualquier incidente.
  2. **Si se sale del encargo, pasa a ser responsable** y responde con multas en UTM y solidariamente por los daños (art. 15 bis). Basta con:
     - usar los datos para otra cosa, por ejemplo entrenar o evaluar el agente con alertas reales;
     - entregarlos a un subencargado que el municipio no autorizó por escrito.
  3. **Si es responsable de la cuenta del vecino** **[abogado]**, responde directamente por esa parte.

  Además, el municipio trasladará por contrato a Guard-IA el costo de lo que sea culpa de Guard-IA.

**Conclusión:** para Guard-IA, el riesgo monetario más directo no es un error de pantalla, sino **salirse del
encargo**. Varios pasos de este plan existen para que el sistema lo impida por diseño: 0.1, 1.4 y la regla de
datos reales del paso 0.5.

## Reglas para todo el plan

1. **El SOS nunca espera por esto.** Un consentimiento vencido, una solicitud abierta, un bloqueo o un registro de acceso no frenan
   `POST /alerts` ni el aviso a la central (regla 1 del `CLAUDE.md`). Lo legal se registra y se pide después.
2. Cambios de contrato empiezan en `packages/shared`.
3. Cada tabla nueva:
   - lleva sus `GRANT` mínimos y su RLS;
   - no usa PK de texto;
   - es de solo inserción si es un registro (consentimientos, accesos, incidentes).
4. Toda decisión sobre datos de un vecino (responder, bloquear, suprimir) escribe `audit_log` en la misma transacción. El
   aviso al vecino va después del commit.
5. **Ningún dato real sale de producción**: ni a local, ni a la evaluación del agente, ni a pruebas. Mejorar el agente con alertas reales
   solo si el contrato de encargo lo permite y con datos anonimizados.
6. Compuerta de cada etapa:
   - `pnpm typecheck`, los tests y el simulador en verde;
   - los tests nuevos de la etapa;
   - lo que la etapa define como "listo".

---

## Pista legal (en paralelo, desde ya)

No es código. Los contratos tardan, así que hay que partir ahora.

| # | Qué | Quién | Para cuándo | Evita |
| --- | --- | --- | --- | --- |
| L1 | Elegir **un** proveedor de IA para el piloto y revisar sus condiciones: sin retención, sin entrenamiento, país y DPA. Pedir los DPA de Twilio, Expo y el hosting | Usuario | Semana del 19-10 | Grave: transferencia internacional (34 ter m); ceder sin autorización (34 ter b) |
| L2 | **Contrato de encargo** modelo (art. 15 bis). Debe incluir: objeto, duración, finalidad, tipos de datos, categorías de titulares, derechos y obligaciones, **lista de subencargados autorizados**, devolución o borrado al terminar, aviso de incidentes y si se permite mejorar el servicio con datos anonimizados | Abogado + usuario | Antes del piloto | Que Guard-IA pase a ser responsable |
| L3 | **Evaluación de impacto** (art. 15 ter): Guard-IA redacta la parte técnica y el municipio la aprueba como responsable | Usuario + municipio | Antes del primer dato real | **Gravísima** (34 quáter k) |
| L4 | **Política de tratamiento** del municipio y de Guard-IA; textos del aviso en capas (paso 1.3) | Abogado | Antes del piloto | Leve (34 bis a) |
| L5 | Responder las 8 preguntas abiertas del informe. Las urgentes: el rol de Guard-IA en la cuenta, si las faltas son "datos de infracciones administrativas" (arts. 2 y 25) y la política para menores de 14 | Abogado | Antes de la etapa 2 | Define el alcance de 1.1, 2.x y 3.1 |
| L6 | Compromiso de confidencialidad del personal municipal y de Guard-IA (arts. 14 bis y 46); designar delegado de protección de datos (transitorio 5°) | Municipio, Guard-IA | Antes del piloto | Grave (34 ter i) |
| L7 | Convenio entre municipios para traspasos y faltas compartidas (art. 22) | Municipios | Antes de un segundo municipio | Grave (34 ter b) |
| L8 | Procedimiento de incidentes firmado: quién detecta, quién decide y a quién se avisa (paso 0.6) | Usuario + municipio | Antes del piloto | Grave (34 ter k) y gravísima (34 quáter f) |

---

## Etapa 0 — Correcciones inmediatas (2–3 días, sin migraciones)

Cosas que hoy están mal y se arreglan en horas.

### 0.1 Un proveedor de IA y un texto que diga la verdad
- **Hoy:** `apps/mobile/src/app/consent.tsx:11` dice «con OpenAI», pero la configuración usa Groq.
- **Cambio:**
  - La API publica `GET /legal/notice`, sin sesión y sin datos personales. Devuelve proveedor de IA y país, proveedor de SMS y de avisos, `CONSENT_VERSION` y la URL de la política. Todo sale de la configuración (`AI_BASE_URL`, `SMS_PROVIDER`), no escrito a mano.
  - La app arma el texto con esa respuesta. Sin red, usa un texto genérico y veraz: «un proveedor externo en EE.UU.».
  - Subir `CONSENT_VERSION` para que todos acepten el texto nuevo.
- **Evita:** leve (34 bis a); grave, si el dato va a un proveedor no informado (34 ter m).
- **Prueba:** el texto cambia al cambiar `AI_BASE_URL`.

### 0.2 Avisos de cuenta neutros en la pantalla bloqueada
- **Hoy:** `packages/shared/src/citizen-notices.ts` usa como título del aviso push «Advertencia por aviso falso» o «Tu cuenta fue bloqueada». Cualquiera que mire el teléfono lo lee.
- **Cambio:**
  - Separar `push` (neutro: «Guard-IA: hay novedades en tu cuenta») de `inApp` (el detalle, que solo se ve dentro de la app).
  - Los avisos del caso siguen sin categoría, como hoy.
- **Evita:** grave (34 ter i, secreto). Si las faltas se consideran datos de infracciones administrativas **[abogado, L5]**, gravísima (34 quáter d).

### 0.3 Respaldos cifrados, fuera del servidor y que borren
- **Hoy:** `infra/backup.sh` deja el `pg_dump` **sin cifrar y en el mismo VPS**. El espejo de archivos (`mc mirror --overwrite`) no borra lo que se purgó, así que el audio eliminado a los 90 días sigue en el respaldo.
- **Cambio:**
  - Cifrar el dump con `age`. En el VPS queda solo la clave pública; la privada, fuera.
  - Subirlo al mismo destino externo que los archivos.
  - `mc mirror --overwrite --remove`, o una regla de vencimiento en el bucket de respaldo.
  - Una restauración de prueba documentada (14 quinquies c).
- **Evita:** grave (34 ter j, seguridad); exceso de conservación (3 c).

### 0.4 Logs sin datos del vecino
- **Hoy:**
  - `apps/api/src/alerts/alerts.service.ts:200` escribe las coordenadas de las alertas fuera de cobertura.
  - `apps/api/src/ai/openai.provider.ts:102,107` guarda hasta 300 caracteres de la respuesta de la IA, que repite lo que dijo el vecino.
  - `apps/api/src/auth/sms/sms.provider.ts:42` guarda el detalle del error de Twilio, que puede traer el teléfono.
- **Cambio:** registrar el id, el largo y un hash, nunca el contenido.
- **Evita:** grave (34 ter c y j).

### 0.5 Regla escrita: ningún dato real fuera de producción
Agregar la regla al `CLAUDE.md` y a `docs/entorno-local.md`. La evaluación del agente ya usa casos sintéticos y debe seguir así.
**Evita:** que Guard-IA pase a ser responsable (15 bis); grave (34 ter a).

### 0.6 Procedimiento de incidentes (documento)
`docs/legal/procedimiento-incidentes.md`:
- qué es un incidente y quién lo declara;
- Guard-IA avisa al municipio sin demora (art. 15 bis);
- el municipio avisa a la Agencia (art. 14 sexies);
- cuándo se avisa a los vecinos: datos sensibles, menores o riesgo económico;
- plantilla de aviso y registro.

Se firma en L8. **Evita:** grave (34 ter k); gravísima (34 quáter f).

**Compuerta 0:**
- la app muestra el proveedor real;
- ningún aviso push dice «aviso falso» ni «bloqueo»;
- un respaldo cifrado se restauró en una base limpia;
- `grep` sin coordenadas ni contenido en los logs.

---

## Etapa 1 — Poder demostrar (6–8 días, migración `privacy_records`)

La ley pone la carga de la prueba en el responsable (art. 12): no basta con cumplir, hay que poder mostrarlo.

### 1.1 Consentimiento con historial y revocación
- **Hoy:** `apps/api/src/auth/auth.service.ts:104` guarda cualquier versión sin validarla, y pisa la anterior.
- **Tabla `consent_record`** (solo inserción). Columnas:
  - `citizen_id`;
  - `purpose` (enum, p. ej. `SERVICE`, `AI_TRANSFER`);
  - `version`, `text_hash`;
  - `action` (`GRANTED`, `REVOKED`);
  - `at`, `app_version`, `platform`.
- **Validación:** `acceptConsent` exige `version === CONSENT_VERSION` e inserta en la misma transacción. `citizen.consent_version` queda como caché.
- **Revocación:**
  - `POST /me/consent/revoke` revoca las finalidades basadas en consentimiento.
  - **Revocar `AI_TRANSFER`** marca al vecino y el worker clasifica sus alertas sin red (clasificador local + reglas), con un estado propio, no `FAILED`.
  - El SOS sigue igual. Es la forma de que la revocación tenga efecto real.
- Qué finalidades son por consentimiento y cuáles por función municipal (art. 20) lo fija **[abogado, L5]**.
- Al suprimir la cuenta, el registro queda ligado al id anonimizado (prueba seudónima). El plazo lo fija **[abogado]**.
- **Evita:** grave (34 ter a, tratar sin base que se pueda probar).

### 1.2 Un contacto para ejercer derechos
- **Tabla `tenant_privacy`** (PK `tenant_id`). Columnas: correo y dirección de contacto, nombre y correo del delegado, versión y URL de la política, fecha de actualización.
  - La edita el **ADMIN municipal** (audit_log); la consola la ve.
  - El contacto de Guard-IA va en la configuración (`PRIVACY_CONTACT_EMAIL`).
- **App:**
  - «Mis datos» muestra el contacto de Guard-IA.
  - Cada caso (`alert/[id]`) muestra «Responsable: Municipalidad X · contacto», leído después del commit en contexto system.
- **Evita:** leve (34 bis b), el paso más barato de todo el plan.

### 1.3 Aviso en capas, edad y modo discreto
- **Primera capa en `consent.tsx`:**
  - responsable;
  - finalidades y base de cada una;
  - proveedores y países (del paso 0.1);
  - plazos;
  - derechos;
  - cómo reclamar ante la Agencia.
- **Segunda capa:** la política completa (L4).
- **Declaración de edad.** Si la persona declara ser menor de 14, la app aplica lo que defina **[abogado, L5]**. La propuesta es mostrar los números de emergencia y pedir un adulto, sin crear la cuenta. Se guarda `citizen.age_declared_at`.
- **Modo discreto:** antes del primer uso, la app avisa que graba 15 s de ambiente.
- **Evita:** leve (34 bis a); grave (34 ter g, menores).

### 1.4 Subencargados autorizados por municipio, exigidos por el sistema
- **Tablas:**
  - `subprocessor`: nombre, servicio, país, datos que recibe, garantía;
  - `tenant_subprocessor`: municipio, subencargado, `authorized_at`, referencia del documento y revocación.
  - Las administra la consola de plataforma.
- **El worker de IA verifica la autorización** del municipio de la alerta (caché 60 s). Sin autorización, clasifica sin red. Así **ningún dato llega a un proveedor que el municipio no autorizó**, aunque alguien olvide un trámite.
- **Datos del contrato:** `tenant.contract_signed_at` y `dpa_signed_at` (hoy solo fechas) pasan a llevar versión y referencia del documento.
- **Lista de puesta en marcha (`tenant_readiness`):** suma contrato de encargo, IA autorizada, contacto de privacidad y evaluación de impacto aprobada. `set_tenant_status()` no deja pasar a ACTIVE sin ellos.
- **Evita:** grave (34 ter b y m) y, sobre todo, que Guard-IA pase a ser responsable (15 bis).

### 1.5 Registro de incidentes
- **Tablas `security_incident` y `security_incident_tenant`** (solo inserción más eventos). Columnas:
  - detección, naturaleza, datos y titulares afectados;
  - medidas;
  - aviso al municipio, a la Agencia y a los titulares, con su fecha.
- **Consola:** página `/incidentes` con la lista de pasos del procedimiento (0.6).
- **Central:** el ADMIN ve los incidentes que afectan a su municipio, para hacer su aviso a la Agencia.
- **Evita:** grave (34 ter k); gravísima (34 quáter f).

**Compuerta 1:**
- versión de consentimiento incorrecta → error, y el SOS de esa cuenta igual entra;
- revocar `AI_TRANSFER` → la siguiente alerta se clasifica sin red;
- municipio sin IA autorizada → sin llamadas al proveedor;
- municipio sin contrato → no puede pasar a ACTIVE.

---

## Etapa 2 — Derechos con plazos (8–10 días, migración `data_subject_requests`)

### 2.1 Solicitudes y bloqueo
- **Tabla `data_subject_request`.** Columnas:
  - `citizen_id`;
  - `tenant_id`: NULL si es de la cuenta, un municipio si es de sus casos;
  - `kind`: `ACCESS`, `RECTIFICATION`, `ERASURE`, `OBJECTION`, `PORTABILITY` o `BLOCK`;
  - `status`;
  - `detail`;
  - `received_at`, `due_at`, `extended_until`, `answered_at`;
  - `answer`, `answered_by`.
- **Plazos** (art. 11):
  - 30 días corridos, prorrogables una vez por 30;
  - bloqueo en **2 días hábiles**: tabla `holiday` con los feriados de Chile; la PK es una fecha.
- **Tabla `processing_block`.** Mientras rige, se suspende todo lo que no sea atender una emergencia: la IA externa, el puntaje y la exportación a terceros. El SOS sigue igual.
- **`PrivacyDeadlinesCron`:** avisa con 5 días de margen y marca las vencidas.
- **Evita:**
  - leve (34 bis c);
  - grave (34 ter e y f);
  - gravísima, si se ignora una resolución de la Agencia (34 quáter i). La bandeja deja la huella.

### 2.2 Pantallas
- **App, «Mis datos»:**
  - pedir rectificación (nombre, edad declarada, y una aclaración que se adjunta al caso, sin editar lo reportado);
  - oponerse a la IA externa y al puntaje;
  - pedir bloqueo;
  - ver el estado de cada solicitud.
- **Central:** `/admin/solicitudes` para el ADMIN, con plazo, respuesta y prórroga (audit_log).
- **Consola:** las de la cuenta, si Guard-IA resulta responsable de ella **[abogado]**.

### 2.3 Exportación completa
- **Hoy:** `apps/api/src/privacy/privacy.service.ts` omite municipio, prioridad, análisis de la IA, despachos, eventos y archivos.
- **Cambio:** agregarlos, con los archivos como enlaces firmados de 24 h. La exportación queda registrada como solicitud `ACCESS` respondida.
- **Evita:** leve (34 bis c, respuesta incompleta); grave (34 ter e).

### 2.4 Supresión completa
- **Hoy:** `erase_citizen` (`0011_misuse_blocks.sql:175`) deja notas del operador y de despacho, evidencia de faltas, notas de bloqueo y `triage_label`.
- **Cambio:** versión nueva por `CREATE OR REPLACE` en la migración de la etapa:
  - borra el texto libre que repite lo que dijo el vecino;
  - desvincula lo que el municipio deba conservar como registro (art. 22) **[abogado]**;
  - queda registrada como solicitud `ERASURE`.
- La política informa que los respaldos se renuevan en 30 días.
- **Evita:** grave (34 ter e).

### 2.5 Decisiones automatizadas (art. 8 bis)
- **Corregir la prioridad:** `PATCH /ops/alerts/:id/priority` (`OPERATING_ROLES`). Registra un evento `PRIORITY_CHANGED` y escribe `audit_log` en la misma transacción. El aviso por WS va después del commit. Hoy nadie puede corregir lo que `capPriority` (`apps/api/src/ai/ai.processor.ts:26`) bajó.
- **Ficha:** dice por qué bajó («confianza baja», «cuenta restringida»).
- **App y política:** explican el puntaje, las faltas y el traspaso automático, y cómo pedir revisión.
- **Evita:** leve o grave según cómo lo califique la Agencia **[abogado]**.

**Compuerta 2:**
- una solicitud de bloqueo sin responder aparece vencida al tercer día hábil;
- la exportación trae todo lo que la central ve del vecino;
- después de suprimir, ninguna tabla tiene texto del vecino ligado a él (test contra la base real).

---

## Etapa 3 — Acceso mínimo y trazabilidad (10–12 días, migración `access_minimization`)

Lo que distingue «la pantalla oculta» de «la base no lo entrega».

### 3.1 Faltas de otros municipios solo como conteo
- **Hoy:**
  - `ops.service.ts:227` arma `strikesByTenant` con nombre y conteo de cada municipio;
  - la RLS deja a un operador leer faltas y bloqueos de otros municipios **con sus notas**.
- **Cambio:**
  - la política de `citizen_strike` y `citizen_block` limita a su municipio;
  - una función SECURITY DEFINER entrega el total vigente;
  - el trigger `alert_account` sigue contando en todo el país.
- **Evita:** grave (34 ter c e i); gravísima (34 quáter d y g) **[abogado, L5]**.

### 3.2 Terreno y apoyo administrativo con lo mínimo
- **Terreno:**
  - hoy la RLS le deja leer la fila completa de la alerta;
  - como todos los contextos usan el rol `guardia_app`, los privilegios por columna no sirven;
  - el contexto `field` pierde el SELECT directo sobre `alert` y lee por una función SECURITY DEFINER que devuelve solo categoría, resumen, lugar, instrucciones y fotos.
- **Apoyo administrativo** (`ASSISTANT`): sin teléfono ni audio en la API, y cada intento queda en el registro de accesos (3.3).
- **Evita:** grave (34 ter c).

### 3.3 Teléfono enmascarado y registro de accesos
- **Ficha:** muestra `+56 9 •••• 12 34`.
  - «Llamar» y «Ver teléfono» piden `POST /ops/alerts/:id/reveal-phone`, que inserta en `data_access_log` en la misma transacción.
  - Igual al firmar audio o foto y al abrir la ficha (una vez por sesión y alerta).
- **`data_access_log`:**
  - solo inserción;
  - columnas: municipio, actor, alerta, campo y momento;
  - RLS: el ADMIN de su municipio lo consulta;
  - se particiona junto con `0014_scale`.
- **Evita:** sirve de prueba de las medidas de seguridad (14 quinquies) y disuade el mal uso, que sería gravísima (34 quáter d).

### 3.4 Alertas sensibles
- **Marca:** `shared` define qué categorías son sensibles (violencia intrafamiliar, salud, menores). La clasificación fija `alert.sensitive`, igual que `security_relevant` en 0013.
- **Efectos:**
  - sin detalle en los avisos;
  - acceso siempre registrado;
  - el apoyo administrativo no la ve;
  - va primero en la purga (etapa 4).
- **Evita:**
  - gravísima (34 quáter d y e);
  - para el municipio, el 50 % de la remuneración del alcalde y suspensión (art. 44).

### 3.5 Cuentas de la central
- **Segundo factor TOTP** para ADMIN y SUPERVISOR. Reutiliza el de `apps/api/src/platform/`. El secreto va cifrado con `OPERATOR_ENCRYPTION_KEY`, y `validateEnv` lo exige en producción.
- **Bloqueo por intentos fallidos:** columnas `failed_logins` y `locked_until`; lo destraba el ADMIN. Hoy `auth.service.ts:151` solo limita por minuto.
- **Token de acceso de 15 min:** hoy dura 12 h (`config/env.ts:26`). Verificar que el socket se reconecta con el token renovado.
- **Inactividad:**
  - el panel de administración se cierra a los 15 min;
  - la cola de la central se **bloquea sin cerrar la sesión**: oculta los datos personales, pero sigue mostrando «N alertas nuevas» y sonando. Una central de monitoreo no puede perder un SOS por un cierre de sesión.
- **Evita:** grave (34 ter j).

**Compuerta 3:**
- tests RLS: un operador de A no lee notas de faltas de B;
- terreno no lee el teléfono ni la transcripción, ni con SQL directo en su contexto;
- cada «Ver teléfono» deja una fila;
- `ui-gate.mjs` en verde con el teléfono enmascarado;
- la cola bloqueada sigue sonando.

---

## Etapa 4 — Conservación, anonimización y cifrado (10–15 días)

Es la más invasiva: toca el modelo de datos y el ingreso. Va al final porque necesita los plazos que decida el
municipio y porque las etapas anteriores ya cubren el riesgo inmediato.

### 4.1 Plazos por municipio
- **Tabla `tenant_retention`:** municipio, tipo de dato y días, con mínimos y máximos validados.
- La decide el ADMIN municipal (es el responsable); la consola la ve.
- Valores iniciales:
  - audio y fotos: 90 días;
  - texto: 90 días;
  - anonimización: [__] meses;
  - bitácora: [__] años.

### 4.2 Purga del texto con el audio
- **Cambio:** `RetentionCron` llama a una función SECURITY DEFINER `purge_alert_content`, que borra:
  - texto;
  - transcripción;
  - resumen;
  - análisis de la IA;
  - notas que repiten al vecino.
- Quedan la categoría, la prioridad, los tiempos y el resultado, que bastan como registro municipal.
- **Evita:** grave (34 ter c, conservar lo innecesario; art. 3 c).

### 4.3 Anonimización de alertas cerradas
- **Función `anonymize_alert`.** Tiene que ser SECURITY DEFINER porque `citizen_id`, `lat` y `lng` no son actualizables ni en contexto system (regla 3).
- **Qué cambia:**
  - `citizen_id` pasa a NULL;
  - coordenadas redondeadas a ~100 m, y `location` se recalcula;
  - coordenadas de `incident` (hallazgo A4 de `docs/revision-base-de-datos.md`);
  - textos en `alert_event`;
  - posición de terreno;
  - fija `alert.anonymized_at`.
- **Tests:** las cifras del panel siguen cuadrando.

### 4.4 Faltas, dispositivos y terreno
- **Faltas y bloqueos vencidos:** la evidencia se anonimiza al pasar el plazo de reclamo.
- **Dispositivos:** se borran después de [__] meses sin uso.
- **Posiciones de los avisos de pánico:** se borran [__] días después de cerrar el despacho.

### 4.5 Teléfono cifrado con hash de búsqueda
- **Columnas:** `citizen.phone_enc` (AES-256-GCM en la API, clave `CITIZEN_PHONE_KEY`) y `phone_hash` (HMAC con otra clave, único).
- **Qué toca:**
  - el ingreso OTP y los códigos;
  - `tenant_test_phone`;
  - `erase_citizen`;
  - los triggers que comparan teléfonos;
  - la exportación;
  - «Ver teléfono».
- **Cómo:** migración con relleno; plan de rotación de claves; `validateEnv` exige las claves en producción.
- Es el cambio más grande del plan. La ley pide cifrado o seudonimización "apropiados" (14 quinquies a), sin exigir esta forma concreta. Por eso va al final y con la batería completa de tests.

### 4.6 Servidor
- Disco cifrado en el VPS.
- Respaldo de la base fuera del servidor (desde 0.3).
- Simulacro de restauración cada trimestre.

**Compuerta 4:**
- tests de purga y anonimización contra la base real;
- el simulador en verde con el teléfono cifrado;
- `pnpm simulate --external-dispatch` en verde;
- el panel cuadra antes y después de anonimizar.

---

## Etapa 5 — Gobierno continuo (después del piloto)

- **Registro de actividades de tratamiento** (`processing_activity`, art. 49 c).
- **Modelo de prevención de infracciones** certificable por la Agencia (arts. 49–51). Es atenuante (art. 36 n.° 5) y ordena todo lo anterior.
- **Auditoría externa y prueba de intrusión** al año.
- **Revisión anual de la evaluación de impacto**, y cada vez que cambie el agente, un proveedor o una finalidad.
- **Simulacro de incidente** con el municipio.
- **Seguimiento de las instrucciones y los contratos tipo** que publique la Agencia (34 bis e).

---

## Compuerta legal del piloto

Antes del primer dato real o del 1 de diciembre, lo que ocurra primero:

- [ ] L1–L4, L6 y L8 firmados; evaluación de impacto aprobada por el municipio.
- [ ] Etapas 0 y 1 completas; `tenant_readiness` del municipio piloto en verde.
- [ ] Etapa 2 completa (derechos con plazo, exportación y supresión completas).
- [ ] De la etapa 3, al menos 3.1 (faltas solo como conteo), 3.3 (teléfono enmascarado y registro de accesos) y 3.4 (alertas sensibles).

## Calendario propuesto

| Semana | Fechas | Desarrollo | Pista legal |
| --- | --- | --- | --- |
| 1 | 19–23 oct | Etapa 0 | L1 (proveedores y DPA) |
| 2–3 | 26 oct – 6 nov | Etapa 1 | L2 y L4 en redacción; L5 consultado |
| 4–5 | 9–20 nov | Etapa 2 | L3 evaluación de impacto; L6 y L8 |
| 6 | 23–27 nov | Etapa 3: 3.1, 3.3 y 3.4 | Firmas |
| **1 dic** | **Entra en vigencia** | | |
| 7–8 | 30 nov – 11 dic | Etapa 3: 3.2 y 3.5 | |
| dic–ene | | Etapa 4 | Plazos de conservación por municipio |
| feb → | | Etapa 5 | Modelo de prevención |

Si el piloto con datos reales parte después del 1 de diciembre, la compuerta legal del piloto manda sobre este
calendario.

## Mapa infracción → paso

| Infracción | Gravedad | Dónde se previene |
| --- | --- | --- |
| Deber de información, 34 bis a | Leve | 0.1, 1.3, L4 |
| Sin contacto para ejercer derechos, 34 bis b | Leve | 1.2 |
| Respuesta tardía o incompleta, 34 bis c | Leve | 2.1, 2.3 |
| Tratar sin base que se pueda probar, 34 ter a | Grave | 1.1, 0.5, L5 |
| Ceder sin autorización, 34 ter b | Grave | 1.4, L2, L7 |
| Datos innecesarios, 34 ter c | Grave | 0.4, 3.1, 3.2, 4.2 |
| Obstaculizar derechos, 34 ter e | Grave | 2.1–2.4 |
| No responder un bloqueo, 34 ter f | Grave | 2.1 |
| Menores, 34 ter g | Grave | 1.3, L5 |
| Secreto, 34 ter i | Grave | 0.2, 3.1, L6 |
| Seguridad, 34 ter j | Grave | 0.3, 3.5, 4.5, 4.6 |
| Registro de incidentes, 34 ter k | Grave | 0.6, 1.5 |
| Transferencia internacional, 34 ter m | Grave | 0.1, 1.4, L1 |
| Secreto de datos sensibles o de infracciones, 34 quáter d | Gravísima | 0.2, 3.1, 3.3, 3.4 |
| Datos sensibles o de menores, 34 quáter e | Gravísima | 3.4, 1.3 |
| Omitir un incidente a propósito, 34 quáter f | Gravísima | 0.6, 1.5, L8 |
| Incumplir una resolución de la Agencia, 34 quáter i | Gravísima | 2.1 |
| Sin evaluación de impacto, 34 quáter k | Gravísima | L3 |
| Salirse del encargo, 15 bis | Guard-IA pasa a responsable | 0.5, 1.4, L2 |

## Decisiones pendientes

| Decisión | De quién | Bloquea |
| --- | --- | --- |
| Proveedor de IA del piloto: Groq u OpenAI, según sus condiciones de retención y su DPA | Usuario | 0.1, L1 |
| Rol de Guard-IA en la cuenta del vecino | Abogado | 1.1, 2.2 |
| Qué finalidades van por consentimiento y cuáles por función municipal | Abogado | 1.1 |
| Política para menores de 14 | Abogado + municipio | 1.3 |
| Si las faltas son datos de infracciones administrativas | Abogado | Alcance de 0.2 y 3.1 |
| Qué conserva el municipio como registro (art. 22) y por cuánto | Municipio | 2.4, 4.1–4.3 |
