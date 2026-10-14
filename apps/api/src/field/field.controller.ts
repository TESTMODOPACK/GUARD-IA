import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  AckFieldAlarmSchema,
  CENTRAL_ROLES,
  OPERATING_ROLES,
  FIELD_PHOTOS_MAX,
  FieldLocationSchema,
  FieldReportSchema,
  FieldStatusSchema,
  PanicSchema,
  StartFieldShiftSchema,
  UuidSchema,
  type AckFieldAlarm,
  type FieldLocation,
  type FieldStatus,
  type Panic,
  type StartFieldShift,
} from '@guardia/shared';
import { Auth, CurrentAuth, Roles, type OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { zod } from '../common/zod-validation.pipe';
import { ENV, type Env } from '../config/env';
import { FieldAlarmsService } from './field-alarms.service';
import { FieldService } from './field.service';

/** /ops/field: solo el funcionario de terreno (rol FIELD). Todo lo demás de /ops le está cerrado (AuthGuard). */
@Controller('ops/field')
@Auth('operator')
@Roles('FIELD')
export class FieldController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly field: FieldService,
  ) {}

  @Get('state')
  state(@CurrentAuth() op: OperatorClaims) {
    return this.field.state(op);
  }

  @Post('shift/start')
  @HttpCode(200)
  start(@CurrentAuth() op: OperatorClaims, @Body(zod(StartFieldShiftSchema)) body: StartFieldShift) {
    return this.field.startShift(op, body);
  }

  @Post('shift/end')
  @HttpCode(200)
  end(@CurrentAuth() op: OperatorClaims) {
    return this.field.endShift(op);
  }

  @Post('dispatches/:id/status')
  @HttpCode(200)
  status(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(FieldStatusSchema)) body: FieldStatus,
  ) {
    return this.field.setStatus(op, id, body);
  }

  /** multipart/form-data: `meta` (JSON, FieldReportSchema) + hasta 3 `photo`. */
  @Post('dispatches/:id/report')
  @HttpCode(200)
  @UseInterceptors(
    FilesInterceptor('photo', FIELD_PHOTOS_MAX, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: FIELD_PHOTOS_MAX },
    }),
  )
  report(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body('meta') metaRaw: unknown,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    const photos = files ?? [];
    for (const f of photos) {
      if (f.size > this.env.MAX_UPLOAD_BYTES) {
        throw new AppError('MEDIA_TOO_LARGE', `Máximo ${Math.round(this.env.MAX_UPLOAD_BYTES / 1024 / 1024)} MB por foto`);
      }
    }
    return this.field.report(
      op,
      id,
      parseReport(metaRaw),
      photos.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, size: f.size })),
    );
  }

  @Post('location')
  @HttpCode(204)
  async location(@CurrentAuth() op: OperatorClaims, @Body(zod(FieldLocationSchema)) body: FieldLocation) {
    await this.field.location(op, body);
  }

  @Post('panic')
  @HttpCode(200)
  panic(@CurrentAuth() op: OperatorClaims, @Body(zod(PanicSchema)) body: Panic) {
    return this.field.panic(op, body);
  }
}

/** Avisos de terreno para la central (pánico, apoyo, plazos). */
@Controller('ops/field-alarms')
@Auth('operator')
@Roles(...CENTRAL_ROLES)
export class FieldAlarmsController {
  constructor(private readonly alarms: FieldAlarmsService) {}

  @Get()
  open(@CurrentAuth() op: OperatorClaims) {
    return this.alarms.open(op);
  }

  @Post(':id/ack')
  @Roles(...OPERATING_ROLES)
  @HttpCode(200)
  ack(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(AckFieldAlarmSchema)) body: AckFieldAlarm,
  ) {
    return this.alarms.ack(op, id, body);
  }
}

function parseReport(raw: unknown) {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'El campo meta debe ser JSON válido');
    }
  }
  if (obj === undefined) throw new AppError('VALIDATION_ERROR', 'Falta el campo meta');
  const r = FieldReportSchema.safeParse(obj);
  if (!r.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      r.error.issues[0]?.message ?? 'Informe inválido',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
