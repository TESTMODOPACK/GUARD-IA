import type { AiClassification, AlertType } from '@guardia/shared';

export const AI_PROVIDER = 'AI_PROVIDER' as const;

export interface TranscribeInput {
  audio: Buffer;
  mime: string;
  /** Pista de contexto para el modelo STT (nombres propios, chilenismos). */
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  durationS?: number;
  language?: string;
}

export interface ClassifyInput {
  type: AlertType;
  transcription: string | null;
  userText: string | null;
  /** Categoría elegida por el vecino (reportes urbanos). */
  chosenCategory: string | null;
  localTime: string;
}

export interface AiProvider {
  readonly name: 'openai' | 'mock';
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  classify(input: ClassifyInput): Promise<AiClassification>;
}

export const STT_CONTEXT_PROMPT =
  'Emergencia o reporte urbano en Chile. Carabineros, SAMU, Bomberos, asalto, bache, luminaria, ' +
  'microbasural, semáforo, plaza, Puente Alto, La Pintana, Santiago.';

export const CLASSIFY_SYSTEM_PROMPT = `Eres el clasificador de una central de seguridad municipal en Chile.
Recibes la transcripción de un audio o el texto de un vecino, el tipo de alerta
(EMERGENCY_SOS o CIVIC_REPORT) y la hora local.

Devuelve SOLO el JSON del schema. Reglas:
- category debe pertenecer al grupo del tipo recibido.
  EMERGENCY_SOS: ROBO_ASALTO, VIOLENCIA_AGRESION, INCENDIO, SALUD, ACCIDENTE_TRANSITO, SOSPECHOSO, OTRO_EMERGENCIA.
  CIVIC_REPORT: BACHE, LUMINARIA, BASURA_MICROBASURAL, SEMAFORO, AREA_VERDE, ANIMAL, OTRO_URBANO.
- priority HIGH: riesgo de vida o delito en curso (asalto, agresión, incendio,
  persona inconsciente, accidente con heridos).
- priority MEDIUM: delito consumado sin agresor presente, situación sospechosa,
  falla urbana que genera riesgo (semáforo apagado).
- priority LOW: reporte urbano sin riesgo inmediato.
- suggested_agency: SEGURIDAD_MUNICIPAL por defecto; CARABINEROS si hay delito en curso;
  SAMU si hay heridos o emergencia médica; BOMBEROS si hay fuego, gas o rescate;
  OBRAS_ASEO para reportes urbanos.
- Audio ambiente sin habla clara: clasifica por sonidos (gritos, golpes, sirenas) y baja confidence.
- Transcripción vacía o ininteligible: category OTRO_*, confidence 0.2, priority HIGH si es SOS.
- Si el vecino ya eligió una categoría en un reporte urbano, respétala salvo contradicción evidente.
- summary: una frase en español neutro, sin inventar datos.`;
