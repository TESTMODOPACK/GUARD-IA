import { Body, Controller, Get, HttpCode, Ip, Param, Post, Put } from '@nestjs/common';
import {
  ConsentSchema,
  DeviceUpsertSchema,
  OperatorLoginSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  PhoneSchema,
  RefreshSchema,
  type Consent,
  type DeviceUpsert,
  type OperatorLogin,
  type OtpRequest,
  type OtpVerify,
  type Refresh,
} from '@guardia/shared';
import { zod } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { Auth, CurrentAuth, type CitizenClaims } from './auth.guard';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ----- ciudadano
  @Post('auth/otp/request')
  @HttpCode(204)
  async otpRequest(@Body(zod(OtpRequestSchema)) body: OtpRequest, @Ip() ip: string) {
    await this.auth.requestOtp(body.phone, ip);
  }

  @Post('auth/otp/verify')
  otpVerify(@Body(zod(OtpVerifySchema)) body: OtpVerify, @Ip() ip: string) {
    return this.auth.verifyOtp(body.phone, body.code, ip);
  }

  @Post('auth/refresh')
  refresh(@Body(zod(RefreshSchema)) body: Refresh) {
    return this.auth.refresh(body.refreshToken);
  }

  /** Vecino y operador. Sin access token: poseer el refresh basta para revocarlo. Siempre 204. */
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Body(zod(RefreshSchema)) body: Refresh) {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  @Auth('citizen')
  me(@CurrentAuth() auth: CitizenClaims) {
    return this.auth.me(auth.sub);
  }

  @Post('me/consent')
  @Auth('citizen')
  @HttpCode(204)
  async consent(@CurrentAuth() auth: CitizenClaims, @Body(zod(ConsentSchema)) body: Consent) {
    await this.auth.acceptConsent(auth.sub, body.version);
  }

  @Put('me/devices')
  @Auth('citizen')
  @HttpCode(204)
  async device(@CurrentAuth() auth: CitizenClaims, @Body(zod(DeviceUpsertSchema)) body: DeviceUpsert) {
    await this.auth.upsertDevice(auth.sub, body);
  }

  // ----- operador
  @Post('ops/auth/login')
  login(@Body(zod(OperatorLoginSchema)) body: OperatorLogin, @Ip() ip: string) {
    return this.auth.operatorLogin(body.email, body.password, ip);
  }

  // ----- desarrollo
  @Get('dev/otp/:phone')
  devOtp(@Param('phone', zod(PhoneSchema)) phone: string) {
    return this.auth.devPeekOtp(phone);
  }
}
