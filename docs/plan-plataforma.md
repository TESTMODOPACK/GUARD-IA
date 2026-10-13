# Plataforma y Operación Guard-IA: requerimientos y plan de implementación

Borrador 1, 13-10-2026. Versión para leer y compartir: Artifact "Plataforma y Operación Guard-IA".
Cubre la consola de plataforma (superadministrador) y dos políticas de operación municipal que la afectan:
reportes falsos o mal hechos (5b) y la unidad en terreno que informa a la central (5c).

## 1. Resumen

Guard-IA tiene hoy dos niveles: el vecino (app) y la central de cada municipio (roles ADMIN, SUPERVISOR,
OPERATOR, siempre dentro de un municipio). Falta el tercer nivel, la **plataforma**: el equipo de Guard-IA,
que decide qué comunas tienen el servicio, con qué plan, cuánto se cobra y cómo está funcionando cada una.
La administración se organiza por región, como se organiza el país y como compran los municipios
(asociaciones municipales y gobiernos regionales).

Punto de partida (base local, 13-10-2026):

| Pieza | Estado |
| --- | --- |
| Comunas | 345 cargadas (DPA 2023 SUBDERE, `comuna` y `comuna_part`), con región; falta la provincia |
| Municipios | 1 ("Municipio Demo"), creado por línea de comandos (`pnpm seed`), sin comuna ni contrato |
| Activar o suspender | Solo `tenant.active` (boolean), sin interfaz |
| Planes, contratos, facturación | No existen |
| Errores y fallas | Solo en el log de la API (pino); `alert.ai_error` por alerta |
| Métricas | Prometheus en `/metrics` (latencia del SOS, IA, alertas creadas), sin panel |
| Auditoría | `audit_log` por municipio (0003); no hay bitácora de plataforma |

## 2. Roles de plataforma

| Rol | Puede | No puede |
| --- | --- | --- |
| Superadministrador | Todo, incluidos los usuarios de plataforma | Ver datos de vecinos sin un acceso de soporte |
| Implementación y comercial | Comunas, municipios, planes, contratos, administradores municipales | Facturar, ver errores con detalle técnico |
| Finanzas | Contratos (lectura), facturas, pagos, reportes de ingresos | Activar o suspender municipios |
| Soporte técnico | Bitácora de errores, salud, métricas, acceso temporal a un municipio | Cambiar planes o facturar |
| Coordinador regional (fase posterior) | Ver métricas y estado de las comunas de una o más regiones | Cambiar nada |

Principio: Guard-IA es **encargado de tratamiento** de los datos del vecino y el municipio es el responsable
(Ley 21.719). La plataforma ve metadatos y cifras agregadas; nunca teléfonos, nombres, textos ni audios,
salvo un acceso de soporte explícito, temporal, justificado y visible para el municipio.

## 3. Requerimientos funcionales

### M1. Regiones y comunas
- **RF-1.1** Navegación por región (las 16, de norte a sur), luego provincia y comuna. Cada región muestra su
  resumen: comunas activas sobre el total, en implementación, suspendidas, alertas del mes y demanda no
  atendida.
- **RF-1.2** Mapa de Chile coloreado por estado, con acercamiento a la región elegida.
- **RF-1.3** Estado de cada comuna: Disponible, En negociación, En implementación, Activa, Suspendida, De baja.
  Filtros por región, provincia y estado; búsqueda por nombre o CUT.
- **RF-1.4** Demanda no atendida: SOS y reportes por comuna sin servicio (alertas "sin cobertura"), solo
  cifras agregadas, sumadas por región. Es el insumo comercial más directo.
- **RF-1.5** Selección múltiple dentro de una región para un mismo contrato (asociación de municipios o
  gobierno regional) y para acciones en grupo: pasar a "En negociación", asignar responsable comercial.
- **RF-1.6** Historial de cambios de estado de cada comuna.

