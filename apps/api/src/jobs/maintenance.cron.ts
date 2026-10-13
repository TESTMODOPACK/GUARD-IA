import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql, type SQL } from 'drizzle-orm';
import { DbService } from '../db/db.service';

/**
 * Purga de tablas que solo crecen (A5 de docs/revision-base-de-datos.md): refresh tokens vencidos (un token
 * rotado se guarda hasta su vencimiento para detectar reutilización) y códigos de ingreso que nadie usó
 * (una ráfaga de SMS pumping no debe engordar la tabla). Por lotes y con SKIP LOCKED: nunca compite con
 * un ingreso en curso.
 */
@Injectable()
export class MaintenanceCron {
  private readonly logger = new Logger(MaintenanceCron.name);

  constructor(private readonly dbs: DbService) {}

  @Cron('*/10 * * * *')
  async purge() {
    try {
      const tokens = await this.purgeBatch(sql`
        DELETE FROM refresh_token WHERE id IN (
          SELECT id FROM refresh_token WHERE expires_at < now() - interval '1 day'
           ORDER BY expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED)`);
      const codes = await this.purgeBatch(sql`
        DELETE FROM otp_code WHERE id IN (
          SELECT id FROM otp_code WHERE expires_at < now() - interval '1 hour'
           ORDER BY expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED)`);
      // Sesiones de la consola de plataforma (0010): mismo criterio que los refresh tokens.
      const sessions = await this.purgeBatch(sql`
        DELETE FROM platform_session WHERE id IN (
          SELECT id FROM platform_session WHERE expires_at < now() - interval '1 day'
           ORDER BY expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED)`);
      if (tokens + codes + sessions > 0) {
        this.logger.log(`Purga: ${tokens} refresh tokens, ${codes} códigos de ingreso y ${sessions} sesiones de plataforma vencidos`);
      }
    } catch (e) {
      this.logger.warn(`Purga de mantenimiento falló: ${(e as Error).message}`);
    }
  }

  private async purgeBatch(statement: SQL): Promise<number> {
    const r = await this.dbs.asSystem((tx) => tx.execute(statement));
    return (r as unknown as { count?: number }).count ?? 0;
  }
}
