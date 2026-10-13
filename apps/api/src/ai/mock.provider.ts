import type { AiClassification, AlertCategory, Priority, SuggestedAgency } from '@guardia/shared';
import { DEFAULT_QUESTIONS, categoriesFor, genericCategory } from '@guardia/shared';
import type { AiProvider, ClassifyInput, TranscribeInput, TranscribeResult } from './ai.provider';

/**
 * Proveedor sin red: clasifica por palabras clave. Sirve para desarrollo, tests y
 * para que el SOS siga operando si no hay OPENAI_API_KEY. No pretende precisión: las frases
 * críticas (no respira, disparos, violencia intrafamiliar…) las cubren las reglas fijas de shared,
 * que el worker aplica después igual que con la IA real.
 */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock' as const;
  readonly model = null;

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    // Un WAV sintético o cualquier audio: no hay STT real. Si el nombre del mime
    // sugiere texto incrustado (simulador), no hay forma de saberlo; devolvemos vacío.
    const durationS = Math.max(1, Math.round(input.audio.byteLength / 32_000));
    return { text: '', durationS, language: 'es' };
  }

  async classify(input: ClassifyInput): Promise<AiClassification> {
    const text = `${input.transcription ?? ''} ${input.userText ?? ''}`.toLowerCase();
    const allowed = categoriesFor(input.type);
    const pick = (c: string): AlertCategory | null => (allowed.includes(c as AlertCategory) ? (c as AlertCategory) : null);

    let category: AlertCategory | null = null;
    let priority: Priority = input.type === 'EMERGENCY_SOS' ? 'HIGH' : 'LOW';
    let agency: SuggestedAgency = input.type === 'EMERGENCY_SOS' ? 'SEGURIDAD_MUNICIPAL' : 'OBRAS_ASEO';
    let confidence = 0.2;

    const rules: Array<[RegExp, AlertCategory, Priority, SuggestedAgency]> = [
      [/asalt|rob|ladr|cuchill|pistol|arma|encañ/, 'ROBO_ASALTO', 'HIGH', 'CARABINEROS'],
      [/golpe|pega|agred|violen|grit/, 'VIOLENCIA_AGRESION', 'HIGH', 'CARABINEROS'],
      [/incendio|fuego|humo|quema|gas/, 'INCENDIO', 'HIGH', 'BOMBEROS'],
      [/herid|inconscien|desmay|infarto|sangr|ambulancia|médic|medic/, 'SALUD', 'HIGH', 'SAMU'],
      [/choque|accidente|atropell|volc/, 'ACCIDENTE_TRANSITO', 'HIGH', 'CARABINEROS'],
      [/sospech|merodea|extraño/, 'SOSPECHOSO', 'MEDIUM', 'SEGURIDAD_MUNICIPAL'],
      [/bache|hoyo|pavimento/, 'BACHE', 'LOW', 'OBRAS_ASEO'],
      [/luminaria|poste|luz|alumbrado/, 'LUMINARIA', 'LOW', 'OBRAS_ASEO'],
      [/basura|microbasural|escombro/, 'BASURA_MICROBASURAL', 'LOW', 'OBRAS_ASEO'],
      [/semáforo|semaforo/, 'SEMAFORO', 'MEDIUM', 'OBRAS_ASEO'],
      [/plaza|árbol|arbol|pasto|área verde|area verde/, 'AREA_VERDE', 'LOW', 'OBRAS_ASEO'],
      [/perro|gato|animal/, 'ANIMAL', 'LOW', 'OBRAS_ASEO'],
    ];
    for (const [re, c, p, a] of rules) {
      if (re.test(text) && pick(c)) {
        category = c;
        priority = p;
        agency = a;
        confidence = 0.75;
        break;
      }
    }
    if (!category && input.chosenCategory && pick(input.chosenCategory)) {
      category = input.chosenCategory as AlertCategory;
      confidence = 0.6;
    }
    if (!category) category = genericCategory(input.type);

    const summary = text.trim()
      ? `[mock] ${text.trim().slice(0, 120)}`
      : input.type === 'EMERGENCY_SOS'
        ? '[mock] SOS sin audio inteligible'
        : '[mock] reporte urbano sin descripción';

    return {
      category,
      subcategory: null,
      priority,
      agencies: [{ agency, reason: confidence > 0.5 ? 'Palabras clave del reporte' : 'Derivación por defecto' }],
      confidence,
      summary,
      operator_questions: [...DEFAULT_QUESTIONS[category]],
      location: { mentioned: null, comuna: null, elsewhere: false },
      flags: {
        possible_false_alarm: /prueba|test|jaja|broma/.test(text),
        weapon_mentioned: /arma|pistol|cuchill/.test(text),
        people_injured: /herid|sangr|inconscien/.test(text),
        minor_involved: /niñ|menor|hijo|hija/.test(text),
        language_other_than_spanish: false,
      },
    };
  }
}
