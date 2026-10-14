import { Module } from '@nestjs/common';
import { FieldAlarmsController, FieldController } from './field.controller';
import { FieldAlarmsService } from './field-alarms.service';
import { FieldService } from './field.service';
import { FieldWatchCron } from './field-watch.cron';

/**
 * Terreno (migración 0012, docs/plan-plataforma.md §5c): la página /terreno del funcionario y los avisos de terreno
 * en la central. DbModule, AuthModule, MediaModule, NotificationsModule y RealtimeModule son globales.
 */
@Module({
  controllers: [FieldController, FieldAlarmsController],
  providers: [FieldService, FieldAlarmsService, FieldWatchCron],
})
export class FieldModule {}
