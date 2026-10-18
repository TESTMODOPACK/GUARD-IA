import { Body, Controller, Get, Header, Param, Post, Put } from '@nestjs/common';
import {
  RecordIncidentReportSchema,
  UpdateTenantPrivacySchema,
  UuidSchema,
  type RecordIncidentReport,
  type UpdateTenantPrivacy,
} from '@guardia/shared';
import { Auth, CurrentAuth, Roles, type OperatorClaims } from '../auth/auth.guard';
import { zod } from '../common/zod-validation.pipe';
import { LegalService } from './legal.service';
import { TenantPrivacyService } from './tenant-privacy.service';

/**
 * Aviso al vecino (0014): público y sin datos personales. La app lo muestra antes de aceptar y puede leerlo antes de
 * tener cuenta.
 */
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Get('notice')
  @Header('Cache-Control', 'public, max-age=60')
  notice() {
    return this.legal.notice();
  }
}

/** «Privacidad» de la central (0014). Lo edita el administrador municipal; el supervisor lo consulta. */
@Controller('ops/privacy')
@Auth('operator')
export class TenantPrivacyController {
  constructor(private readonly privacy: TenantPrivacyService) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR')
  overview(@CurrentAuth() op: OperatorClaims) {
    return this.privacy.overview(op);
  }

  @Put()
  @Roles('ADMIN')
  update(@CurrentAuth() op: OperatorClaims, @Body(zod(UpdateTenantPrivacySchema)) body: UpdateTenantPrivacy) {
    return this.privacy.update(op, body);
  }

  @Post('incidents/:id/report')
  @Roles('ADMIN')
  report(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(RecordIncidentReportSchema)) body: RecordIncidentReport,
  ) {
    return this.privacy.recordReport(op, id, body);
  }
}
