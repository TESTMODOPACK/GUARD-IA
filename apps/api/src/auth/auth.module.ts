import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { RateLimitService } from '../infra/rate-limit.service';
import { AuthController } from './auth.controller';
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
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokenService, RateLimitService],
})
export class AuthModule {}