### M2. Planes
- **RF-2.1** Catálogo versionado: nombre, precio mensual neto en UF, límites (operadores, unidades,
  clasificaciones de IA por mes, minutos de audio, SMS por mes, almacenamiento, retención máxima de audio) y
  funciones incluidas.
- **RF-2.2** Cambiar un precio crea una versión nueva; los contratos vigentes conservan la suya.
- **RF-2.3** Límites blandos: aviso al 80 % y al 100 %. Un límite nunca bloquea un SOS.

### M3. Municipios
- **RF-3.1** Alta desde una comuna: el municipio toma el límite oficial de la comuna (sin dibujar polígonos),
  más razón social, RUT, dirección, contacto técnico y de facturación.
- **RF-3.2** Lista de puesta en marcha, que debe estar completa para activar:
  administrador municipal con contraseña propia; al menos 2 operadores; directorio con Carabineros, SAMU,
  Bomberos y seguridad municipal; al menos 1 unidad; turnos de la primera semana; contrato y anexo de
  tratamiento de datos firmados; prueba de extremo a extremo aprobada.
- **RF-3.3** Activar: desde ese momento las alertas de la comuna llegan a esa central (el ruteo por comuna ya
  existe en la base). Se confirma escribiendo el nombre de la comuna y queda en la bitácora.
- **RF-3.4** Modo prueba durante la implementación: solo los teléfonos de prueba del municipio llegan a la
  central; los vecinos reales siguen viendo "fuera de cobertura".
- **RF-3.5** Suspender (mora o a pedido): **nunca corta el SOS**. La central sigue recibiendo; se limitan
  funciones no críticas (exportaciones, usuarios nuevos) y se avisa al administrador municipal.
- **RF-3.6** Dar de baja (fin de contrato): las alertas nuevas pasan a "fuera de cobertura, llama al 133";
  se entrega la exportación de datos al municipio y se programa la purga según contrato. Doble confirmación.
- **RF-3.7** Configuración por municipio: retención de audio, nombre y logo en la app, teléfono de seguridad
  municipal que ve el vecino.

### M4. Usuarios
- **RF-4.1** Usuarios de plataforma con rol, segundo factor obligatorio (TOTP), bloqueo por intentos y
  sesiones cortas.
- **RF-4.2** Alta del administrador municipal desde la plataforma, con invitación de un solo uso (o la
  contraseña temporal que ya existe), que obliga a definir la propia.
- **RF-4.3** Restablecer el acceso de un administrador municipal, con registro en ambas bitácoras.
- **RF-4.4** Acceso de soporte a un municipio: motivo y duración (máximo 4 horas), solo lectura por defecto,
  visible en la bitácora del municipio.

### M5. Contratos y facturación
- **RF-5.1** Cliente que paga: una municipalidad, una asociación de municipios o un gobierno regional, con
  RUT y contacto de facturación. Un contrato puede cubrir varias comunas de una región.
- **RF-5.2** Contrato: cliente, comunas cubiertas, plan y versión, inicio, término, renovación, precio
  pactado en UF, modalidad de compra en Mercado Público (convenio marco, licitación o trato directo), número
  de orden de compra, decreto o resolución, documentos adjuntos.
- **RF-5.3** Cierre mensual: cobro del plan más excedentes (si el plan los tiene), convertido a pesos con la
  UF del día de emisión, IVA 19 %, como prefactura revisable.
- **RF-5.4** Factura electrónica (DTE 33) mediante un proveedor certificado por el SII; se guardan folio,
  PDF, XML y estado. Notas de crédito (DTE 61) para anular.
- **RF-5.5** Pagos y estados: emitida, pagada, vencida (más de 30 días, Ley 21.131), anulada.
- **RF-5.6** Mora: avisos a los 30, 45 y 60 días; la suspensión la decide una persona; nunca afecta el SOS.
- **RF-5.7** Reportes: ingreso mensual recurrente (UF y pesos), cuentas por cobrar, por cliente y por región.

