import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger } from 'nestjs-pino';
import type { ServerOptions } from 'socket.io';
import { API_PREFIX } from '@guardia/shared';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { ENV, type Env } from './config/env';

/** Socket.io con el mismo CORS que la API. */
class CorsIoAdapter extends IoAdapter {
  constructor(
    app: NestExpressApplication,
    private readonly origins: string[],
  ) {
    super(app);
  }
  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: true },
      // Las apps móviles usan websocket directo; polling queda como respaldo para la central.
      transports: ['websocket', 'polling'],
    });
  }
}

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const env = app.get<Env>(ENV);
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: origins, credentials: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new CorsIoAdapter(app, origins));
  app.enableShutdownHooks();
  app.set('trust proxy', 1); // Caddy delante
  app.disable('x-powered-by');
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  return app;
}

async function bootstrap() {
  const app = await createApp();
  const env = app.get<Env>(ENV);
  await app.listen(env.PORT, '0.0.0.0');
  app.get(Logger).log(`Guard-IA API en :${env.PORT} (${env.NODE_ENV}, IA=${env.AI_PROVIDER}, storage=${env.STORAGE_DRIVER})`);
}

if (require.main === module) {
  bootstrap().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
