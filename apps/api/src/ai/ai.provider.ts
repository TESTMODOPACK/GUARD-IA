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

/**
 * El proveedor solo entrega la salida del modelo. La normalización y las reglas fijas
 * (`buildTriage` de shared) las aplica quien llama: el worker y el evaluador, igual para todos.
 */
export interface AiProvider {
  readonly name: 'openai' | 'mock';
  /** Modelo de clasificación (para registrar en el triage); null si no hay modelo. */
  readonly model: string | null;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  classify(input: ClassifyInput): Promise<AiClassification>;
}

export const STT_CONTEXT_PROMPT =
  'Emergencia o reporte urbano en Chile. Carabineros, SAMU, Bomberos, asalto, bache, luminaria, ' +
  'microbasural, semáforo, plaza, Puente Alto, La Pintana, Santiago.';