### M6. Bitácora de errores y registro de fallas
- **RF-6.1** Registro central de errores de la API, el worker de IA, la central y la app: fecha, componente,
  severidad, municipio y región (si aplica), código, mensaje, id de solicitud. Los repetidos se agrupan por
  huella y se cuentan.
- **RF-6.2** Fallas operacionales con nombre propio: IA no disponible (con causa: cuota, red, certificado),
  transcripción fallida, SMS de ingreso no enviado, push no entregado, SOS que tardó más de 1 s en llegar a la
  central, despacho sin cierre, central sin operadores conectados con un SOS pendiente, base lenta.
- **RF-6.3** Estados: nueva, en revisión, resuelta; responsable y notas.
- **RF-6.4** Avisos a soporte por reglas (correo, luego Slack o WhatsApp): IA falla más de 5 veces en 10
  minutos, SOS lento, municipio sin operadores con SOS pendiente.
- **RF-6.5** Sin datos personales: se guardan ids, nunca teléfonos, textos, transcripciones ni tokens.

### M7. Métricas de utilización
- **RF-7.1** Operación por municipio, por región y total, por período: SOS y reportes por categoría; tiempos
  de recepción a acuse, acuse a despacho y total; porcentaje atendido; operadores activos; vecinos
  registrados.
- **RF-7.2** Consumo (facturable y de costo): clasificaciones de IA, minutos transcritos, SMS, push,
  almacenamiento; comparado con el límite del plan.
- **RF-7.3** Calidad del agente: clasificaciones corregidas por operadores (`triage_label`), fallas de IA,
  respaldos por reglas, traspasos automáticos entre municipios (incluidos los que cruzan de región).
- **RF-7.4** Salud técnica: latencia del SOS (p95), cola de IA, errores 5xx, conexiones en tiempo real.
- **RF-7.5** Panel global, por región y por municipio, con tendencias; exportación CSV.

### M8. Bitácora de plataforma
- **RF-8.1** Toda acción de la consola (activar, suspender, cambiar plan, facturar, acceso de soporte, alta de
  usuarios) queda en un registro de solo inserción, con IP y motivo.

## 4. Requerimientos no funcionales
- **Aislamiento**: la consola puede caer sin afectar el SOS ni la central.
- **Seguridad**: dominio propio, segundo factor, tokens de plataforma distintos de los de operador, roles
  mínimos, límite de intentos, CSP estricta.
- **Base de datos**: contexto RLS nuevo `platform` que ve metadatos de todos los municipios y no ve tablas con
  datos personales; ninguna llave primaria de texto; auditoría de solo inserción.
- **Dinero**: pesos como entero (`bigint`), UF con 4 decimales (`numeric`), UF diaria de fuente oficial (CMF).
- **Escala**: métricas precalculadas por día (`usage_daily`), no consultas en vivo sobre `alert`; los totales
  por región salen de sumar esas filas.
- **Retención**: alertas "fuera de cobertura" con retención corta; errores 90 días.

## 5. Cómo llegan las alertas según el estado de la comuna

| Estado de la comuna | SOS y reportes del vecino |
| --- | --- |
| Activa | Llegan a la central del municipio; el agente traspasa si el hecho ocurre en otra comuna activa |
| En implementación | Solo los teléfonos de prueba llegan a la central; el resto ve "fuera de cobertura" |
| Suspendida | Siguen llegando igual (el SOS nunca se corta) |
| Sin servicio o de baja | "Estás en X, que aún no usa Guard-IA: llama al 133/131/132"; cuenta como demanda no atendida |

## 5b. Reportes falsos o mal hechos (uso indebido)

### Estado actual
- Rechazar con motivo "Falsa alarma" baja la confianza del vecino 25 puntos (de 100); con menos de 25, su SOS
  entra como prioridad media. Resolver un caso la sube 5.
- No hay advertencia al vecino ni historial de faltas. El accidental (SOS en el bolsillo) y el intencional
  (broma) penalizan igual.
