import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { UnitsService } from './units.service';

@Module({
  // AlertsService: encolar un nuevo análisis de IA ("volver a analizar").
  imports: [AlertsModule],
  controllers: [OpsController],
  providers: [OpsService, UnitsService],
})
export class OpsModule {}
