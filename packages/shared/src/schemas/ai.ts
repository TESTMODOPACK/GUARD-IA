import { z } from 'zod';
import {
  ALERT_CATEGORIES,
  PRIORITIES,
  SUGGESTED_AGENCIES,
  categoriesFor,
  type AlertCategory,
  type AlertType,
  type Priority,
  type SuggestedAgency,
} from '../enums';

/**
 * Agente de clasificación (triage). Versión del prompt y del schema: viaja en `alert.ai_triage`
 * y en las etiquetas del operador para comparar versiones con casos reales.
 */
/** triage-v3 (0013): señal `security_relevant` para que el área de los SOS vea los reportes urbanos con carácter de seguridad. */
export const TRIAGE_VERSION = 'triage-v3';

export const AiFlagsSchema = z.object({
  possible_false_alarm: z.boolean(),
  weapon_mentioned: z.boolean(),
  people_injured: z.boolean(),
  minor_involved: z.boolean(),
  language_other_than_spanish: z.boolean(),
  /**
   * triage-v3: un reporte urbano que además es un asunto de seguridad (delitos, drogas, armas, amenazas, peleas).
   * Lo ve también el área de los SOS. En un SOS siempre es false. Default: los triage anteriores no la traen.
   */
  security_relevant: z.boolean().default(false),
});
export type AiFlags = z.infer<typeof AiFlagsSchema>;

/**
 * Subcategorías por categoría: el detalle que cambia a quién se deriva y qué se pregunta
 * (p. ej. violencia intrafamiliar → Carabineros; persona inconsciente → SAMU primero).
 * Códigos únicos en toda la lista. Se guardan como texto (columna `alert.subcategory`).
 */
export const SUBCATEGORIES = {
  ROBO_ASALTO: ['ASALTO_EN_CURSO', 'PORTONAZO_ENCERRONA', 'ROBO_VIVIENDA', 'ROBO_VEHICULO', 'ROBO_CONSUMADO'],
  VIOLENCIA_AGRESION: ['VIOLENCIA_INTRAFAMILIAR', 'RINA', 'AGRESION_CON_ARMA', 'DISPAROS', 'VIOLENCIA_SEXUAL', 'AMENAZAS'],
  INCENDIO: ['INCENDIO_VIVIENDA', 'INCENDIO_VEHICULO', 'INCENDIO_PASTIZAL', 'FUGA_GAS', 'RIESGO_ELECTRICO'],
  SALUD: [
    'INCONSCIENTE',
    'DIFICULTAD_RESPIRATORIA',
    'DOLOR_PECHO',
    'CONVULSION',
    'HERIDA_CAIDA',
    'INTOXICACION',
    'PARTO',
    'RIESGO_SUICIDA',
  ],
  ACCIDENTE_TRANSITO: ['CHOQUE_CON_HERIDOS', 'CHOQUE_SIN_HERIDOS', 'ATROPELLO', 'VOLCAMIENTO'],
  SOSPECHOSO: ['PERSONA_SOSPECHOSA', 'VEHICULO_SOSPECHOSO', 'DROGAS', 'DESORDEN_RUIDOS'],
  OTRO_EMERGENCIA: ['PERSONA_DESAPARECIDA', 'RESCATE', 'INUNDACION', 'ANIMAL_PELIGROSO'],
  BACHE: ['BACHE_CALZADA', 'VEREDA_DANADA', 'TAPA_FALTANTE'],
  LUMINARIA: ['LUMINARIA_APAGADA', 'LUMINARIA_INTERMITENTE', 'POSTE_DANADO', 'CABLE_CORTADO'],
  BASURA_MICROBASURAL: ['MICROBASURAL', 'ESCOMBROS', 'RETIRO_PENDIENTE', 'VOLUMINOSOS'],
  SEMAFORO: ['SEMAFORO_APAGADO', 'SEMAFORO_INTERMITENTE', 'SEMAFORO_DANADO'],
  AREA_VERDE: ['ARBOL_RIESGO', 'PODA_MANTENCION', 'MOBILIARIO_DANADO', 'RIEGO'],
  ANIMAL: ['ANIMAL_AGRESIVO', 'ANIMAL_HERIDO', 'ANIMAL_MUERTO', 'ANIMAL_ABANDONADO'],
  OTRO_URBANO: ['VEHICULO_ABANDONADO', 'RUIDOS_MOLESTOS', 'RAYADOS', 'OCUPACION_VIA_PUBLICA'],
} as const satisfies Record<AlertCategory, readonly string[]>;
export type Subcategory = (typeof SUBCATEGORIES)[AlertCategory][number];
export const ALL_SUBCATEGORIES = Object.values(SUBCATEGORIES).flat() as Subcategory[];