- El diálogo de rechazo de la central parte marcado en "Falsa alarma": un rechazo apurado sanciona sin querer.
- `citizen.blocked_at` impide entrar a la app (incluido el SOS); hoy solo lo usa la supresión de cuenta.

### Principios
1. **Distinguir buena fe de engaño.** Solo el engaño intencional cuenta como falta.
2. **Nunca dejar a alguien sin camino ante una emergencia real.** Ni la advertencia ni el bloqueo agregan
   pasos al SOS; una cuenta bloqueada ve en la app los botones para llamar al 133, 131 y 132.
3. **Escalera, no castigo inmediato.** Advertencia, restricción y, al final, bloqueo temporal.
4. **Dos personas para bloquear.** El operador propone, el supervisor aprueba. La IA solo sugiere (su señal
   "posible falsa alarma" nunca sanciona sola).
5. **Debido proceso.** El vecino ve su estado, por qué y hasta cuándo, y puede pedir revisión.

### Motivos de rechazo y efecto
| Motivo (lo elige el operador, sin valor por defecto) | Ejemplo | Efecto en la cuenta | Mensaje al vecino |
| --- | --- | --- | --- |
| Activación accidental | SOS por botón sin habla, cancelado tarde | Ninguno | "Cerramos tu alerta: parece una activación accidental." |
| Mal reportado, de buena fe | Era un reporte urbano, categoría o lugar equivocados | Ninguno | Orienta: cómo reportar un bache, una luminaria |
| Duplicada | La situación ya está en atención | Ninguno | "Ya estamos atendiendo esta situación." |
| Fuera del ámbito | No corresponde al municipio | Ninguno | Orienta a la institución que corresponde |
| Prueba | "Estoy probando la app" | Primera vez, aviso; si se repite, cuenta como falta | "La app es solo para emergencias reales." |
| **Falsa alarma intencional** | Broma, engaño, acoso a un tercero | **Falta** | Advertencia formal (ver escalera) |

### Escalera (faltas en los últimos 90 días)
| Faltas | Consecuencia | Quién decide |
| --- | --- | --- |
| 1 | Advertencia en la app y por push: "Recibimos un aviso falso desde tu cuenta el 13-10 a las 21:30. Usar el SOS sin una emergencia real resta recursos a quien sí los necesita. Si se repite, tu cuenta quedará restringida." | Operador, con nota |
| 2 | Segunda advertencia; cuenta **restringida**: el SOS sigue llegando, pero con prioridad media y la marca "2 falsas alarmas en 90 días"; no puede enviar reportes urbanos | Operador, con nota |
| 3 | Propuesta de **bloqueo** por 30 días (reincidencia: 6 meses). La app muestra los números de emergencia en lugar del botón SOS | Supervisor aprueba |
| Bloqueo indefinido | Solo para acoso o reincidencia grave | Administrador municipal, visible para la plataforma |

Las faltas vencen a los 90 días. Un supervisor puede anular una falta mal puesta (se restaura la confianza y se
avisa al vecino). El registro de faltas es dato personal: entra en la exportación de "Mis datos" y se borra
según la política de retención.

### Cómo lo maneja el operador
1. **Rechazar** obliga a elegir el motivo; no hay uno marcado por defecto.
2. Con "Falsa alarma intencional": nota obligatoria con la evidencia (qué se escuchó o se habló), y la ficha
   muestra el historial del vecino y la consecuencia que se aplicará ("se enviará la 2.ª advertencia").
3. La tercera falta crea una propuesta de bloqueo en la cola **"Bloqueos por aprobar"** del supervisor.
4. Todo queda en la línea de tiempo de la alerta y en la bitácora del municipio.

### Qué ve el vecino
- En "Mis datos", **Estado de tu cuenta**: advertencias vigentes, hasta cuándo y el motivo; botón **Pedir
  revisión** con un texto breve, que llega a la central que sancionó.
- La advertencia aparece al abrir la app, nunca en el camino del SOS.

