import { describe, expect, it } from 'vitest';
import {
  ALL_SUBCATEGORIES,
  AI_CLASSIFICATION_JSON_SCHEMA,
  SUBCATEGORIES,
  normalizeClassification,
  type AiClassification,
} from './schemas/ai';
import { ALERT_CATEGORIES, type AlertType } from './enums';
import { applyTriageRules, buildTriage, matchTriageRules, normalizeTriageText } from './triage-rules';

const NO_FLAGS = {
  possible_false_alarm: false,
  weapon_mentioned: false,
  people_injured: false,
  minor_involved: false,
  language_other_than_spanish: false,
};
const meta = { provider: 'test', model: null };

function raw(over: Partial<AiClassification> = {}): AiClassification {
  return {
    category: 'OTRO_EMERGENCIA',
    subcategory: null,
    priority: 'MEDIUM',
    agencies: [{ agency: 'SEGURIDAD_MUNICIPAL', reason: 'apoyo' }],
    confidence: 0.4,
    summary: 'x',
    operator_questions: [],
    location: { mentioned: null, comuna: null, elsewhere: false },
    flags: NO_FLAGS,
    ...over,
  };
}
const triage = (type: AlertType, text: string, over: Partial<AiClassification> = {}) =>
  buildTriage(type, raw(over), text, meta);

describe('subcategorías', () => {
  it('cada categoría tiene subcategorías y los códigos no se repiten', () => {
    for (const c of ALERT_CATEGORIES) expect(SUBCATEGORIES[c].length).toBeGreaterThan(0);
    expect(new Set(ALL_SUBCATEGORIES).size).toBe(ALL_SUBCATEGORIES.length);
    for (const s of ALL_SUBCATEGORIES) expect(s).toMatch(/^[A-Z][A-Z_]{1,39}$/); // CHECK de la migración 0005
  });

  it('el JSON schema estricto ofrece todas las subcategorías y null', () => {
    const e = AI_CLASSIFICATION_JSON_SCHEMA.schema.properties.subcategory.enum;
    expect(e).toContain(null);
    expect(e.length).toBe(ALL_SUBCATEGORIES.length + 1);
  });
});

describe('normalizeClassification', () => {
  it('una categoría de otro tipo queda genérica con baja confianza', () => {
    const t = normalizeClassification('EMERGENCY_SOS', raw({ category: 'BACHE', confidence: 0.9 }), meta);
    expect(t.category).toBe('OTRO_EMERGENCIA');
    expect(t.confidence).toBeLessThanOrEqual(0.3);
  });

  it('descarta la subcategoría que no corresponde y recorta lo que sobra', () => {
    const t = normalizeClassification(
      'EMERGENCY_SOS',
      raw({
        category: 'SALUD',
        subcategory: 'BACHE_CALZADA',
        confidence: 1.7,
        summary: 'a'.repeat(400),
        agencies: [
          { agency: 'SAMU', reason: 'r' },
          { agency: 'SAMU', reason: 'repetida' },
          { agency: 'CARABINEROS', reason: 'r' },
          { agency: 'BOMBEROS', reason: 'r' },
          { agency: 'PDI', reason: 'r' },
          { agency: 'SEGURIDAD_MUNICIPAL', reason: 'r' },
        ],
        operator_questions: ['¿a?', '¿a?', '¿b?', '¿c?', '¿d?'],
      }),
      meta,
    );
    expect(t.subcategory).toBeNull();
    expect(t.confidence).toBe(1);
    expect(t.summary.length).toBeLessThanOrEqual(200);
    expect(t.agencies.map((a) => a.agency)).toEqual(['SAMU', 'CARABINEROS', 'BOMBEROS', 'PDI']);
    expect(t.questions).toEqual(['¿a?', '¿b?', '¿c?']);
  });

  it('sin instituciones ni preguntas usa las de la categoría', () => {
    const t = normalizeClassification('EMERGENCY_SOS', raw({ category: 'INCENDIO', agencies: [] }), meta);
    expect(t.agencies[0].agency).toBe('BOMBEROS');
    expect(t.questions.length).toBeGreaterThan(0);
  });
});

