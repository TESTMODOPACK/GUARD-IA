import { Global, Module } from '@nestjs/common';
import { AlertReadService } from '../alerts/alert-read.service';
import { CitizenGateway, OpsGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  providers: [RealtimeService, AlertReadService, OpsGateway, CitizenGateway],
  exports: [RealtimeService, AlertReadService],
})
export class RealtimeModule {}