### Varios municipios y plataforma
- La cuenta del vecino es una sola para todo el país: una restricción o bloqueo rige en todas las comunas, con
  el municipio que lo decidió a la vista. Las revisiones las resuelve ese municipio.
- La consola de plataforma ve la tasa de falsas alarmas por municipio y región, las cuentas bloqueadas y las
  revisiones pendientes (sin datos personales).
- Asesoría legal pendiente: texto de las advertencias y términos de uso, y si corresponde denunciar avisos
  falsos reiterados.

### Datos
| Tabla | Llave | Contenido |
| --- | --- | --- |
| `reject_reason` (enum, ampliar) | | + `ACCIDENTAL`, `MISREPORTED`; `FALSE_ALARM` pasa a significar "intencional" |
| `citizen_strike` | uuid | vecino, municipio, alerta, tipo, nota, quién decidió, fecha, vence, anulada por |
| `citizen_restriction` | uuid | vecino, nivel (restringida, bloqueada), desde, hasta, propuso, aprobó, motivo, revisión pedida y resultado |
| `citizen_notice` | uuid | vecino, tipo de aviso, alerta, texto, enviado, leído |

## 5c. Operación en terreno: la unidad informa a la central

### Estado actual
- Las unidades (patrulla, moto, inspector) son vehículos sin personas asociadas. El estado del despacho
  (asignada, en camino, en el lugar, cerrado, cancelado) lo cambia el operador de la central, normalmente por
  lo que le dicen por radio. El vecino ya recibe esos cambios ("la unidad va en camino").
- No hay forma de que la unidad informe directamente, ni de registrar qué encontró al llegar.

### Requerimientos
- **RT-1 Funcionario de terreno**: usuario nuevo del municipio (rol `FIELD`) que al iniciar turno elige su
  unidad. Entra desde el teléfono con la misma cuenta de la central.
- **RT-2 Recibe el despacho**: aviso en el teléfono con la categoría, el resumen, el lugar mencionado, las
  preguntas sugeridas y el botón para navegar. Botones grandes: **Voy en camino**, **Llegué**.
- **RT-3 Informa el resultado** al terminar o cuando cambia la situación:

| Resultado | Qué significa | Qué pasa |
| --- | --- | --- |
| Atendido | Se resolvió en el lugar | La central ve "pendiente de cierre" y cierra con un clic |
| Derivado | Se entregó a Carabineros, SAMU o Bomberos | Se registra a quién (alimenta "Derivado a…") |
| En proceso, pide apoyo | Sigue en el lugar y necesita otra unidad o una institución | Aviso urgente con sonido en la central |
| No se encontró nada | Nadie en el lugar, sin señales del hecho | La central decide: volver a llamar al vecino o cerrar |
| Era otra situación | Lo que había no era lo reportado (ej. una riña, no un asalto) | La unidad elige la categoría real; la central la aplica con un clic y queda como clasificación de terreno |
| Falsa alarma confirmada | Se comprobó que fue broma o engaño | Evidencia para la falta del vecino; la sanción sigue la escalera de uso indebido |

- **RT-4 Nota y foto**: texto corto y fotos opcionales con cada actualización (se guardan como el resto del
  material, con la misma retención).
- **RT-5 Ubicación**: el teléfono envía la posición de la unidad mientras tiene un despacho abierto; la central
  la ve en el mapa (la unidad ya tiene ubicación en la base).
- **RT-6 Pánico del funcionario**: un botón para cuando el propio funcionario está en peligro; llega a la
  central como la máxima prioridad, con su ubicación.
- **RT-7 Plazos**: si la unidad no marca "en camino" en 2 minutos o no da noticias en el tiempo esperado, la
  central recibe un aviso ("sin noticias de PATRULLA-101"), que también entra en el registro de fallas.
- **RT-8 La central manda**: la unidad informa, el operador cierra. Así la central sigue a cargo del caso y del
  aviso al vecino. Si la central está sin operadores, el resultado queda registrado y el caso sigue abierto.
