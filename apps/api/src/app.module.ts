import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { stdSerializers } from 'pino-http';
import { AiModule } from './ai/ai.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { InfraModule } from './infra/infra.module';
import { RedisModule } from './infra/redis.module';
import { AiOutboxCron } from './jobs/ai-outbox.cron';
import { MaintenanceCron } from './jobs/maintenance.cron';
import { RetentionCron } from './jobs/retention.cron';
import { MediaModule } from './media/media.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OpsModule } from './ops/ops.module';
import { AdminModule } from './admin/admin.module';
import { GeoModule } from './geo/transfer.service';
import { IncidentsModule } from './incidents/incidents.service';
import { AccountsModule } from './accounts/accounts.module';
import { PlatformModule } from './platform/platform.module';
import { PrivacyModule } from './privacy/privacy.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
          redact: ['req.headers.authorization', 'req.headers.cookie', 'req.query.sig', 'req.body.password', 'req.body.code'],
          serializers: {
            // Las URLs firmadas del driver local llevan la firma en la query: no va al log.
            req: (req) => {
              const r = stdSerializers.req(req);
              if (typeof r.url === 'string') r.url = r.url.replace(/([?&]sig=)[^&]+/g, '$1[Redacted]');
              return r;
            },
          },
          autoLogging: { ignore: (req) => req.url === '/v1/health' || req.url === '/v1/metrics' },
        },
      }),
    }),
    BullModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => {
        const u = new URL(env.REDIS_URL);
        return {
          connection: {
            host: u.hostname,
            port: Number(u.port || 6379),
            password: u.password || undefined,
            username: u.username || undefined,
            db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    ScheduleModule.forRoot(),
    InfraModule,
    RedisModule,
    DbModule,
    MediaModule,
    AuthModule,
    NotificationsModule,
    RealtimeModule,
    AiModule,
    AlertsModule,
    OpsModule,
    PrivacyModule,
    AdminModule,
    IncidentsModule,
    GeoModule,
    PlatformModule,
    AccountsModule,
  ],
  controllers: [HealthController],
  providers: [RetentionCron, AiOutboxCron, MaintenanceCron],
})
export class AppModule {}
