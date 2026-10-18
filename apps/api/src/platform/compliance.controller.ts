import { Body, Controller, Delete, Get, Ip, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  AuthorizeSubprocessorSchema,
  CreateIncidentSchema,
  CreateSubprocessorSchema,
  NotifyIncidentTenantSchema,
  UpdateIncidentSchema,
  UpdateSubprocessorSchema,
  UuidSchema,
  type AuthorizeSubprocessor,
  type CreateIncident,
  type CreateSubprocessor,
  type NotifyIncidentTenant,
  type PlatformRole,
  type UpdateIncident,
  type UpdateSubprocessor,
} from '@guardia/shared';
import { zod } from '../common/zod-validation.pipe';
import { PlatformComplianceService } from './compliance.service';
import type { PlatformClaims } from './platform-tokens.service';
import { CurrentPlatformUser, PlatformGuard, PlatformRoles, TENANT_MANAGERS } from './platform.guard';

/** Quien atiende un incidente: cualquiera del equipo que no sea finanzas puede declararlo y avisar (procedimiento 0.6). */
const INCIDENT_MANAGERS: PlatformRole[] = ['SUPERADMIN', 'IMPLEMENTATION', 'SUPPORT'];

/** Ley 21.719 en la consola (0014): subencargados y su autorización por municipio, e incidentes de seguridad. */
@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformComplianceController {
  constructor(private readonly compliance: PlatformComplianceService) {}

  // ----- subencargados
  @Get('subprocessors')
  subprocessors(@CurrentPlatformUser() u: PlatformClaims) {
    return this.compliance.subprocessors(u);
  }

  @Post('subprocessors')
  @PlatformRoles('SUPERADMIN')
  createSubprocessor(
    @CurrentPlatformUser() u: PlatformClaims,
    @Body(zod(CreateSubprocessorSchema)) body: CreateSubprocessor,
    @Ip() ip: string,
  ) {
    return this.compliance.createSubprocessor(u, body, ip);
  }

  @Patch('subprocessors/:id')
  @PlatformRoles('SUPERADMIN')
  updateSubprocessor(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateSubprocessorSchema)) body: UpdateSubprocessor,
    @Ip() ip: string,
  ) {
    return this.compliance.updateSubprocessor(u, id, body, ip);
  }

  @Post('tenants/:id/subprocessors')
  @PlatformRoles(...TENANT_MANAGERS)
  authorize(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(AuthorizeSubprocessorSchema)) body: AuthorizeSubprocessor,
    @Ip() ip: string,
  ) {
    return this.compliance.authorize(u, id, body, ip);
  }

  @Delete('tenants/:id/subprocessors/:authorizationId')
  @PlatformRoles(...TENANT_MANAGERS)
  revoke(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Param('authorizationId', zod(UuidSchema)) authorizationId: string,
    @Ip() ip: string,
  ) {
    return this.compliance.revoke(u, id, authorizationId, ip);
  }

  // ----- incidentes de seguridad
  @Get('incidents')
  incidents(@CurrentPlatformUser() u: PlatformClaims) {
    return this.compliance.incidents(u);
  }

  @Post('incidents')
  @PlatformRoles(...INCIDENT_MANAGERS)
  createIncident(@CurrentPlatformUser() u: PlatformClaims, @Body(zod(CreateIncidentSchema)) body: CreateIncident, @Ip() ip: string) {
    return this.compliance.createIncident(u, body, ip);
  }

  @Patch('incidents/:id')
  @PlatformRoles(...INCIDENT_MANAGERS)
  updateIncident(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateIncidentSchema)) body: UpdateIncident,
    @Ip() ip: string,
  ) {
    return this.compliance.updateIncident(u, id, body, ip);
  }

  @Post('incidents/:id/tenants')
  @PlatformRoles(...INCIDENT_MANAGERS)
  notifyTenant(
    @CurrentPlatformUser() u: PlatformClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(NotifyIncidentTenantSchema)) body: NotifyIncidentTenant,
    @Ip() ip: string,
  ) {
    return this.compliance.notifyTenant(u, id, body.tenantId, ip);
  }
}