- **RT-9 Sin radio, igual**: el operador puede registrar el mismo resultado desde la central con lo que le
  informan por radio (primer paso, antes de que exista la app de terreno).

### Lo que ganan los demás módulos
- **Agente de clasificación**: "Era otra situación" es la mejor etiqueta para medir y mejorar la IA (lo que
  se vio en el lugar, no solo lo que oyó el operador).
- **Uso indebido**: "Falsa alarma confirmada" es la evidencia más sólida para una falta.
- **Métricas**: tiempo de llegada real, casos resueltos en el lugar, apoyo pedido por tipo.

### Cómo se construye
- Primera versión: aplicación web para el teléfono dentro de la central (`/terreno`), sin tiendas de
  aplicaciones, con la sesión de la central. Si hace falta, después una app nativa.
- Datos: `dispatch` suma resultado, nota, categoría de terreno, quién y cuándo informó; las actualizaciones
  quedan como eventos de la alerta (`FIELD_UPDATE`, `SUPPORT_REQUESTED`, `FIELD_PANIC`); `triage_label` suma
  la clasificación de terreno; `shift` suma la unidad del turno.

## 6. Modelo de datos propuesto

| Tabla | Llave | Contenido |
| --- | --- | --- |
| `region` | `cut` smallint | nombre, orden de norte a sur (de la DPA) |
| `comuna` (ampliar) | `cut` integer | + `provincia_cut`, `provincia_name` (vienen en la DPA: `CUT_PROV`, `PROVINCIA`); `region_cut` pasa a FK |
| `tenant` (ampliar) | uuid | `status` (ONBOARDING, ACTIVE, SUSPENDED, TERMINATED) en vez de `active`; razón social, RUT, contactos, `go_live_at` |
| `customer` | uuid | quien paga: municipalidad, asociación o gobierno regional; RUT, contacto de facturación |
| `plan` | uuid | código, nombre, versión, precio UF, límites, funciones, vigente |
| `contract` | uuid | cliente, plan, fechas, precio pactado, modalidad de compra, orden de compra, decreto, estado |
| `contract_tenant` | (contrato, municipio) | comunas que cubre cada contrato |
| `platform_user` | uuid | email, nombre, rol, regiones (para el coordinador), hash, secreto TOTP cifrado, bloqueo, último ingreso |
| `platform_audit_log` | uuid | actor, acción, municipio, objetivo, datos, IP, fecha (solo inserción) |
| `support_access` | uuid | usuario de soporte, municipio, motivo, desde, hasta, revocado |
| `error_group` | uuid | huella (única), componente, severidad, código, mensaje, primera y última vez, conteo, estado, responsable |
| `error_event` | bigint | grupo, fecha, municipio, id de solicitud, contexto sin datos personales (particionada por mes) |
| `usage_daily` | (municipio, día, métrica) | cantidad por día y métrica (alertas, IA, minutos, SMS, push, GB) |
| `uf_value` | fecha | valor UF del día, fuente |
| `invoice` / `invoice_line` | uuid | cliente, período, UF, neto, IVA, total, estado, folio SII, vencimiento, archivos |
| `payment` | uuid | factura, monto, fecha, medio, referencia |

## 7. Arquitectura
- API: módulo `platform/` en la misma API NestJS, guard propio (`kind: 'platform'`), contexto RLS `platform`,
  rutas `/v1/platform/*`.
- Interfaz: app nueva `apps/platform` (Next.js) en dominio propio, para separar sesión, cookies, CSP y
  despliegue de la central. Reutiliza los componentes visuales de la central.
- Errores: filtro global de excepciones y el logger existente escriben en `error_group`/`error_event`; la
  central y la app reportan por `POST /v1/telemetry/errors` (sin datos personales). Sentry o GlitchTip quedan
  como opción posterior.
- Métricas: Prometheus ya existe para lo técnico (Grafana en el VPS); `usage_daily` para lo de negocio.
- Facturación: proveedor de DTE certificado por el SII (a elegir); UF desde la API de la CMF.

