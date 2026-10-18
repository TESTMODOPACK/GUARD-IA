import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { AI_CLASSIFICATION_JSON_SCHEMA, AiClassificationSchema, type AiClassification } from '@guardia/shared';
import type { Env } from '../config/env';
import {
  STT_CONTEXT_PROMPT,
  type AiProvider,
  type ClassifyInput,
  type TranscribeInput,
  type TranscribeResult,
} from './ai.provider';
import { TRIAGE_SYSTEM_PROMPT, triageUserMessage } from './triage.prompt';

const EXT_BY_MIME: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/3gpp': '3gp',
};

/**
 * Huella de una respuesta para el log: largo y hash corto, nunca el contenido (repite lo que dijo el vecino;
 * Ley 21.719, art. 3 c). Dos fallas con la misma huella son la misma respuesta.
 */
function fingerprint(content: string): string {
  return `${content.length} caracteres, sha256 ${createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
}

/** Whisper para STT y GPT con JSON schema estricto para clasificar (sección 8). */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly client: OpenAI;

  constructor(private readonly env: Env) {
    this.model = env.OPENAI_CLASSIFY_MODEL;
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, timeout: 30_000, maxRetries: 0 });
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const ext = EXT_BY_MIME[input.mime.toLowerCase()] ?? 'm4a';
    const file = await toFile(input.audio, `audio.${ext}`, { type: input.mime });
    const res = await this.client.audio.transcriptions.create({
      file,
      model: this.env.OPENAI_STT_MODEL,
      language: 'es',
      prompt: input.prompt ?? STT_CONTEXT_PROMPT,
      response_format: 'verbose_json',
      temperature: 0,
    });
    const verbose = res as unknown as { text: string; duration?: number; language?: string };
    return { text: verbose.text?.trim() ?? '', durationS: verbose.duration, language: verbose.language };
  }

  async classify(input: ClassifyInput): Promise<AiClassification> {
    const user = [
      `Tipo de alerta: ${input.type}`,
      `Hora local: ${input.localTime}`,
      `Categoría elegida por el vecino: ${input.chosenCategory ?? 'ninguna'}`,
      `Transcripción del audio: ${input.transcription?.trim() || '(sin audio o ininteligible)'}`,
      `Texto escrito por el vecino: ${input.userText?.trim() || '(ninguno)'}`,
    ].join('\n');

    const effort = this.env.OPENAI_REASONING_EFFORT;
    const request = () =>
      this.client.chat.completions.create({
        model: this.env.OPENAI_CLASSIFY_MODEL,
        // Un modelo de razonamiento gasta tokens "pensando" antes del JSON: con un tope corto la
        // respuesta llega cortada y no valida. Esos modelos tampoco usan temperature.
        ...(effort ? { reasoning_effort: effort } : { temperature: 0 }),
        max_completion_tokens: effort ? 4000 : 800,
        messages: [
          { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: AI_CLASSIFICATION_JSON_SCHEMA.name,
            strict: AI_CLASSIFICATION_JSON_SCHEMA.strict,
            schema: AI_CLASSIFICATION_JSON_SCHEMA.schema as unknown as Record<string, unknown>,
          },
        },
      });
    let completion: Awaited<ReturnType<typeof request>>;
    try {
      completion = await request();
    } catch (e) {
      // Groq valida el JSON después de generarlo: si el modelo se cortó o se salió del schema
      // responde 400 json_validate_failed. Un segundo intento inmediato casi siempre sale bien.
      if ((e as { code?: string }).code !== 'json_validate_failed') throw e;
      const partial = (e as { error?: { failed_generation?: string } }).error?.failed_generation ?? '';
      this.logger.warn(`clasificación fuera de schema (${partial.length} caracteres); reintento`);
      completion = await request();
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI devolvió una respuesta vacía');
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      this.logger.error(`Clasificación que no es JSON (${fingerprint(content)})`);
      throw new Error('La clasificación no es JSON');
    }
    const parsed = AiClassificationSchema.safeParse(json);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.') || '(raíz)').slice(0, 5).join(', ');
      this.logger.error(`Clasificación fuera de schema en ${paths} (${fingerprint(content)})`);
      throw new Error('La clasificación no cumple el schema');
    }
    return parsed.data;
  }
}
