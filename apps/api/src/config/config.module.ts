import { Global, Module } from '@nestjs/common';
import { ENV, validateEnv } from './env';

/**
 * Módulo global que expone el entorno validado bajo el token ENV.
 * Se evita @nestjs/config para mantener una sola fuente de verdad (zod).
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: () => validateEnv(process.env),
    },
  ],
  exports: [ENV],
})
export class AppConfigModule {}
