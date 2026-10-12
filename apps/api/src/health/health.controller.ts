import { Controller, Get, Header, Headers, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import Redis from 'ioredis';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/app-error';
import { ENV, type Env } from '../config/env';
import { DbService } from '../db/db.service';
import { MetricsService } from '../infra/metrics.service';
import { REDIS } from '../infra/redis.module';
import { MediaService } from '../media/media.service';

@Controller()
export class HealthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly dbs: DbService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly mediaSvc: MediaService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health')
  async health(@Res() res: Response) {
    const [db, redis, storage] = await Promise.all([
      this.dbs.ping(),
      this.redis
        .ping()
        .then((r) => r === 'PONG')
        .catch(() => false),
      this.mediaSvc.storagePing(),
    ]);
    const ok = db && redis && storage;
    res.status(ok ? 200 : 503).json({ ok, db, redis, storage, time: new Date().toISOString() });
  }

  /** Público si no hay METRICS_TOKEN (red interna); con token, exige Bearer. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metricsText(@Headers('authorization') authorization?: string) {
    const expected = this.env.METRICS_TOKEN;
    if (expected) {
      const given = (authorization ?? '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError('UNAUTHORIZED', 'Token de métricas inválido');
    }
    return this.metrics.render();
  }
}
