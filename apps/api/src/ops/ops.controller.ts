import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AddNoteSchema,
  CreateUnitSchema,
  DispatchAlertSchema,
  OpsAlertsQuerySchema,
  RejectAlertSchema,
  ResolveAlertSchema,
  UpdateDispatchSchema,
  UpdateUnitSchema,
  UuidSchema,
  type AddNote,
  type CreateUnit,
  type DispatchAlert,
  type OpsAlertsQuery,
  type RejectAlert,
  type ResolveAlert,
  type UpdateDispatch,
  type UpdateUnit,
} from '@guardia/shared';
import { Auth, CurrentAuth, Roles, type OperatorClaims } from '../auth/auth.guard';
import { zod } from '../common/zod-validation.pipe';
import { OpsService } from './ops.service';
import { UnitsService } from './units.service';

@Controller('ops')
@Auth('operator')
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly units: UnitsService,
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
    return this.ops.resolve(op, id, body.notes);
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
