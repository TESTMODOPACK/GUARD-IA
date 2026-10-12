import { Logger } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { AI_CLASSIFICATION_JSON_SCHEMA, AiClassificationSchema, type AiClassification } from '@guardia/shared';
import type { Env } from '../config/env';
import {
  CLASSIFY_SYSTEM_PROMPT,
  STT_CONTEXT_PROMPT,
  type AiProvider,
  type ClassifyInput,
  type TranscribeInput,
  type TranscribeResult,
} from './ai.provider';

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

/** Whisper para STT y GPT con JSON schema estricto para clasificar (sección 8). */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly client: OpenAI;

  constructor(private readonly env: Env) {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 0 });
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

    const completion = await this.client.chat.completions.create({
      model: this.env.OPENAI_CLASSIFY_MODEL,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
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

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI devolvió una respuesta vacía');
    const parsed = AiClassificationSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      this.logger.error(`Clasificación fuera de schema: ${content.slice(0, 300)}`);
      throw new Error('La clasificación no cumple el schema');
    }
    return parsed.data;
  }
}
