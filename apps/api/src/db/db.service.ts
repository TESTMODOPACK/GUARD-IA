import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { ENV, type Env } from '../config/env';
import { schema, type Schema } from './schema';

/**
 * Contexto de seguridad de una transacción. Se traduce a SET LOCAL app.* y es
 * lo único que las políticas RLS miran. Ningún servicio consulta la base fuera
 * de withContext().
 */
export type DbContext =
  | { role: 'system' }
  | { role: 'citizen'; citizenId: string }
  | { role: 'operator'; tenantId: string; operatorId: string }
  /** Consola de plataforma (0010): ve municipios y comunas, nunca vecinos ni alertas. */
  | { role: 'platform'; userId: string };

export type Db = PostgresJsDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Ventana máxima de espera de una transacción completa (adquirir conexión + trabajo). */
const TX_TIMEOUT_MS = 12_000;

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly client: postgres.Sql;
  readonly db: Db;
  /** Detecta withContext() dentro de withContext(): anidar reserva dos conexiones y agota el pool. */
  private readonly depth = new AsyncLocalStorage<DbContext>();

  constructor(@Inject(ENV) env: Env) {
    this.client = postgres(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX,
      idle_timeout: 30,
      connect_timeout: 10,
      // Sin prepared statements: cada transacción cambia el contexto RLS y
      // los planes cacheados podrían ignorar un SET LOCAL distinto.
      prepare: false,
      onnotice: () => undefined,
    });
    this.db = drizzle(this.client, { schema });
  }

  /**
   * Ejecuta `fn` dentro de una transacción con el contexto RLS indicado.
   * Prohibido anidar: si ya hay una transacción abierta en esta cadena async, se lanza.
   * Un servicio que necesita datos de otro contexto los lee antes o después, o usa la misma `tx`.
   */
  async withContext<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const outer = this.depth.getStore();
    if (outer) {
      throw new Error(
        `withContext(${ctx.role}) anidado dentro de withContext(${outer.role}): usa la tx existente`,
      );
    }
    const tenantId = ctx.role === 'operator' ? ctx.tenantId : '';
    const citizenId = ctx.role === 'citizen' ? ctx.citizenId : '';

    return this.depth.run(ctx, () =>
      withTimeout(
        this.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.role', ${ctx.role}, true),
                       set_config('app.tenant_id', ${tenantId}, true),
                       set_config('app.citizen_id', ${citizenId}, true)`,
          );
          return fn(tx);
        }),
        TX_TIMEOUT_MS,
        `transacción ${ctx.role}`,
      ),
    );
  }

  asSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withContext({ role: 'system' }, fn);
  }

  asCitizen<T>(citizenId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withContext({ role: 'citizen', citizenId }, fn);
  }

  asOperator<T>(tenantId: string, operatorId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withContext({ role: 'operator', tenantId, operatorId }, fn);
  }

  asPlatform<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withContext({ role: 'platform', userId }, fn);
  }

  async ping(): Promise<boolean> {
    try {
      await withTimeout(this.client`select 1`, 3000, 'ping');
      return true;
    } catch (e) {
      this.logger.error(`Postgres no responde: ${(e as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy() {
    await this.client.end({ timeout: 5 });
  }
}

/** Es Postgres quien corta la transacción (statement/idle timeouts del rol); esto evita colgar al cliente. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout de ${ms} ms en ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
