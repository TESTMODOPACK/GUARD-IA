# Procedimiento ante incidentes de seguridad de datos personales

Borrador 1, 15-10-2026. Paso 0.6 de `docs/plan-ley-21719.md`. Lo firman Guard-IA y cada municipio (pista legal L8).
Los plazos internos son una propuesta: la ley dice «por los medios más expeditos posibles y sin dilaciones indebidas»
y no fija horas. **[abogado]** valida el texto antes de firmarlo.

## Qué es un incidente

Toda vulneración de las medidas de seguridad que cause **destrucción, filtración, pérdida o alteración**, accidental
o ilícita, de datos personales, o su **comunicación o acceso no autorizado** (Ley 21.719, art. 14 sexies).

Ejemplos en Guard-IA:

- **Equipos y credenciales:**
  - un computador de la central, robado o perdido con la sesión abierta;
  - la contraseña de una cuenta de la central compartida o filtrada;
  - una clave del servidor expuesta: `.env`, token de Expo, llave de S3 o del proveedor de IA.
- **Mal uso de los datos:**
  - un funcionario que consulta fichas o teléfonos de vecinos sin relación con su trabajo;
  - audio, fotos o una exportación enviados a quien no correspondía.
- **Fallas del sistema:**
  - una falla que muestra a un municipio alertas de otro, o a un área alertas que no le tocan;
  - un respaldo expuesto (si está cifrado y la clave privada no se filtró, el riesgo es bajo, pero igual se registra);
  - pérdida de datos sin respaldo que permita recuperarlos.

**Ante la duda, se declara.** Registrar un hecho que después resulta menor no tiene costo. No registrarlo, o
callarlo a propósito, sí: la omisión deliberada es infracción **gravísima** (art. 34 quáter f).

## Quién hace qué

| Rol | Quién | Responsabilidad |
| --- | --- | --- |
| Encargado | Guard-IA | Detecta, contiene, registra y **avisa al municipio** (art. 15 bis). Nunca avisa a la Agencia en nombre del municipio sin que este lo pida por escrito |
| Responsable | Cada municipio | Evalúa el riesgo, **reporta a la Agencia** y, cuando corresponde, **avisa a los vecinos** (art. 14 sexies) |
| Coordinador del incidente | Guard-IA: [nombre y suplente] | Declara el incidente, abre el registro y coordina hasta el cierre |
| Contacto del municipio | Delegado de protección de datos: [nombre, correo, teléfono] | Recibe el aviso de Guard-IA y decide los avisos del municipio |

Cualquier persona de Guard-IA o del municipio que vea algo raro lo informa de inmediato al coordinador. No hace
falta estar seguro.

## Pasos

| # | Paso | Quién | Plazo interno propuesto |
| --- | --- | --- | --- |
| 1 | **Declarar.** El coordinador abre el registro (consola de plataforma, página «Incidentes», desde el paso 1.5; antes, una planilla con los mismos campos) | Coordinador | Apenas se sabe |
| 2 | **Contener.** Cortar el acceso: cerrar sesiones, desactivar la cuenta, rotar la clave expuesta, aislar el equipo. **No borrar evidencia** (logs, bitácora, archivos) | Guard-IA | Mismo día |
| 3 | **Evaluar.** Qué datos, de cuántos vecinos y de qué municipios. ¿Hay datos sensibles (contenido de alertas de violencia o salud), de menores de 14 o económicos? ¿Hay riesgo razonable para sus derechos? | Coordinador + delegado | 24 h |
| 4 | **Avisar al municipio.** Con la plantilla A, aunque la evaluación no haya terminado | Guard-IA | 24 h desde que se confirma |
| 5 | **Reportar a la Agencia**, si hay riesgo razonable para los vecinos, por el canal que ella defina. Plantilla B | Municipio | Sin dilación; meta de 72 h |
| 6 | **Avisar a los vecinos afectados** si hay datos sensibles, de menores de 14 o económicos. Plantilla C, en lenguaje claro y uno por uno (en la app y por SMS). Si no se puede llegar a cada uno, un aviso en un medio de comunicación masivo de alcance nacional | Municipio, con apoyo de Guard-IA | Junto con el paso 5 |
| 7 | **Cerrar.** Causa, medidas para que no se repita y fecha de cada aviso en el registro. Revisar la evaluación de impacto si cambió un riesgo | Coordinador | 30 días |

En Guard-IA casi todo el contenido de una alerta puede ser dato sensible: el texto, la transcripción y el audio
describen violencia, salud o situaciones de menores. Por eso, una filtración de contenido de alertas casi siempre
obliga a avisar a los vecinos (paso 6).

## Qué se registra

El registro es obligatorio aunque no se reporte a la Agencia (art. 14 sexies, inciso 2). Contiene:

- **Hechos:**
  - fecha y hora de detección y de inicio estimado;
  - quién lo detectó;
  - naturaleza: destrucción, filtración, pérdida, alteración o acceso no autorizado;
  - efectos.
- **Alcance:**
  - categorías de datos afectados;
  - número aproximado de vecinos;
  - municipios afectados.
- **Medidas y avisos:**
  - medidas de contención y para precaver incidentes futuros;
  - fecha del aviso al municipio, del reporte a la Agencia y del aviso a los vecinos, o por qué no correspondía.

## Plantillas

**A · Guard-IA al municipio**
> Asunto: Incidente de seguridad de datos personales — [código]
> El [fecha y hora] detectamos [qué ocurrió]. Datos posiblemente afectados: [categorías]. Vecinos aproximados de su
> municipio: [n]. Medidas tomadas: [contención]. Próxima actualización: [fecha y hora]. Contacto: [coordinador].

**B · Municipio a la Agencia**
> Naturaleza de la vulneración, efectos, categorías de datos, número aproximado de titulares afectados y medidas
> adoptadas para gestionarla y precaver incidentes futuros (los mismos campos del registro).

**C · Municipio al vecino**
> [Municipalidad] le informa que el [fecha] ocurrió [qué, en palabras simples] que afectó [qué datos suyos]. Esto
> podría [consecuencia posible]. Ya hicimos [medidas]. Le recomendamos [acción del vecino, si la hay]. Consultas:
> [contacto del delegado].

## Nunca

- Borrar o alterar logs, la bitácora o archivos relacionados.
- Esperar a tener toda la información para avisar al municipio.
- Contactar a los vecinos o a la prensa sin que el municipio lo decida.
- Usar los datos expuestos para investigar más allá de lo necesario.
