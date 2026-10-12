import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';

export const REDIS = 'REDIS' as const;

@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (env: Env) =>
        new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: null, // requerido por BullMQ
          enableReadyCheck: true,
          lazyConnect: false,
        }),
      inject: [ENV],
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
