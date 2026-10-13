import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { RateLimitService } from '../infra/rate-limit.service';
import { AuditService } from './audit.service';
import { AuthController } from './auth.controller';
import { OperatorStatusService } from './operator-status.service';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { smsProviderFactory } from './sms/sms.provider';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    RateLimitService,
    smsProviderFactory,
    AuditService,
    OperatorStatusService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokenService, RateLimitService, AuditService, OperatorStatusService],
})
export class AuthModule {}
