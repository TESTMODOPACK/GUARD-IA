# Guard-IA SOS para negocios — análisis y propuesta

Versión 18-10-2026 (análisis del 15-10-2026). **Estado: idea analizada, sin iniciar.** Se retoma después del piloto y de
las etapas 2–5 de `docs/plan-ley-21719.md`. Es un análisis técnico y de producto, no asesoría legal: lo marcado
**[abogado]** se valida antes de decidir. Nada de esto cambia lo que hoy hace Guard-IA.

## 1. La idea

Un botón de pánico para comercios (robo, asalto u otra urgencia) que, al activarse en forma **discreta**, avise a la
central municipal y le envíe la grabación de las cámaras del local como evidencia.

## 2. Respuesta corta

- **Técnicamente factible** y encaja con lo que Guard-IA ya hace: SOS que no espera, ruteo por comuna, central,
  despacho a terreno, bitácora inalterable.
- **Lo decisivo es lo legal**: conectar sistemas de seguridad electrónica a una central de monitoreo es una actividad
  de seguridad privada regulada (Ley 21.659). El modelo de negocio se define con un abogado antes de diseñar el
  producto (§7).
- **Ruta recomendada**: programa municipal para el comercio local, en alianza con una empresa de seguridad electrónica
  autorizada que instale los equipos (§8), partiendo por un MVP sin cámaras (§11).

## 3. Qué valor agrega

El local normalmente ya graba: el DVR registra todo el día. Los problemas son tres: el video queda en el mismo local,
los ladrones suelen llevarse o romper el DVR, y nadie mira en vivo. Guard-IA aportaría:

1. **Copia inmediata fuera del local**, incluidos los segundos **anteriores** al botón.
2. **Video en vivo para la central** mientras dura el evento: verificar que es real y orientar al despacho.
3. **Cadena de custodia**: huella del archivo (SHA-256), quién lo vio y quién lo exportó. El video sirve como evidencia.

## 4. Cómo conectarse a las cámaras

| Opción | Cómo funciona | Evaluación |
| --- | --- | --- |
| **Equipo local («Guard-IA Box»)** | Un mini PC escondido en la red del local lee las cámaras o el DVR por ONVIF/RTSP (estándar de casi todas las marcas) y mantiene un búfer de los últimos minutos | **Recomendada**: independiente de la marca y la única que asegura el minuto previo |
| API del grabador (Hikvision ISAPI, Dahua HTTP API) | Pide al DVR el clip del intervalo | Depende de la marca y del firmware; útil como complemento del Box |
| Nube del fabricante o VMS en la nube | Las cámaras ya suben a una nube | Pocas abren su API a terceros; costo por cámara; datos fuera de nuestro control |
| Cámara del teléfono | La app graba con el celular | Solo MVP: no es discreto y no ve el local completo |

### 4.1 Guard-IA Box (propuesta)

- **Hardware**: mini PC o equipo ARM con SSD, módem 4G de respaldo y, opcional, receptor para el botón inalámbrico.
  Escondido (no junto al DVR, que es lo primero que se llevan). Costo a cotizar.
- **Red**: conexión **solo saliente** (WebSocket o MQTT sobre TLS hacia la API). No se abren puertos del router ni se
  expone ninguna cámara. Varias cámaras económicas tienen firmware vulnerable: el Box es el único punto que habla con
  ellas.
- **Búfer**: `ffmpeg` graba cada cámara en segmentos cortos y conserva solo los últimos N minutos (anillo). Nada sale
  del local fuera de un evento.
- **Al activarse**, en este orden:
  1. una imagen fija de cada cámara (llega en 1–2 s);
  2. el clip previo (p. ej. 60 s) en baja resolución;
  3. video en vivo a la central mientras el evento esté abierto (relé de video, p. ej. MediaMTX: RTSP → WebRTC/HLS);
  4. la versión en alta resolución del clip, cuando haya ancho de banda.