## 8. Plan por fases

| Fase | Contenido | Esfuerzo | Cuándo |
| --- | --- | --- | --- |
| P1 Base de plataforma | Usuarios de plataforma con TOTP, guard y contexto RLS, bitácora de plataforma, `tenant.status`, regiones y provincias, navegación región → provincia → comuna con resumen y mapa, alta de municipio desde comuna, invitación al administrador municipal, activar/suspender/baja, lista de puesta en marcha, modo prueba | 6 días | Antes del piloto |
| PU Uso indebido | Motivos de rechazo nuevos y sin valor por defecto, faltas con vencimiento, advertencias en la app y por push, cuenta restringida, propuesta y aprobación de bloqueo, "Estado de tu cuenta" y pedir revisión, números de emergencia en la app bloqueada | 4 a 5 días | Antes del piloto (al menos motivos y advertencias) |
| PT Terreno | Resultados del despacho registrados desde la central (RT-9); después la app web de terreno: funcionario con unidad, recibir despacho, en camino y llegué, resultado con nota y foto, ubicación, pedir apoyo, pánico del funcionario, plazos | 1 a 2 días, más 5 la app | Resultados antes del piloto; app durante el piloto |
| P2 Errores y salud | `error_group`/`error_event`, filtro global, reporte desde central y app, panel de fallas con estados, avisos por correo, panel de salud | 4 días | Antes del piloto |
| P3 Métricas de uso | `usage_daily` (job nocturno y contadores), panel global, por región y por municipio, límites del plan con avisos, calidad del agente | 4 días | Durante el piloto |
| P4 Planes y contratos | Clientes, catálogo de planes versionado, contratos de una o varias comunas, documentos, renovaciones y avisos de vencimiento | 3 a 4 días | Antes del primer cobro |
| P5 Facturación | UF diaria, cierre mensual y prefactura, emisión DTE, pagos, mora, reportes de ingresos por cliente y región | 6 días más la integración | Antes del primer cobro |
| P6 Soporte y comercial | Acceso temporal de soporte, avisos a municipios, demanda no atendida por región, seguimiento comercial, coordinador regional | 3 a 4 días | Después |

## 9. Decisiones pendientes
1. Modelo de precio: tramos por población, plan fijo con límites, o fijo más variable por uso (IA y SMS).
2. Proveedor de factura electrónica, o emisión manual al comienzo.
3. Consola como app aparte en dominio propio (recomendado) o sección de la central.
4. Registro de errores propio (recomendado para el piloto) o Sentry/GlitchTip.
5. Qué se limita al suspender por mora (propuesta: nada del SOS ni de la central).
6. Modo prueba durante la implementación (propuesta: sí, por teléfonos de prueba).
7. Contratos regionales: ¿una asociación o un gobierno regional puede pagar por varias comunas con una sola
   factura? (el modelo lo permite con `customer` y `contract_tenant`).
8. Cuenta bloqueada: ¿la app reemplaza el SOS por los números de emergencia (recomendado) o el SOS sigue
   llegando a la central con la marca "cuenta bloqueada"?
9. Escalera de uso indebido: ¿se aceptan 3 faltas en 90 días y 30 días de bloqueo como punto de partida?
10. Terreno: ¿app web dentro de la central (recomendado para el piloto) o app nativa desde el comienzo? ¿Cada
    funcionario con su cuenta (recomendado, por trazabilidad) o una cuenta por unidad?

## 10. Riesgos
- Cortar el servicio a un municipio deja a los vecinos sin canal: la suspensión nunca corta el SOS y la baja
  exige doble confirmación y aviso.
- Un superadministrador comprometido afecta a todos los municipios: segundo factor obligatorio, sesiones
  cortas, IP permitidas opcionales y bitácora inmutable.
- Datos personales en los logs: sanitizar en el origen y revisar con tests.
- Costo de IA sin control: métricas de consumo por municipio y límites por plan.
