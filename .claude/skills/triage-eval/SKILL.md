---
name: triage-eval
description: Mide y mejora el agente de clasificación de Guard-IA (triage de SOS y reportes urbanos). Úsalo al cambiar el prompt, el modelo, las subcategorías o las reglas fijas, al agregar casos de prueba, o cuando el usuario pregunte qué tan bien clasifica o deriva la IA.
---

# Agente de clasificación: medir antes y después

El agente vive en tres piezas que deben cambiar juntas:

- `packages/shared/src/schemas/ai.ts`: contrato (`TRIAGE_VERSION`, `SUBCATEGORIES`, JSON schema estricto,
  `normalizeClassification`, preguntas y derivación por defecto).
- `packages/shared/src/triage-rules.ts`: reglas fijas para frases críticas. Solo suben la urgencia.
- `apps/api/src/ai/triage.prompt.ts`: prompt del modelo, armado con las listas de shared.

## Flujo

1. Línea base, sin red (rápido, sin cuota): `pnpm --filter @guardia/shared build` y luego
   `pnpm --filter @guardia/api eval:triage --provider mock`. El recall de "riesgo vital" debe ser 100 %:
   con el clasificador sin red eso depende solo de las reglas fijas.
2. Línea base con la IA real: `pnpm --filter @guardia/api eval:triage --provider openai --json <scratchpad>/antes.json`.
   En Windows con Avast hay que exportar `NODE_EXTRA_CA_CERTS` (ver `.claude/launch.json`). Groq gratis tiene
   límite de tokens por minuto: 65 casos tardan unos 15 a 20 minutos; el script reintenta los 429 solo.
3. Haz el cambio. Si cambia el prompt, el schema o las reglas de forma que cambie lo que ve la central, sube
   `TRIAGE_VERSION` (`triage-v3`…): queda guardado en cada `alert.ai_triage` y en `triage_label.ai_version`.
4. Repite la medición y compara métrica por métrica. No aceptes el cambio si:
   - baja "riesgo vital" (debe quedar en 100 %),
   - baja "derivación completa" o "categoría",
   - aparecen errores del proveedor nuevos.
5. Agrega un caso a `apps/api/scripts/triage-cases.json` por cada error real que corrijas (textos inventados,
   nunca datos de vecinos reales). Un arreglo en `expect` significa "cualquiera de estos vale".
6. `pnpm --filter @guardia/shared test` cubre las garantías de las reglas (nunca bajan prioridad, negaciones,
   excepciones); agrega un test si agregas una regla.

## Reglas fijas: cuándo sí

Solo para frases donde equivocarse cuesta una vida o un despacho tardío (no respira, disparos, violencia
intrafamiliar, fuego, gas, cables caídos, atropello, personas atrapadas). Para matices de categoría,
mejora el prompt. Cada regla necesita `label` en español (lo ve el operador), y considera negaciones
("no hay heridos") y excepciones (`unless`: cuchillo de cocina, fuegos artificiales).

## Datos reales

Las correcciones del operador ("Corregir clasificación", "Derivado a…") quedan en `triage_label` junto con lo
que proponía la IA. Para medir con casos reales, consulta esa tabla por municipio y período; no copies
transcripciones al repositorio (contienen datos personales).