- **Salud**: latido periódico; si el Box deja de responder, la central del municipio ve «Equipo sin conexión» (no es
  alerta, es aviso de mantenimiento).
- **Enrolamiento**: código de un solo uso generado desde la cuenta del establecimiento; el Box guarda una credencial
  propia (hash en la base, revocable). Actualizaciones firmadas.

**Ancho de banda y almacenamiento (orden de magnitud):**

| Concepto | Cálculo | Resultado |
| --- | --- | --- |
| Vivo, 4 cámaras en calidad media (substream) | 4 × 0,5–1 Mbps | 2–4 Mbps de subida durante el evento |
| Clip previo de 60 s, 4 cámaras | 4 × 1 Mbps × 60 s | ≈ 30 MB (decenas de segundos en fibra; más en 4G) |
| Búfer local de 5 min en alta (4 Mbps por cámara) | 4 × 4 Mbps × 300 s | ≈ 600 MB en el SSD |

## 5. Activación discreta

- **Formas de activar**: botón en la app (reutiliza el modo discreto actual), **botón inalámbrico** bajo el mesón,
  tecla en la caja (POS) y la entrada de alarma del propio DVR.
- **En el local no pasa nada visible**: ni sonido, ni luz, ni pantalla. La confirmación es una vibración o un LED
  oculto.
- **Protocolo de la central**: **no llamar al local durante el evento** (puede delatar a quien activó); para eso está el
  video en vivo.
- **Activaciones accidentales**: doble acción (mantener 3 s o dos pulsaciones) y la cancelación silenciosa que ya existe
  (30 s).
- **Clave de coacción**: una clave de «cancelar» que en apariencia anula la alerta pero en la central la marca como
  coacción. Práctica habitual en alarmas.
- **Redundancia**: el botón inalámbrico depende del Box; la app en el teléfono es la vía alternativa.

## 6. Cómo encaja con Guard-IA

### 6.1 Reglas actuales que se mantienen

| Regla (`CLAUDE.md`) | Cómo aplica |
| --- | --- |
| 1. El SOS nunca espera | La alerta se crea con la ubicación del local y responde; imágenes y video llegan después y se agregan a la ficha |
| 3. RLS es la frontera | Nuevo contexto para el Box: solo su establecimiento; el comercio ve sus eventos; el operador, por municipio y área como hoy |
| 5. Emisiones después del commit | «Video disponible» y «en vivo» se emiten tras guardar el registro del medio |
| 10. Bitácora en la misma transacción | Ver, descargar o exportar un video escribe `audit_log` |
| 14 y 17. Uso indebido | La escalera de faltas se aplica al establecimiento (y la Ley 21.659 sanciona la falsa alarma no verificada) |
| 18. Terreno | La unidad despachada podría ver una imagen fija del hecho (decisión abierta, §13) |
| 20. Ley 21.719 | Aviso, consentimiento y subencargados se extienden al video; sin datos reales fuera de producción |

### 6.2 Lo nuevo (tentativo; se diseña al retomar)

- **Establecimiento**: cuenta con dirección fija, validada por el municipio (puede usar la **patente comercial**
  municipal), y varios miembros (dueño, empleados) que son cuentas de la app.
- **Origen de alerta**: hoy `ALERT_SOURCES = BUTTON, VOICE, DISCREET, FORM` (shared). Se agregaría un origen para el
  pánico de comercio (botón físico o Box) y la alerta llevaría el establecimiento. El tipo sigue siendo
  `EMERGENCY_SOS`.
- **Medio de video**: hoy `MEDIA_KINDS = AUDIO, PHOTO`. Se agregaría `VIDEO` (y la imagen fija como `PHOTO`), con hash
  SHA-256 al subir, intervalo grabado, cámara de origen y si es previo o en vivo. Guardado sin posibilidad de
  borrarlo (*object lock* de MinIO/S3).
