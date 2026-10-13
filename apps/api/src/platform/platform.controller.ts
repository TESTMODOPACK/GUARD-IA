import { Body, Controller, Delete, Get, HttpCode, Ip, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  ChangeTenantStatusSchema,
  ComunaSearchQuerySchema,
  CreatePlatformUserSchema,
  CreateTenantAdminSchema,
  CreateTenantSchema,
  PlatformAuditQuerySchema,
  PlatformChangePasswordSchema,
  PlatformLoginSchema,
  PlatformTotpSchema,
  RefreshSchema,
  TestPhoneInputSchema,
  UpdatePlatformUserSchema,
  UpdateTenantSchema,
  UuidSchema,
  type ChangeTenantStatus,
  type ComunaSearchQuery,
  type CreatePlatformUser,
  type CreateTenant,
  type CreateTenantAdmin,
  type PlatformAuditQuery,
  type PlatformChangePassword,
  type PlatformLogin,
  type PlatformTotp,
  type Refresh,
  type TestPhoneInput,
  type UpdatePlatformUser,
  type UpdateTenant,
} from '@guardia/shared';
import { zod } from '../common/zod-validation.pipe';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import type { PlatformClaims } from './platform-tokens.service';
import { PlatformUsersService } from './platform-users.service';
import {
  AllowPendingPlatformPassword,
  CurrentPlatformUser,
  PlatformGuard,
  PlatformRoles,
  TENANT_MANAGERS,
} from './platform.guard';
import { PlatformTenantsService } from './tenants.service';
import { TerritoryService } from './territory.service';

const RegionCutSchema = z.coerce.number().int().min(1).max(16);

/** Ingreso a la consola (sin token). */
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body(zod(PlatformLoginSchema)) body: PlatformLogin, @Ip() ip: string) {
    return this.auth.login(body.email, body.password, ip);
  }

  @Post('totp')
  @HttpCode(200)
  totp(@Body(zod(PlatformTotpSchema)) body: PlatformTotp, @Ip() ip: string) {
    return this.auth.verifyCode(body.challengeToken, body.code, ip);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(zod(RefreshSchema)) body: Refresh, @Ip() ip: string) {
    return this.auth.refresh(body.refreshToken, ip);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body(zod(RefreshSchema)) body: Refresh, @Ip() ip: string) {
    await this.auth.logout(body.refreshToken, ip);
  }
}

/**
 * Consola de plataforma (docs/plan-plataforma.md, P1). Lectura: cualquier rol. Cambios en municipios:
 * superadministrador e implementación (dar de baja, solo superadministrador). Usuarios: superadministrador.
 */
