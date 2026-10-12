import { BullModule } from '@nestjs/bullmq';
import { Logger, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AI_PROVIDER, type AiProvider } from './ai.provider';
import { AiProcessor } from './ai.processor';
import { ALERTS_QUEUE } from './ai.queue';
import { MockAiProvider } from './mock.provider';
import { OpenAiProvider } from './openai.provider';

@Module({
  imports: [BullModule.registerQueue({ name: ALERTS_QUEUE })],
  providers: [
    {
      provide: AI_PROVIDER,
      useFactory: (env: Env): AiProvider => {
        if (env.AI_PROVIDER === 'openai') return new OpenAiProvider(env);
        new Logger('AI').warn('AI_PROVIDER=mock: clasificación por palabras clave, sin transcripción real');
        return new MockAiProvider();
      },
      inject: [ENV],
    },
    AiProcessor,
  ],
  exports: [BullModule, AI_PROVIDER],
})
export class AiModule {}