- **Retención por evidencia**: los 90 días actuales no alcanzan si hay causa. Una retención por evidencia (p. ej.
  `legal_hold_until`) suspende la purga mientras Fiscalía lo requiera [abogado].
- **Equipos**: Box (credencial, último latido, estado) y cámaras (nombre y zona del local, nunca zonas de descanso del
  personal).
- **Central**: ficha con imágenes, clip previo, video en vivo y botón **«Verificado»** antes de derivar a Carabineros
  (compatible con el art. 44 de la Ley 21.659).
- **Migración**: toma el siguiente número libre al momento de implementar.

## 7. Marco legal

### 7.1 Ley 21.659 de Seguridad Privada (vigente; reglamento Decreto 209, D.O. 27-05-2025)

- **Art. 3 n°1**: es actividad de seguridad privada «la instalación y mantenimiento de aparatos, equipos, dispositivos,
  componentes tecnológicos y sistemas de seguridad electrónica conectados a centrales receptoras de alarmas, centros de
  control o de videovigilancia, así como la operación de dichas centrales y centros».
- **Art. 41**: empresas de seguridad electrónica son las que instalan sistemas «con fines privados y conectados a
  centrales receptoras de alarmas, centros de control o de videovigilancia privados» y operan esas centrales.
- **Art. 42**: solo pueden actuar si están **autorizadas por la Subsecretaría de Prevención del Delito**, previo informe
  de la autoridad fiscalizadora.
- **Art. 43 y 84**: inscripción en el sub-registro de empresas de seguridad.
- **Art. 44**: si se conectan a una central de **Carabineros**, deben **verificar cada activación** y fijar en cada
  contrato la forma de uso de los dispositivos.
- **Art. 45**: el reglamento regula medios de verificación, monitoreo de alarmas y certificación de equipos.
- **Art. 4**: quienes ejercen seguridad privada deben coordinarse con Carabineros, **conservar y entregar las pruebas** y
  **denunciar dentro de 24 horas** los hechos que revistan caracteres de delito.

**Lectura provisional:**
- El art. 41 habla de fines y centrales **privados**. Una central **municipal** (seguridad pública) da un argumento
  para que el municipio no sea una empresa de seguridad electrónica [abogado].
- Pero el art. 3 n°1 no exige que la central sea privada: quien **instala y mantiene** los equipos conectados a ella
  (Guard-IA o un socio) probablemente ejerce una actividad de seguridad privada [abogado].
- La suscripción directa del comercio con monitoreo de Guard-IA (modelo B, §8) es seguridad privada sin duda: requiere
  autorización.
- Antes de diseñar la etapa N2, leer los medios de verificación del Decreto 209 y su modificación.

### 7.2 Ley 21.719 de protección de datos (rige el 01-12-2026)

- El video de personas identificables es **dato personal**: clientes, transeúntes y trabajadores.
- **Roles**: el comercio es responsable de sus cámaras; el municipio, de lo que recibe; Guard-IA, encargado de ambos.
  Puede haber corresponsabilidad [abogado].
- **Aviso visible** de videovigilancia en el local y en la app (principio de transparencia).
- **Sin reconocimiento facial ni identificación por voz**: los datos biométricos son sensibles (art. 2 g, art. 16 ter).
- **Evaluación de impacto** (art. 15 ter): probablemente obligatoria, como en el producto actual; validar qué caso aplica
  al monitoreo de locales abiertos al público [abogado].
- **Minimización**: nada sale del local sin un evento; acceso solo a quien atiende el caso; registro de cada acceso.
- **Derechos de las personas grabadas**: hace falta un procedimiento (quién responde, cómo se difumina a terceros al
  entregar copia).
- **Proveedor de almacenamiento**: es un subencargado más; entra en `tenant_subprocessor` y en el aviso.

### 7.3 Normas laborales (Dirección del Trabajo)

