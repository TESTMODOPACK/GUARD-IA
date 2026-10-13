import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AddNoteSchema,
  CreateUnitSchema,
  DispatchAlertSchema,
  OpsAlertsQuerySchema,
  ReclassifyAlertSchema,
  ReferAlertSchema,
  RejectAlertSchema,
  TransferAlertSchema,
  ResolveAlertSchema,
  UpdateDispatchSchema,
  UpdateUnitSchema,
  UuidSchema,
  type AddNote,
  type CreateUnit,
  type DispatchAlert,
  type OpsAlertsQuery,
  type ReclassifyAlert,
  type ReferAlert,
  type RejectAlert,
  type TransferAlert,
  type ResolveAlert,
  type UpdateDispatch,
  type UpdateUnit,
} from '@guardia/shared';
import { Auth, CurrentAuth, Roles, type OperatorClaims } from '../auth/auth.guard';
import { zod } from '../common/zod-validation.pipe';
import { TransferService } from '../geo/transfer.service';
import { OpsService } from './ops.service';
import { UnitsService } from './units.service';

@Controller('ops')
@Auth('operator')
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly units: UnitsService,
    private readonly transfers: TransferService,
  ) {}

  @Get('alerts')
  list(@CurrentAuth() op: OperatorClaims, @Query(zod(OpsAlertsQuerySchema)) q: OpsAlertsQuery) {
    return this.ops.list(op, q);
  }

  @Get('alerts/:id')
  detail(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.ops.detail(op, id);
  }

  @Post('alerts/:id/ack')
  ack(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.ops.acknowledge(op, id);
  }

  @Post('alerts/:id/reject')
  reject(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(RejectAlertSchema)) body: RejectAlert,
  ) {
    return this.ops.reject(op, id, body);
  }

  @Post('alerts/:id/dispatch')
  dispatch(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(DispatchAlertSchema)) body: DispatchAlert,
  ) {
    return this.ops.dispatch(op, id, body);
  }

  @Post('alerts/:id/resolve')
  resolve(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(ResolveAlertSchema)) body: ResolveAlert,
  ) {
    return this.ops.resolve(op, id, body.notes, body.includeGrouped ?? false);
  }

  /** Transcribir y clasificar de nuevo (p. ej. llegó con la IA en modo de prueba o caída). */
  @Post('alerts/:id/reanalyze')
  @HttpCode(200)
  reanalyze(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.ops.reanalyze(op, id);
  }

  /** Sacar la alerta de su grupo: la central decidió que es otra situación. */
  @Post('alerts/:id/detach')
  @HttpCode(200)
  detach(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.ops.detach(op, id);
  }

  /** "Corregir clasificación": la categoría del operador manda sobre la de la IA. */
  @Post('alerts/:id/classification')
  @HttpCode(200)
  reclassify(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(ReclassifyAlertSchema)) body: ReclassifyAlert,
  ) {
    return this.ops.reclassify(op, id, body);
  }

  /** "Derivado a…": instituciones a las que la central derivó el caso. */
  @Post('alerts/:id/referral')
  @HttpCode(200)
  refer(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(ReferAlertSchema)) body: ReferAlert,
  ) {
    return this.ops.refer(op, id, body);
  }

  /** Traspaso manual al municipio donde ocurre el hecho (el agente lo hace solo cuando está claro). */
  @Post('alerts/:id/transfer')
  @HttpCode(200)
  transfer(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(TransferAlertSchema)) body: TransferAlert,
  ) {
    return this.transfers.transferByOperator(op, id, body);
  }

  /** Municipios de Guard-IA a los que se puede traspasar. */
  @Get('tenants')
  tenants(@CurrentAuth() op: OperatorClaims) {
    return this.transfers.tenantOptions(op);
  }

  @Post('alerts/:id/notes')
  note(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(AddNoteSchema)) body: AddNote,
  ) {
    return this.ops.addNote(op, id, body.text);
  }

  @Patch('dispatches/:id')
  updateDispatch(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateDispatchSchema)) body: UpdateDispatch,
  ) {
    return this.ops.updateDispatch(op, id, body);
  }

  @Get('units')
  listUnits(@CurrentAuth() op: OperatorClaims) {
    return this.units.list(op);
  }

  @Post('units')
  @Roles('ADMIN', 'SUPERVISOR')
  createUnit(@CurrentAuth() op: OperatorClaims, @Body(zod(CreateUnitSchema)) body: CreateUnit) {
    return this.units.create(op, body);
  }

  @Patch('units/:id')
  updateUnit(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateUnitSchema)) body: UpdateUnit,
  ) {
    return this.units.update(op, id, body);
  }
}
