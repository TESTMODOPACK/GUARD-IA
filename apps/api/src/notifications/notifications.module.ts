import { Global, Module } from '@nestjs/common';
import { EventsService } from '../events/events.service';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  providers: [NotificationsService, EventsService],
  exports: [NotificationsService, EventsService],
})
export class NotificationsModule {}
