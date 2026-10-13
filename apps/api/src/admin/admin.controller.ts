import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ActivityQuerySchema,
  AdminOverviewQuerySchema,
  ChangePasswordSchema,
  ContactInputSchema,
  ContactsQuerySchema,
  CreateOperatorSchema,
  CreateShiftSchema,
  EndShiftSchema,
  ShiftsQuerySchema,
  UpdateContactSchema,
  UpdateOperatorSchema,
  UuidSchema,
  type ActivityQuery,
  type AdminOverviewQuery,
  type ChangePassword,
  type ContactInputParsed,
  type ContactsQuery,
  type CreateOperator,
  type CreateShift,
  type EndShift,
  type ShiftsQuery,
  type UpdateContactParsed,
  type UpdateOperator,
} from '@guardia/shared';
import { AllowPendingPassword, Auth, CurrentAuth, Roles, type OperatorClaims } from '../auth/auth.guard';
import { zod } from '../common/zod-validation.pipe';
import { ContactsService } from './contacts.service';
import { OperatorsService } from './operators.service';
import { ShiftsService } from './shifts.service';
import { StatsService } from './stats.service';

/** Usuarios de la central. Crear, editar y restablecer: solo ADMIN. Ver la lista: ADMIN y SUPERVISOR. */
@Controller('ops')
@Auth('operator')
export class OperatorsController {
  constructor(private readonly operators: OperatorsService) {}

  @Get('operators')
  @Roles('ADMIN', 'SUPERVISOR')
  list(@CurrentAuth() op: OperatorClaims) {
    return this.operators.list(op);
  }

  @Post('operators')
  @Roles('ADMIN')
  create(@CurrentAuth() op: OperatorClaims, @Body(zod(CreateOperatorSchema)) body: CreateOperator) {
    return this.operators.create(op, body);
  }

  @Patch('operators/:id')
  @Roles('ADMIN')
  update(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateOperatorSchema)) body: UpdateOperator,
  ) {
    return this.operators.update(op, id, body);
  }

  @Post('operators/:id/reset-password')
  @Roles('ADMIN')
  resetPassword(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.operators.resetPassword(op, id);
  }

  /** Cualquier operador, incluso con la contraseña temporal pendiente de cambiar. */
  @Post('me/password')
  @AllowPendingPassword()
  @HttpCode(200)
  changePassword(@CurrentAuth() op: OperatorClaims, @Body(zod(ChangePasswordSchema)) body: ChangePassword) {
    return this.operators.changeOwnPassword(op, body);
  }
}

/** Turnos. Ver y marcar el propio: todos. Programar y eliminar: ADMIN y SUPERVISOR. */
@Controller('ops/shifts')
@Auth('operator')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  list(@CurrentAuth() op: OperatorClaims, @Query(zod(ShiftsQuerySchema)) q: ShiftsQuery) {
    return this.shifts.list(op, q);
  }

  @Get('status')
  status(@CurrentAuth() op: OperatorClaims) {
    return this.shifts.status(op);
  }

  @Post('start')
  @HttpCode(200)
  start(@CurrentAuth() op: OperatorClaims) {
    return this.shifts.start(op);
  }

  @Post('end')
  @HttpCode(200)
  end(@CurrentAuth() op: OperatorClaims, @Body(zod(EndShiftSchema)) body: EndShift) {
    return this.shifts.end(op, body);
  }

  @Post()
  @Roles('ADMIN', 'SUPERVISOR')
  create(@CurrentAuth() op: OperatorClaims, @Body(zod(CreateShiftSchema)) body: CreateShift) {
    return this.shifts.create(op, body);
  }

  @Delete(':id')
  @Roles('ADMIN', 'SUPERVISOR')
  @HttpCode(204)
  remove(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.shifts.remove(op, id);
  }
}

/** Directorio de contactos del municipio. Leer: todos. Mantener: ADMIN y SUPERVISOR. */
@Controller('ops/contacts')
@Auth('operator')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@CurrentAuth() op: OperatorClaims, @Query(zod(ContactsQuerySchema)) q: ContactsQuery) {
    // Los desactivados solo los ve quien puede reactivarlos.
    const includeInactive = !!q.includeInactive && op.role !== 'OPERATOR';
    return this.contacts.list(op, includeInactive);
  }

  @Post()
  @Roles('ADMIN', 'SUPERVISOR')
  create(@CurrentAuth() op: OperatorClaims, @Body(zod(ContactInputSchema)) body: ContactInputParsed) {
    return this.contacts.create(op, body);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SUPERVISOR')
  update(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateContactSchema)) body: UpdateContactParsed,
  ) {
    return this.contacts.update(op, id, body);
  }

  @Delete(':id')
  @Roles('ADMIN', 'SUPERVISOR')
  remove(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.contacts.remove(op, id);
  }
}

/** Panel del administrador y bitácoras: ADMIN y SUPERVISOR. */
@Controller('ops/admin')
@Auth('operator')
@Roles('ADMIN', 'SUPERVISOR')
export class AdminController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  overview(@CurrentAuth() op: OperatorClaims, @Query(zod(AdminOverviewQuerySchema)) q: AdminOverviewQuery) {
    return this.stats.overview(op, q.range);
  }

  @Get('activity')
  activity(@CurrentAuth() op: OperatorClaims, @Query(zod(ActivityQuerySchema)) q: ActivityQuery) {
    return this.stats.activity(op, q);
  }
}