- Las cámaras deben tener **fin de seguridad** de personas o instalaciones, no de control exclusivo del trabajador.
- Deben figurar en el **reglamento interno de orden, higiene y seguridad**, que regula guardado, uso y revisión de las
  grabaciones.
- No pueden captar baños, vestidores, comedores ni salas de descanso; hay que informar a los trabajadores.
- La DT no autoriza ni certifica sistemas (Ord. N°408 de 06-06-2025).
- Que el municipio vea las cámaras **solo durante un evento activado** calza con este criterio.

### 7.4 Audio e imágenes privadas

- El art. 161-A del Código Penal sanciona captar o grabar, sin autorización, conversaciones o imágenes de carácter
  privado en recintos particulares o lugares que no son de libre acceso al público.
- Decisión propuesta: **sin audio**. Cámaras solo en zonas de atención y accesos. Bodegas u oficinas, con cuidado
  [abogado].

### 7.5 Evidencia

- El municipio no persigue el delito: entrega el material con la denuncia o cuando lo pide Fiscalía o Carabineros.
- Hash, *object lock* y bitácora de accesos sostienen la cadena de custodia. Plazo de conservación y forma de entrega
  [abogado].

## 8. Modelos de negocio

| Modelo | A favor | En contra |
| --- | --- | --- |
| **A. Programa municipal «Comercio protegido»**: el municipio financia los kits de un barrio comercial, conectados a su central | Misma venta que hoy (cliente municipal), argumento legal más fuerte, precedentes | Presupuesto y compras públicas |
| **B. Suscripción directa del comercio** | Ingreso recurrente, no depende del municipio | Seguridad privada sin duda (autorización), compite con empresas de alarmas |
| **C. Alianza con una empresa de seguridad electrónica autorizada** | Ella instala, mantiene y responde ante la Ley 21.659; Guard-IA aporta software y enlace municipal | Margen compartido |

**Recomendación**: empezar con **A + C**. B, solo con autorización propia.

**Precedentes:**
- Las Condes: central municipal y proyecto de botones de pánico (acta COSOC 2022).
- Vitacura: botón contra encerronas (2023).
- NEC Chile: botones de pánico residenciales para Las Condes (2016).
- Mar del Plata (Argentina): 391 botones de alerta de comercios y 451 cámaras privadas conectadas al centro municipal.

## 9. Riesgos y mitigación

| Riesgo | Mitigación |
| --- | --- |
| Falsas alarmas y saturación de la central | Doble acción, cancelación silenciosa, verificación por video, escalera de faltas |
| Seguridad del trabajador (si el ladrón lo nota, el riesgo sube) | Nada visible en el local; no llamar durante el evento; clave de coacción |
| Responsabilidad si la central tarda | Contrato: no reemplaza al 133; tiempos de servicio explícitos [abogado] |
| Cortan internet o se llevan el DVR | 4G de respaldo; imagen fija y clip previo suben en segundos; Box escondido |
| Diversidad de equipos (DVR analógicos sin ONVIF) | Lista de equipos soportados; instalación por el socio |
| Ciberseguridad de cámaras económicas | Box con conexión solo saliente; cámaras en red aislada cuando se pueda |
| Costo de soporte del hardware | Socio instalador (modelo C); latido y diagnóstico remoto |
| Privacidad de terceros grabados | Sin biometría ni audio; acceso registrado; difuminado al entregar copias |

## 10. Qué no hacer

- No transmitir video en forma continua a la central (no es necesario y choca con minimización y con la DT).
- No reconocimiento facial ni lectura de patentes (biometría y otro marco legal).
- No grabar audio.
- No conectar directo a Carabineros sin la verificación que exige el art. 44.
- No vender monitoreo privado (modelo B) sin autorización.

## 11. Hoja de ruta (después del piloto)

