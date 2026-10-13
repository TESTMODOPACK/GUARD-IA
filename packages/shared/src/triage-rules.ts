import type { AlertCategory, AlertType, Priority, SuggestedAgency } from './enums';
import {
  GENERIC_AGENCIES,
  TRIAGE_LIMITS,
  isGenericCategory,
  maxPriority,
  normalizeClassification,
  subcategoryFits,
  type AiClassification,
  type AiFlags,
  type Subcategory,
  type Triage,
} from './schemas/ai';

/**
 * Reglas fijas del agente de clasificación: frases críticas que no dependen del modelo.
 *
 * Corren DESPUÉS de la IA (y del clasificador sin red) y solo pueden subir la urgencia: suben la
 * prioridad, agregan instituciones y marcan señales; nunca bajan nada. La categoría solo la ponen
 * si la IA dejó la genérica ("sin clasificar"), y la subcategoría solo si la IA no puso ninguna.
 *
 * Los patrones se aplican al texto normalizado (minúsculas, sin tildes, ñ → n). Una coincidencia
 * precedida de una negación cercana ("no hay heridos", "sin fuego") no cuenta.
 */
export interface TriageRule {
  id: string;
  /** Por qué se aplicó, para el operador. También es el motivo de la institución que agrega. */
  label: string;
  pattern: RegExp;
  /** Coincidencias que anulan la regla (p. ej. "me corté con un cuchillo" cocinando). */
  unless?: RegExp;
  types: readonly AlertType[];
  minPriority?: Priority;
  agencies?: readonly SuggestedAgency[];
  /** Su primera institución pasa adelante si la IA había puesto una de apoyo (municipal, obras). */
  lead?: boolean;
  /** Clasificación por tipo, solo si la IA dejó la genérica o la misma categoría sin subcategoría. */
  set?: Partial<Record<AlertType, { category: AlertCategory; subcategory?: Subcategory }>>;
  flags?: readonly (keyof AiFlags)[];
}

const SOS: readonly AlertType[] = ['EMERGENCY_SOS'];
const CIVIC: readonly AlertType[] = ['CIVIC_REPORT'];
const BOTH: readonly AlertType[] = ['EMERGENCY_SOS', 'CIVIC_REPORT'];

const FAMILY =
  '(?:pareja|marido|esposo|esposa|senora|mujer|polol[oa]|conviviente|ex|papa|padre|mama|madre|padrastro|madrastra|hij[oa]|herman[oa]|cunad[oa]|suegr[oa]|yerno|nuera|tio|tia)';
const HURT = '(?:pega|pego|golpe|agred|amenaz|ahorc|maltrat|patea|matar|mata)';