@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly territory: TerritoryService,
    private readonly tenants: PlatformTenantsService,
    private readonly users: PlatformUsersService,
    private readonly audit: PlatformAuditService,
  ) {}

  // ----- cuenta propia
  @Get('me')
  @AllowPendingPlatformPassword()
  me(@CurrentPlatformUser() u: PlatformClaims) {
    return this.auth.me(u.sub);
  }

  @Post('me/password')
  @HttpCode(200)
  @AllowPendingPlatformPassword()
  changePassword(
    @CurrentPlatformUser() u: PlatformClaims,
    @Body(zod(PlatformChangePasswordSchema)) body: PlatformChangePassword,
    @Ip() ip: string,
  ) {
    return this.auth.changeOwnPassword(u.sub, body, ip);
  }

  // ----- regiones y comunas
  @Get('regions')
  regions(@CurrentPlatformUser() u: PlatformClaims) {
    return this.territory.regions(u.sub);
  }

  @Get('regions/:cut')
  region(@CurrentPlatformUser() u: PlatformClaims, @Param('cut', zod(RegionCutSchema)) cut: number) {
    return this.territory.region(u.sub, cut);
  }

  @Get('regions/:cut/map')
  regionMap(@CurrentPlatformUser() u: PlatformClaims, @Param('cut', zod(RegionCutSchema)) cut: number) {
    return this.territory.map(u.sub, cut);
  }

  @Get('map')
  countryMap(@CurrentPlatformUser() u: PlatformClaims) {
    return this.territory.map(u.sub, null);
  }

  @Get('comunas')
  searchComunas(@CurrentPlatformUser() u: PlatformClaims, @Query(zod(ComunaSearchQuerySchema)) q: ComunaSearchQuery) {
    return this.territory.search(u.sub, q.q);
  }

  // ----- municipios
  @Get('tenants')
  listTenants(@CurrentPlatformUser() u: PlatformClaims) {
    return this.tenants.list(u);
  }

  @Get('tenants/:id')
  tenant(@CurrentPlatformUser() u: PlatformClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.tenants.detail(u, id);
  }

  @Post('tenants')
  @PlatformRoles(...TENANT_MANAGERS)
  createTenant(@CurrentPlatformUser() u: PlatformClaims, @Body(zod(CreateTenantSchema)) body: CreateTenant, @Ip() ip: string) {
    return this.tenants.create(u, body, ip);
  }

  @Patch('tenants/:id')
  @PlatformRoles(...TENANT_MANAGERS)
  updateTenant(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateTenantSchema)) body: UpdateTenant,
    @Ip() ip: string,
  ) {
    return this.tenants.update(u, id, body, ip);
  }

  @Post('tenants/:id/status')
  @HttpCode(200)
  @PlatformRoles(...TENANT_MANAGERS)
  changeStatus(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(ChangeTenantStatusSchema)) body: ChangeTenantStatus,
    @Ip() ip: string,
  ) {
    return this.tenants.changeStatus(u, id, body, ip);
  }

  @Post('tenants/:id/admins')
  @PlatformRoles(...TENANT_MANAGERS)
  createAdmin(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(CreateTenantAdminSchema)) body: CreateTenantAdmin,
    @Ip() ip: string,
  ) {
    return this.tenants.createAdmin(u, id, body, ip);
  }

  @Post('tenants/:id/admins/:adminId/reset')
  @HttpCode(200)
  @PlatformRoles(...TENANT_MANAGERS)
  resetAdmin(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Param('adminId', zod(UuidSchema)) adminId: string,
    @Ip() ip: string,
  ) {
    return this.tenants.resetAdmin(u, id, adminId, ip);
  }

  @Post('tenants/:id/test-phones')
  @PlatformRoles(...TENANT_MANAGERS)
  addTestPhone(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(TestPhoneInputSchema)) body: TestPhoneInput,
    @Ip() ip: string,
  ) {
    return this.tenants.addTestPhone(u, id, body, ip);
  }

  @Delete('tenants/:id/test-phones/:phoneId')
  @HttpCode(204)
  @PlatformRoles(...TENANT_MANAGERS)
  async removeTestPhone(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Param('phoneId', zod(UuidSchema)) phoneId: string,
    @Ip() ip: string,
  ) {
    await this.tenants.removeTestPhone(u, id, phoneId, ip);
  }

  // ----- bitácora
  @Get('audit')
  auditLog(@CurrentPlatformUser() u: PlatformClaims, @Query(zod(PlatformAuditQuerySchema)) q: PlatformAuditQuery) {
    return this.audit.list(u.sub, q);
  }

  // ----- equipo Guard-IA
  @Get('users')
  @PlatformRoles('SUPERADMIN')
  listUsers(@CurrentPlatformUser() u: PlatformClaims) {
    return this.users.list(u);
  }

  @Post('users')
  @PlatformRoles('SUPERADMIN')
  createUser(@CurrentPlatformUser() u: PlatformClaims, @Body(zod(CreatePlatformUserSchema)) body: CreatePlatformUser, @Ip() ip: string) {
    return this.users.create(u, body, ip);
  }

  @Patch('users/:id')
  @PlatformRoles('SUPERADMIN')
  updateUser(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdatePlatformUserSchema)) body: UpdatePlatformUser,
    @Ip() ip: string,
  ) {
    return this.users.update(u, id, body, ip);
  }

  @Post('users/:id/reset')
  @HttpCode(200)
  @PlatformRoles('SUPERADMIN')
  resetUser(@CurrentPlatformUser() u: PlatformClaims, @Param('id', zod(UuidSchema)) id: string, @Ip() ip: string) {
    return this.users.reset(u, id, ip);
  }
}
