import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MediaService } from '../media/media.service';

/** Purga diaria de audio y fotos vencidos (ADR 005). */
@Injectable()
export class RetentionCron {
  private readonly logger = new Logger(RetentionCron.name);

  constructor(private readonly mediaSvc: MediaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { timeZone: 'America/Santiago' })
  async purge() {
    const n = await this.mediaSvc.purgeExpired();
    if (n > 0) this.logger.log(`Purgados ${n} archivos por retención`);
  }
}