/** En orden: la primera regla que clasifica gana; las demás solo suman. */
export const TRIAGE_RULES: readonly TriageRule[] = [
  {
    id: 'VIF',
    label: 'Violencia de la pareja o de un familiar',
    pattern: new RegExp(
      `\\b(?:mi|su|el|la) ${FAMILY}\\b[^.]{0,40}?\\b${HURT}\\w*|\\b${HURT}\\w*[^.]{0,30}?\\b(?:mi|su) ${FAMILY}\\b|\\bviolencia intrafamiliar\\b|\\bvif\\b`,
    ),
    types: SOS,
    minPriority: 'HIGH',
    agencies: ['CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'VIOLENCIA_AGRESION', subcategory: 'VIOLENCIA_INTRAFAMILIAR' } },
  },
  {
    id: 'SECUESTRO',
    label: 'Posible secuestro o persona retenida',
    pattern: /\b(?:secuestr\w*|se (?:lo|la|los) llevaron a la fuerza|(?:lo|la) subieron a la fuerza|me tienen encerrad[oa])/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['CARABINEROS'],
    lead: true,
  },
  {
    id: 'VIOLENCIA_SEXUAL',
    label: 'Posible violencia sexual',
    pattern: /\b(?:violacion|violaron|abuso sexual|abusando de|acoso sexual|abusaron de)\b/,
    types: SOS,
    minPriority: 'HIGH',
    agencies: ['CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'VIOLENCIA_AGRESION', subcategory: 'VIOLENCIA_SEXUAL' } },
  },
  {
    id: 'SUICIDIO',
    label: 'Riesgo de suicidio',
    pattern:
      /\b(?:suicid\w*|quitarse la vida|(?:se|me) quiere(?:s)? matar|(?:se|me) va(?:s)? a matar|se (?:quiere|va a) tirar|se corto las venas|ahorcarse)/,
    types: SOS,
    minPriority: 'HIGH',
    agencies: ['SAMU', 'CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'SALUD', subcategory: 'RIESGO_SUICIDA' } },
  },
  {
    id: 'PORTONAZO',
    label: 'Portonazo o encerrona',
    pattern: /\b(?:portonazo|encerrona)s?\b/,
    types: SOS,
    minPriority: 'HIGH',
    agencies: ['CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'ROBO_ASALTO', subcategory: 'PORTONAZO_ENCERRONA' } },
  },
  {
    id: 'ROBO_EN_CURSO',
    label: 'Robo o asalto en curso',
    pattern:
      /\b(?:(?:me|nos|lo|la|le|les)? ?(?:estan|esta) (?:robando|asaltando|apuntando)|(?:se|nos) (?:estan|esta) (?:metiendo|entrando)|(?:estan|esta) entrando a (?:mi|la|una|nuestra) casa|me quieren robar|turbazos?)/,
    types: SOS,
    minPriority: 'HIGH',
    agencies: ['CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'ROBO_ASALTO', subcategory: 'ASALTO_EN_CURSO' } },
  },
  {
    id: 'ARMA_FUEGO',
    label: 'Se mencionan disparos o un arma de fuego',
    pattern:
      /\b(?:balazos?|balacera|baleo|balean|balearon|baleado|disparos?|dispararon|disparando|pistolas?|revolver|escopeta|metralleta|fusil|arma de fuego|armado|armados)\b/,
    unless: /\bpistola de (?:agua|juguete|silicona)/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'VIOLENCIA_AGRESION', subcategory: 'DISPAROS' } },
    flags: ['weapon_mentioned'],
  },
  {
    id: 'ARMA_BLANCA',
    label: 'Se menciona un cuchillo u otra arma blanca',
    pattern: /\b(?:cuchill\w*|navaja|cortapluma|machete|estoque|punal|apunal\w*|acuchill\w*|arma blanca)/,
    unless: /\b(?:me corte|se corto|cocinando|cortando (?:pan|carne|verdura))/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'VIOLENCIA_AGRESION', subcategory: 'AGRESION_CON_ARMA' } },
    flags: ['weapon_mentioned'],
  },
  {
    id: 'NO_RESPIRA',
    label: 'Alguien no respira o está inconsciente',
    pattern:
      /\b(?:no respira|no esta respirando|dejo de respirar|no reacciona|no responde|inconsciente|perdio el conocimiento|se desmayo|desmayad[oa]|paro cardi\w*)/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['SAMU'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'SALUD', subcategory: 'INCONSCIENTE' } },
  },
  {
    id: 'SALUD_GRAVE',
    label: 'Síntoma de emergencia médica grave',
    pattern:
      /\b(?:infarto|dolor (?:fuerte )?(?:en el|de|al) pecho|convulsion\w*|convulsionando|ataque (?:epileptico|cardiaco|al corazon)|se (?:esta )?ahogando|no puede respirar|le cuesta respirar|sobredosis|envenenad[oa]|intoxicad[oa]|esta dando a luz|rompio (?:la )?bolsa)/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['SAMU'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'SALUD' } },
  },
  {
    id: 'ATRAPADO',
    label: 'Hay personas atrapadas',
    pattern: /\b(?:atrapad[oa]s?|bajo los escombros|aplastad[oa]s?|no (?:puede|pueden) salir del auto)/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['BOMBEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'OTRO_EMERGENCIA', subcategory: 'RESCATE' } },
  },
  {
    id: 'FUEGO',
    label: 'Se menciona fuego, humo o una explosión',
    pattern:
      /\b(?:incendio|fuego|llamas|se (?:esta )?quemando|quemandose|se quema|humo|humareda|explosion|exploto|ardiendo)\b/,
    unless: /\bfuegos? artificiales\b/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['BOMBEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'INCENDIO' } },
  },
  {
    id: 'GAS',
    label: 'Olor o fuga de gas',
    pattern: /\b(?:olor a gas|huele a gas|fuga de gas|escape de gas|se (?:esta )?saliendo el gas|balon de gas (?:abierto|roto))/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['BOMBEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'INCENDIO', subcategory: 'FUGA_GAS' } },
  },
  {
    id: 'ELECTRICO',
    label: 'Cables eléctricos caídos o echando chispas',
    pattern:
      /\b(?:cables? (?:cortados?|caidos?|sueltos?|colgando|en el suelo|tirados?)|chispas|chispeando|cortocircuito|transformador (?:exploto|echando|en llamas))/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['BOMBEROS'],
    set: {
      EMERGENCY_SOS: { category: 'INCENDIO', subcategory: 'RIESGO_ELECTRICO' },
      CIVIC_REPORT: { category: 'LUMINARIA', subcategory: 'CABLE_CORTADO' },
    },
  },
  {
    id: 'ATROPELLO',
    label: 'Persona atropellada',
    pattern: /\batropell\w*/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['SAMU', 'CARABINEROS'],
    lead: true,
    set: { EMERGENCY_SOS: { category: 'ACCIDENTE_TRANSITO', subcategory: 'ATROPELLO' } },
    flags: ['people_injured'],
  },
  {
    id: 'HERIDOS',
    label: 'Hay personas heridas o sangrando',
    pattern: /\b(?:herid[oa]s?|sangr\w*|lesionad[oa]s?|fractura\w*|apunalad[oa]|baleado|quebro (?:la|el) (?:pierna|brazo|cadera))\b/,
    types: BOTH,
    minPriority: 'HIGH',
    agencies: ['SAMU'],
    flags: ['people_injured'],
  },
  {
    id: 'MENOR',
    label: 'Hay un niño o menor de edad involucrado',
    pattern:
      /\b(?:nin[oa]s?|ninit[oa]s?|guaguas?|guaguita|bebes?|menor(?:es)? de edad|mis? hij[oa]s?|mi nieto|mi nieta|adolescentes?|escolar(?:es)?|lolit[oa]s?)\b/,
    types: BOTH,
    flags: ['minor_involved'],
  },
  {
    id: 'PERRO_AGRESIVO',
    label: 'Perros agresivos o mordedura',
    pattern: /\b(?:perros?|jauria|pitbull)\b[^.]{0,30}?\b(?:muerd\w*|mordio|mordieron|ataca\w*|ataco|atacaron|agresiv\w*)/,
    types: BOTH,
    minPriority: 'MEDIUM',
    set: {
      EMERGENCY_SOS: { category: 'OTRO_EMERGENCIA', subcategory: 'ANIMAL_PELIGROSO' },
      CIVIC_REPORT: { category: 'ANIMAL', subcategory: 'ANIMAL_AGRESIVO' },
    },
  },
  {
    id: 'TAPA_FALTANTE',
    label: 'Cámara o alcantarilla sin tapa',
    pattern: /\b(?:sin tapa|falta la tapa|se robaron la tapa|alcantarilla abierta|camara abierta|hoyo sin tapa)\b/,
    types: CIVIC,
    minPriority: 'MEDIUM',
    set: { CIVIC_REPORT: { category: 'BACHE', subcategory: 'TAPA_FALTANTE' } },
  },
  {
    id: 'SEMAFORO_FALLA',
    label: 'Semáforo apagado o dañado',
    pattern: /\bsemaforos?\b[^.]{0,30}?\b(?:apagad\w*|no funciona\w*|no da|malo|en amarillo|intermitente|cayo|caido|chocad\w*)/,
    types: CIVIC,
    minPriority: 'MEDIUM',
    set: { CIVIC_REPORT: { category: 'SEMAFORO' } },
  },
  {
    id: 'ARBOL_CAIDO',
    label: 'Árbol o rama caída o a punto de caer',
    pattern:
      /\b(?:arbol|arboles|rama|ramas|gancho)\b[^.]{0,30}?\b(?:se cayo|cayo|caido|caida|a punto de caer|se va a caer|sobre (?:el|los|un) (?:cable|auto|techo))/,
    types: CIVIC,
    minPriority: 'MEDIUM',
    set: { CIVIC_REPORT: { category: 'AREA_VERDE', subcategory: 'ARBOL_RIESGO' } },
  },
];

/** Minúsculas, sin tildes (ñ → n) y espacios simples: los patrones se escriben así. */
export function normalizeTriageText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿¡"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "no hay heridos", "sin fuego", "nadie salió herido": negación en la misma frase, poco antes. */
const NEGATION_BEFORE = /\b(?:no|sin|nadie|ningun\w*|tampoco|ni)\b[\w ]{0,15}$/;

function matches(rule: TriageRule, text: string): boolean {
  if (rule.unless?.test(text)) return false;
  const re = new RegExp(rule.pattern.source, 'g');
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const clause = before.split(/[.,;:!?]/).at(-1) ?? '';
    if (!NEGATION_BEFORE.test(clause)) return true;
  }
  return false;
}

/** Ids de las reglas que coinciden con el texto (para tests y para el evaluador). */
export function matchTriageRules(type: AlertType, text: string): string[] {
  const t = normalizeTriageText(text);
  if (!t) return [];
  return TRIAGE_RULES.filter((r) => r.types.includes(type) && matches(r, t)).map((r) => r.id);
}

export function triageRuleLabel(id: string): string | null {
  return TRIAGE_RULES.find((r) => r.id === id)?.label ?? null;
}

/**
 * Aplica las reglas fijas a un triage ya normalizado. Devuelve una copia; `rules` lista solo las
 * que cambiaron algo. Garantías (tests en triage-rules.test.ts):
 * - la prioridad nunca baja; las instituciones de la IA se conservan;
 * - la categoría de la IA solo se reemplaza si es la genérica;
 * - las señales solo pasan de false a true.
 */
export function applyTriageRules(type: AlertType, triage: Triage, text: string): Triage {
  const t = normalizeTriageText(text);
  const out: Triage = {
    ...triage,
    agencies: triage.agencies.map((a) => ({ ...a })),
    flags: { ...triage.flags },
    rules: [...triage.rules],
  };
  if (!t) return out;

  for (const rule of TRIAGE_RULES) {
    if (!rule.types.includes(type) || !matches(rule, t)) continue;
    let changed = false;

    if (rule.minPriority) {
      const p = maxPriority(out.priority, rule.minPriority);
      if (p !== out.priority) {
        out.priority = p;
        changed = true;
      }
    }

    const set = rule.set?.[type];
    if (set) {
      if (isGenericCategory(out.category) && set.category !== out.category) {
        out.category = set.category;
        out.subcategory = set.subcategory ?? null;
        changed = true;
      } else if (
        set.category === out.category &&
        set.subcategory &&
        !out.subcategory &&
        subcategoryFits(out.category, set.subcategory)
      ) {
        out.subcategory = set.subcategory;
        changed = true;
      }
    }

    for (const agency of rule.agencies ?? []) {
      if (!out.agencies.some((a) => a.agency === agency)) {
        out.agencies.push({ agency, reason: rule.label });
        changed = true;
      }
    }
    const first = rule.agencies?.[0];
    if (rule.lead && first && GENERIC_AGENCIES.includes(out.agencies[0].agency) && out.agencies[0].agency !== first) {
      const i = out.agencies.findIndex((a) => a.agency === first);
      const [lead] = out.agencies.splice(i, 1);
      out.agencies.unshift(lead);
      changed = true;
    }

    for (const f of rule.flags ?? []) {
      if (!out.flags[f]) {
        out.flags[f] = true;
        changed = true;
      }
    }

    if (changed && !out.rules.includes(rule.id)) out.rules.push(rule.id);
  }
  // Las reglas pueden haber agregado instituciones: se respeta el máximo, sacando primero las de apoyo.
  while (out.agencies.length > TRIAGE_LIMITS.agencies) {
    const i = out.agencies.map((a) => GENERIC_AGENCIES.includes(a.agency)).lastIndexOf(true);
    out.agencies.splice(i >= 1 ? i : out.agencies.length - 1, 1);
  }
  return out;
}

/** Modelo → triage normalizado → reglas fijas. Lo usan el worker y el evaluador. */
export function buildTriage(
  type: AlertType,
  raw: AiClassification,
  text: string,
  meta: { provider: string; model: string | null },
): Triage {
  return applyTriageRules(type, normalizeClassification(type, raw, meta), text);
}
