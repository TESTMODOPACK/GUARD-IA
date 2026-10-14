import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  CENTRAL_ROLES,
  CreateAreaSchema,
  SetAreaModeSchema,
  SetAreaRulesSchema,
  UpdateAreaSchema,
  UuidSchema,
  type CreateArea,
  type SetAreaMode,
  type SetAreaRules,
  type UpdateArea,
} from '@guardia/shared';
import { Auth, CurrentAuth, Roles, type OperatorClaims } from '../auth/auth.guard';
import { zod } from '../common/zod-validation.pipe';
import { AreasService } from './areas.service';

/** Áreas del municipio (0013): las define el administrador municipal; los nombres los ve cualquier rol de la central. */
@Controller('ops/areas')
@Auth('operator')
export class AreasController {
  constructor(private readonly areas: AreasService) {}

  @Get()
  @Roles('ADMIN')
  config(@CurrentAuth() op: OperatorClaims) {
    return this.areas.config(op);
  }

  @Get('refs')
  @Roles(...CENTRAL_ROLES)
  refs(@CurrentAuth() op: OperatorClaims) {
    return this.areas.refs(op);
  }

  @Post()
  @Roles('ADMIN')
  create(@CurrentAuth() op: OperatorClaims, @Body(zod(CreateAreaSchema)) body: CreateArea) {
    return this.areas.create(op, body);
  }

  @Post('suggested')
  @Roles('ADMIN')
  suggested(@CurrentAuth() op: OperatorClaims) {
    return this.areas.createSuggested(op);
  }

  @Put('rules')
  @Roles('ADMIN')
  rules(@CurrentAuth() op: OperatorClaims, @Body(zod(SetAreaRulesSchema)) body: SetAreaRules) {
    return this.areas.setRules(op, body);
  }

  @Post('mode')
  @Roles('ADMIN')
  @HttpCode(200)
  mode(@CurrentAuth() op: OperatorClaims, @Body(zod(SetAreaModeSchema)) body: SetAreaMode) {
    return this.areas.setMode(op, body);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(UpdateAreaSchema)) body: UpdateArea,
  ) {
    return this.areas.update(op, id, body);
  }
}
