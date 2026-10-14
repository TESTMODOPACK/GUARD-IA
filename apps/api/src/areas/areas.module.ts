import { Module } from '@nestjs/common';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';

/** Áreas municipales (0013). DbModule, AuthModule y RealtimeModule son globales. */
@Module({
  controllers: [AreasController],
  providers: [AreasService],
})
export class AreasModule {}