describe('reglas fijas', () => {
  it('normaliza tildes y eñes', () => {
    expect(normalizeTriageText('¡Mi SEÑORA está ahí!')).toBe('mi senora esta ahi!');
  });

  it('la frase del piloto: violencia intrafamiliar → Carabineros, prioridad alta', () => {
    const t = triage('EMERGENCY_SOS', 'Necesito la fuerza pública porque mi señora me está golpeando.');
    expect(t.category).toBe('VIOLENCIA_AGRESION');
    expect(t.subcategory).toBe('VIOLENCIA_INTRAFAMILIAR');
    expect(t.priority).toBe('HIGH');
    expect(t.agencies[0].agency).toBe('CARABINEROS');
    expect(t.rules).toContain('VIF');
  });

  it('no respira → SAMU primero y SALUD si la IA no clasificó', () => {
    const t = triage('EMERGENCY_SOS', 'mi papá se cayó y no respira');
    expect(t.category).toBe('SALUD');
    expect(t.subcategory).toBe('INCONSCIENTE');
    expect(t.agencies[0].agency).toBe('SAMU');
  });

  it('incendio con heridos suma Bomberos y SAMU, sin quitar lo que dijo la IA', () => {
    const t = triage('EMERGENCY_SOS', 'se está quemando la casa y hay un herido', {
      category: 'INCENDIO',
      subcategory: 'INCENDIO_VIVIENDA',
      priority: 'HIGH',
      agencies: [{ agency: 'BOMBEROS', reason: 'fuego en vivienda' }],
    });
    expect(t.agencies.map((a) => a.agency)).toEqual(['BOMBEROS', 'SAMU']);
    expect(t.agencies[0].reason).toBe('fuego en vivienda');
    expect(t.flags.people_injured).toBe(true);
    expect(t.subcategory).toBe('INCENDIO_VIVIENDA');
  });

  it('no reemplaza una categoría específica de la IA', () => {
    const t = triage('EMERGENCY_SOS', 'me asaltaron y me pegaron con un cuchillo', {
      category: 'ROBO_ASALTO',
      priority: 'HIGH',
      agencies: [{ agency: 'CARABINEROS', reason: 'asalto' }],
    });
    expect(t.category).toBe('ROBO_ASALTO');
    expect(t.flags.weapon_mentioned).toBe(true);
  });

  it('"me va a matar" es una amenaza (violencia), no riesgo suicida', () => {
    expect(matchTriageRules('EMERGENCY_SOS', 'mi ex dice que me va a matar')).not.toContain('SUICIDIO');
    expect(matchTriageRules('EMERGENCY_SOS', 'mi ex dice que me va a matar')).toContain('VIF');
    expect(matchTriageRules('EMERGENCY_SOS', 'mi hermano dice que se va a matar')).toContain('SUICIDIO');
    expect(matchTriageRules('EMERGENCY_SOS', 'ya no aguanto, me quiero matar')).toContain('SUICIDIO');
  });

  it('una persona armada deja de ser "sospechosa"; una categoría que ya puso otra regla no se pisa', () => {
    const armed = triage('EMERGENCY_SOS', 'un tipo anda con una pistola amenazando a la gente', {
      category: 'SOSPECHOSO',
      subcategory: 'PERSONA_SOSPECHOSA',
    });
    expect(armed.category).toBe('VIOLENCIA_AGRESION');
    expect(armed.subcategory).toBe('DISPAROS');
    const vif = triage('EMERGENCY_SOS', 'mi pareja me está golpeando y tiene un cuchillo');
    expect(vif.subcategory).toBe('VIOLENCIA_INTRAFAMILIAR');
  });

  it('nunca baja la prioridad', () => {
    const t = triage('CIVIC_REPORT', 'hay un perro abandonado', { category: 'ANIMAL', priority: 'HIGH' });
    expect(t.priority).toBe('HIGH');
  });

  it('las negaciones no disparan reglas', () => {
    expect(matchTriageRules('EMERGENCY_SOS', 'choque leve, no hay heridos')).not.toContain('HERIDOS');
    expect(matchTriageRules('EMERGENCY_SOS', 'sin fuego, solo olor raro')).not.toContain('FUEGO');
    expect(matchTriageRules('EMERGENCY_SOS', 'nadie salió herido')).not.toContain('HERIDOS');
    expect(matchTriageRules('EMERGENCY_SOS', 'ya no respira')).toContain('NO_RESPIRA');
  });

  it('excepciones: cocinar con cuchillo y fuegos artificiales', () => {
    expect(matchTriageRules('EMERGENCY_SOS', 'me corté con un cuchillo cocinando')).not.toContain('ARMA_BLANCA');
    expect(matchTriageRules('CIVIC_REPORT', 'tiran fuegos artificiales toda la noche')).not.toContain('FUEGO');
  });

  it('una institución de apoyo cede el primer lugar a la especializada', () => {
    const t = triage('EMERGENCY_SOS', 'hay balazos en el pasaje', {
      category: 'SOSPECHOSO',
      agencies: [{ agency: 'SEGURIDAD_MUNICIPAL', reason: 'ruidos' }],
    });
    expect(t.agencies[0].agency).toBe('CARABINEROS');
    expect(t.agencies.map((a) => a.agency)).toContain('SEGURIDAD_MUNICIPAL');
    expect(t.priority).toBe('HIGH');
  });

  it('reportes urbanos: cables caídos suben a alta y suman Bomberos', () => {
    const t = triage('CIVIC_REPORT', 'hay cables cortados en el suelo frente al colegio', {
      category: 'OTRO_URBANO',
      priority: 'LOW',
      agencies: [{ agency: 'OBRAS_ASEO', reason: 'r' }],
    });
    expect(t.category).toBe('LUMINARIA');
    expect(t.subcategory).toBe('CABLE_CORTADO');
    expect(t.priority).toBe('HIGH');
    expect(t.agencies.map((a) => a.agency)).toContain('BOMBEROS');
  });

  it('sin texto no cambia nada', () => {
    const base = normalizeClassification('EMERGENCY_SOS', raw(), meta);
    expect(applyTriageRules('EMERGENCY_SOS', base, '   ')).toEqual(base);
  });
});
