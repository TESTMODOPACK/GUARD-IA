import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CreateAlertMetaSchema, CursorPaginationSchema, UuidSchema, type CursorPagination } from '@guardia/shared';
import { Auth, CurrentAuth, type CitizenClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { zod } from '../common/zod-validation.pipe';
import { ENV, type Env } from '../config/env';
import { AlertsService, type UploadedFile } from './alerts.service';

type MulterFiles = { audio?: Express.Multer.File[]; photo?: Express.Multer.File[] };

@Controller('alerts')
@Auth('citizen')
export class AlertsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * multipart/form-data: `meta` (JSON string) + `audio`? + `photo`?.
   * El límite de tamaño lo aplica multer (MAX_UPLOAD_BYTES por archivo).
   */
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'audio', maxCount: 1 },
        { name: 'photo', maxCount: 1 },
      ],
      { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2 } },
    ),
  )
  async create(
    @CurrentAuth() auth: CitizenClaims,
    @Body('meta') metaRaw: unknown,
    @UploadedFiles() files: MulterFiles | undefined,
  ) {
    const meta = parseMeta(metaRaw);
    const audio = files?.audio?.[0];
    const photo = files?.photo?.[0];
    for (const f of [audio, photo]) {
      if (f && f.size > this.env.MAX_UPLOAD_BYTES) {
        throw new AppError('MEDIA_TOO_LARGE', `Máximo ${Math.round(this.env.MAX_UPLOAD_BYTES / 1024 / 1024)} MB por archivo`);
      }
    }
    return this.alerts.create(auth.sub, meta, {
      audio: audio ? toUploaded(audio) : undefined,
      photo: photo ? toUploaded(photo) : undefined,
    });
  }

  @Post(':id/cancel')
  cancel(@CurrentAuth() auth: CitizenClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.alerts.cancel(auth.sub, id);
  }

  @Get('mine')
  mine(@CurrentAuth() auth: CitizenClaims, @Query(zod(CursorPaginationSchema)) q: CursorPagination) {
    return this.alerts.mine(auth.sub, q.limit);
  }

  @Get(':id')
  one(@CurrentAuth() auth: CitizenClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.alerts.one(auth.sub, id);
  }
}

function parseMeta(raw: unknown) {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'El campo meta debe ser JSON válido');
    }
  }
  if (obj === undefined) throw new AppError('VALIDATION_ERROR', 'Falta el campo meta');
  const r = CreateAlertMetaSchema.safeParse(obj);
  if (!r.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'meta inválido',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

function toUploaded(f: Express.Multer.File): UploadedFile {
  return { buffer: f.buffer, mimetype: f.mimetype, size: f.size };
}