| Etapa | Alcance | Criterio de salida |
| --- | --- | --- |
| **N0 — Sin cámaras** | Cuenta de establecimiento validada por el municipio, botón en la app, origen de alerta nuevo, ficha en la central | Un municipio interesado; opinión legal (§12) recibida |
| **N1 — Piloto del Box** | 5–10 locales, 1–4 cámaras: imagen fija, clip previo, vivo, cadena de custodia, latido | Clip previo en la central en < 30 s; cero exposición de cámaras fuera de eventos |
| **N2 — Verificación y derivación** | Botón inalámbrico, tecla en caja, entrada de alarma del DVR, «Verificado» según Decreto 209, derivación formal a Carabineros | Procedimiento validado con el abogado y con Carabineros |
| **N3 — Escala** | Más marcas (ISAPI, Dahua), alianzas, suscripción directa si hay autorización | Según demanda |

## 12. Preguntas para el abogado

1. Un programa municipal con central del municipio, ¿queda bajo la Ley 21.659? ¿Quién debe autorizarse: Guard-IA, el
   instalador o nadie?
2. ¿Qué medios de verificación exige el Decreto 209 antes de comunicar una alarma a Carabineros?
3. Si Guard-IA o el socio ejerce seguridad privada, ¿le aplica el art. 4 (denunciar en 24 h, conservar pruebas)?
4. Ley 21.719: ¿quién es responsable del video (comercio, municipio o ambos)? ¿Qué caso del art. 15 ter aplica?
5. ¿Cuánto tiempo conservar el clip como evidencia y cómo entregarlo a Fiscalía?
6. ¿Basta el reglamento interno y el aviso a los trabajadores? ¿Qué pasa en locales sin reglamento interno (menos de
   10 trabajadores)?
7. ¿Qué responsabilidad civil asume Guard-IA si la central no responde a tiempo?

## 13. Decisiones abiertas (producto)

- ¿La unidad de terreno ve la imagen fija o el clip? (útil para reconocer al sospechoso; más datos en el teléfono).
- ¿El comercio ve el video de sus propios eventos en la app, o solo el municipio?
- ¿Cuántos minutos de búfer y cuánto dura el vivo por evento?
- ¿Precio por local, por cámara o por barrio (modelo A)?

## Fuentes

- Ley 21.659: [texto](https://alog.cl/wp-content/uploads/2025/10/Ley-21659_21-MAR-2024.pdf) y
  [Diario Oficial, 21-03-2024](https://www.diariooficial.interior.gob.cl/publicaciones/2024/03/21/43807/01/2468993.pdf)
- [Reglamento, Decreto 209 (Diario Oficial, 27-05-2025)](https://www.diariooficial.interior.gob.cl/publicaciones/2025/05/27/44158/01/2649270.pdf)
- [IAPP: el reglamento de seguridad privada y la protección de datos](https://iapp.org/news/a/el-reglamento-de-seguridad-privada-de-la-ley-n-21-659-y-la-protecci-n-de-datos-personales-en-chile)
- [24horas: qué dice la ley de seguridad privada](https://www.24horas.cl/data/ley-chile/que-dice-ley-seguridad-privada)
- [Dirección del Trabajo: cámaras de vigilancia](https://dt.gob.cl/legislacion/1624/w3-propertyvalue-150994.html)
- [Las Condes, acta COSOC 14-06-2022](https://archivos.lascondes.cl/descargas/municipalidad/consejo_economico/actas/2022/SESION-ORD.COSOC-N5-14-JUNIO-2022.pdf)
- [Vitacura: botón de pánico antiencerronas](https://www.mediabanco.com/vitacura-activo-el-boton-de-panico-antiencerronas/)
- [Mar del Plata: botón de alerta para comercios](https://www.lacapitalmdp.com/mas-comercios-solicitan-al-municipio-el-boton-de-alerta/)
- [NEC Chile: botones de pánico residenciales](https://www.acnnewswire.com/press-release/english/31662/nec-chile-to-provide-residential-security-solution-for-more-than-15,000-households)
- Ley 21.719 aplicada a Guard-IA: `docs/legal/ley-21719-guard-ia.pdf`