/** La subcategoría pertenece a la categoría (null siempre vale: "no se sabe"). */
export function subcategoryFits(category: AlertCategory, subcategory: string | null | undefined): boolean {
  return subcategory == null || (SUBCATEGORIES[category] as readonly string[]).includes(subcategory);
}

/** Categoría "sin clasificar" de cada tipo: la única que las reglas fijas pueden reemplazar. */
export function genericCategory(type: AlertType): AlertCategory {
  return type === 'EMERGENCY_SOS' ? 'OTRO_EMERGENCIA' : 'OTRO_URBANO';
}
export function isGenericCategory(c: AlertCategory | null | undefined): boolean {
  return c == null || c === 'OTRO_EMERGENCIA' || c === 'OTRO_URBANO';
}

/** Instituciones "de apoyo": no desplazan a una especializada como primera derivación. */
export const GENERIC_AGENCIES: readonly SuggestedAgency[] = ['SEGURIDAD_MUNICIPAL', 'OBRAS_ASEO'];

/** Derivación por defecto si el modelo no entregó ninguna. */
export const DEFAULT_AGENCY: Record<AlertCategory, SuggestedAgency> = {
  ROBO_ASALTO: 'CARABINEROS',
  VIOLENCIA_AGRESION: 'CARABINEROS',
  INCENDIO: 'BOMBEROS',
  SALUD: 'SAMU',
  ACCIDENTE_TRANSITO: 'CARABINEROS',
  SOSPECHOSO: 'SEGURIDAD_MUNICIPAL',
  OTRO_EMERGENCIA: 'SEGURIDAD_MUNICIPAL',
  BACHE: 'OBRAS_ASEO',
  LUMINARIA: 'OBRAS_ASEO',
  BASURA_MICROBASURAL: 'OBRAS_ASEO',
  SEMAFORO: 'OBRAS_ASEO',
  AREA_VERDE: 'OBRAS_ASEO',
  ANIMAL: 'OBRAS_ASEO',
  OTRO_URBANO: 'OBRAS_ASEO',
};

/**
 * Preguntas para el operador cuando la IA no propuso ninguna (o no corrió: SOS por botón).
 * Cortas, en el orden en que conviene hacerlas.
 */
export const DEFAULT_QUESTIONS: Record<AlertCategory, readonly string[]> = {
  ROBO_ASALTO: [
    '¿El asaltante sigue en el lugar o hacia dónde huyó?',
    '¿Hay armas o personas heridas?',
    '¿Cómo es el asaltante o el vehículo (ropa, patente)?',
  ],
  VIOLENCIA_AGRESION: ['¿El agresor sigue en el lugar?', '¿Hay heridos o niños presentes?', '¿Hay armas?'],
  INCENDIO: [
    '¿Hay personas dentro o atrapadas?',
    '¿Qué se está quemando (casa, auto, pastizal)?',
    '¿Hay balones de gas o cables cerca?',
  ],
  SALUD: ['¿La persona respira y responde?', '¿Qué edad tiene aproximadamente?', '¿Qué le pasó y hace cuánto?'],
  ACCIDENTE_TRANSITO: [
    '¿Hay heridos o personas atrapadas en los vehículos?',
    '¿Cuántos vehículos hay involucrados?',
    '¿Está cortada la calle?',
  ],
  SOSPECHOSO: [
    '¿Qué está haciendo exactamente la persona o el vehículo?',
    '¿Puede describirlos (ropa, patente, hacia dónde van)?',
    '¿Hace cuánto están ahí?',
  ],
  OTRO_EMERGENCIA: [
    '¿Qué está pasando?',
    '¿Hay alguien herido o en peligro ahora?',
    '¿Puede confirmar la dirección exacta?',
  ],
  BACHE: ['¿Qué tan grande es y en qué parte de la calle está?', '¿Ha causado accidentes?'],
  LUMINARIA: ['¿Cuántas luminarias están apagadas?', '¿Hay cables expuestos o caídos?'],
  BASURA_MICROBASURAL: ['¿Es basura domiciliaria, escombros o muebles?', '¿Hace cuánto está ahí?'],
  SEMAFORO: ['¿Está apagado, intermitente o dañado?', '¿Hay riesgo para peatones o vehículos?'],
  AREA_VERDE: ['¿Hay un árbol o rama a punto de caer?', '¿Afecta cables, autos o el paso de personas?'],
  ANIMAL: ['¿El animal está agresivo, herido o muerto?', '¿Ha mordido a alguien?'],
  OTRO_URBANO: ['¿Qué problema es y desde cuándo?', '¿Genera algún riesgo para las personas?'],
};

