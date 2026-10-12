import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { UnitsService } from './units.service';

@Module({
  controllers: [OpsController],
  providers: [OpsService, UnitsService],
})
export class OpsModule {}
