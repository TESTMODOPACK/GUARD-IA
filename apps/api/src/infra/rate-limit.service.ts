import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { AppError } from '../common/app-error';
import { REDIS } from './redis.module';

export interface HitOptions {
  /**
   * Si Redis no responde a tiempo, deja pasar la petición en vez de bloquearla.
   * Se usa en el camino del SOS: un Redis caído no puede impedir pedir ayuda.
   */
  failOpen?: boolean;
  timeoutMs?: number;
}

/**
 * Límite por ventana fija en Redis (INCR + EXPIRE). Suficiente para OTP, login y SOS;
 * no pretende ser un rate limiter global de la API.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Incrementa el contador y lanza RATE_LIMITED si supera `max` en `windowSeconds`. */
  async hit(key: string, max: number, windowSeconds: number, message: string, opts: HitOptions = {}): Promise<void> {
    const k = `rl:${key}`;
    const timeoutMs = opts.timeoutMs ?? (opts.failOpen ? 300 : 2000);
    let n: number;
    let ttl = windowSeconds;
    try {
      const res = await withTimeout(
        this.redis.multi().incr(k).expire(k, windowSeconds, 'NX').ttl(k).exec(),
        timeoutMs,
      );
      n = Number(res?.[0]?.[1] ?? 0);
      ttl = Number(res?.[2]?.[1] ?? windowSeconds);
    } catch (e) {
      if (opts.failOpen) {
        this.logger.warn(`Redis no respondió para ${k}: se deja pasar (fail-open)`);
        return;
      }
      throw e;
    }
    if (n > max) {
      throw new AppError('RATE_LIMITED', message, { retryAfterSeconds: Math.max(ttl, 1) });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis timeout ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
}