/**
 * Dónde ocurre el hecho según lo que dice el vecino. El GPS dice dónde está el vecino, no siempre
 * dónde pasa lo que reporta ("veo humo en el cerro", "asaltan en la plaza de la otra cuadra"). La
 * central lo usa para ubicar mejor y, si la comuna mencionada es otra, para redirigir el caso.
 */
export const EventLocationSchema = z.object({
  /** Calle, esquina, plaza, villa o referencia tal como la dijo el vecino; null si no menciona. */
  mentioned: z.string().nullable(),
  /** Comuna que nombra el vecino (p. ej. "La Florida"); null si no nombra ninguna. */
  comuna: z.string().nullable(),
  /** El hecho ocurre en otro lugar que donde está el vecino (lo ve o lo cuenta a distancia). */
  elsewhere: z.boolean(),
});
export type EventLocation = z.infer<typeof EventLocationSchema>;

export const AgencyReferralSchema = z.object({
  agency: z.enum(SUGGESTED_AGENCIES),
  /** Por qué esta institución, en pocas palabras ("hay una persona herida"). */
  reason: z.string(),
});
export type AgencyReferral = z.infer<typeof AgencyReferralSchema>;

/**
 * Salida del modelo (sección 8 del documento de Fase 0, versión triage-v2). Validación tolerante:
 * lo que sobra o viene fuera de rango se corrige en `normalizeClassification`; solo se rechaza lo
 * que no se puede interpretar. Una clasificación rechazada deja la alerta "sin clasificar".
 */
export const AiClassificationSchema = z.object({
  category: z.enum(ALERT_CATEGORIES),
  subcategory: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  /** En orden: primero la institución que debe actuar ya. */
  agencies: z.array(AgencyReferralSchema),
  confidence: z.number(),
  summary: z.string(),
  operator_questions: z.array(z.string()),
  location: EventLocationSchema,
  flags: AiFlagsSchema,
});
export type AiClassification = z.infer<typeof AiClassificationSchema>;

export const TRIAGE_LIMITS = { agencies: 4, questions: 3, reason: 120, question: 160, summary: 200, place: 120 } as const;

/** Triage final (modelo + reglas fijas) que se guarda en `alert.ai_triage` y ve la central. */
export const TriageSchema = z.object({
  version: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  category: z.enum(ALERT_CATEGORIES),
  subcategory: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  agencies: z.array(AgencyReferralSchema).min(1).max(TRIAGE_LIMITS.agencies),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(TRIAGE_LIMITS.summary),
  questions: z.array(z.string().max(TRIAGE_LIMITS.question)).max(TRIAGE_LIMITS.questions),
  location: EventLocationSchema,
  flags: AiFlagsSchema,
  /** Prioridad que dio el modelo antes de las reglas fijas (para medir cuánto corrigen). */
  modelPriority: z.enum(PRIORITIES),
  /** Reglas fijas que cambiaron algo (ids de TRIAGE_RULES). */
  rules: z.array(z.string()),
});
export type Triage = z.infer<typeof TriageSchema>;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * Lleva la salida del modelo a un triage válido para el tipo de alerta. Nunca lanza: lo que no
 * calza se reemplaza por el valor seguro (categoría genérica, derivación por defecto).
 */
export function normalizeClassification(
  type: AlertType,
  raw: AiClassification,
  meta: { provider: string; model: string | null },
): Triage {
  let category = raw.category;
  let confidence = Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0.2;
  if (!categoriesFor(type).includes(category)) {
    // Un SOS con categoría urbana (o al revés) no se guarda: queda genérica y con baja confianza.
    category = genericCategory(type);
    confidence = Math.min(confidence, 0.3);
  }
  const subcategory = raw.subcategory && subcategoryFits(category, raw.subcategory) ? raw.subcategory : null;

  const agencies: AgencyReferral[] = [];
  for (const a of raw.agencies) {
    if (agencies.length >= TRIAGE_LIMITS.agencies) break;
    if (agencies.some((x) => x.agency === a.agency)) continue;
    agencies.push({ agency: a.agency, reason: clip(a.reason, TRIAGE_LIMITS.reason) });
  }
  if (agencies.length === 0) agencies.push({ agency: DEFAULT_AGENCY[category], reason: 'Derivación habitual para este tipo de caso' });

  const questions: string[] = [];
  for (const q of raw.operator_questions) {
    const t = clip(q, TRIAGE_LIMITS.question);
    if (t && !questions.includes(t)) questions.push(t);
    if (questions.length >= TRIAGE_LIMITS.questions) break;
  }
  if (questions.length === 0) questions.push(...DEFAULT_QUESTIONS[category].slice(0, TRIAGE_LIMITS.questions));

  const place = (v: string | null) => (v && clip(v, TRIAGE_LIMITS.place)) || null;
  const location: EventLocation = {
    mentioned: place(raw.location.mentioned),
    comuna: place(raw.location.comuna),
    elsewhere: raw.location.elsewhere,
  };

  return {
    version: TRIAGE_VERSION,
    provider: meta.provider,
    model: meta.model,
    category,
    subcategory,
    priority: raw.priority,
    agencies,
    confidence,
    summary: clip(raw.summary, TRIAGE_LIMITS.summary),
    questions,
    location,
    // La señal de seguridad es solo para reportes urbanos (un SOS ya va al área de los SOS).
    flags: { ...raw.flags, security_relevant: type === 'CIVIC_REPORT' && !!raw.flags.security_relevant },
    modelPriority: raw.priority,
    rules: [],
  };
}

const PRIORITY_RANK: Record<Priority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export function maxPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}

/**
 * JSON Schema equivalente, en el formato `strict` de OpenAI (todas las propiedades requeridas y
 * additionalProperties=false). Se mantiene a mano para que el contrato sea explícito y auditable.
 * Los límites de largo y cantidad no van aquí (el modo strict no los admite): los aplica
 * `normalizeClassification`.
 */
export const AI_CLASSIFICATION_JSON_SCHEMA = {
  name: 'alert_triage',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'category',
      'subcategory',
      'priority',
      'agencies',
      'confidence',
      'summary',
      'operator_questions',
      'location',
      'flags',
    ],
    properties: {
      category: { type: 'string', enum: [...ALERT_CATEGORIES] },
      subcategory: { type: ['string', 'null'], enum: [...ALL_SUBCATEGORIES, null] },
      priority: { type: 'string', enum: [...PRIORITIES] },
      agencies: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['agency', 'reason'],
          properties: {
            agency: { type: 'string', enum: [...SUGGESTED_AGENCIES] },
            reason: { type: 'string' },
          },
        },
      },
      confidence: { type: 'number' },
      summary: { type: 'string' },
      operator_questions: { type: 'array', items: { type: 'string' } },
      location: {
        type: 'object',
        additionalProperties: false,
        required: ['mentioned', 'comuna', 'elsewhere'],
        properties: {
          mentioned: { type: ['string', 'null'] },
          comuna: { type: ['string', 'null'] },
          elsewhere: { type: 'boolean' },
        },
      },
      flags: {
        type: 'object',
        additionalProperties: false,
        required: [
          'possible_false_alarm',
          'weapon_mentioned',
          'people_injured',
          'minor_involved',
          'language_other_than_spanish',
          'security_relevant',
        ],
        properties: {
          possible_false_alarm: { type: 'boolean' },
          weapon_mentioned: { type: 'boolean' },
          people_injured: { type: 'boolean' },
          minor_involved: { type: 'boolean' },
          language_other_than_spanish: { type: 'boolean' },
          security_relevant: { type: 'boolean' },
        },
      },
    },
  },
} as const;
