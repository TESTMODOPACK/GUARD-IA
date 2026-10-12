import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { UuidSchema } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { zod } from '../common/zod-validation.pipe';
import { DbService } from '../db/db.service';
import { media } from '../db/schema';
import { Auth, CurrentAuth, type OperatorClaims } from '../auth/auth.guard';
import { MediaService } from './media.service';
import { LocalStorage, STORAGE, type Storage } from './storage';

@Controller()
export class MediaController {
  constructor(
    private readonly mediaSvc: MediaService,
    private readonly dbs: DbService,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  /** Firma nueva para volver a reproducir un audio (sección 6). */
  @Get('ops/media/:id/url')
  @Auth('operator')
  async signedUrl(@CurrentAuth() auth: OperatorClaims, @Param('id', zod(UuidSchema)) id: string) {
    return this.dbs.asOperator(auth.tenantId, auth.sub, async (tx) => {
      const [row] = await tx.select().from(media).where(eq(media.id, id)).limit(1);
      if (!row) throw new AppError('NOT_FOUND', 'Media no encontrada');
      if (row.deletedAt) throw new AppError('NOT_FOUND', 'El archivo fue purgado por retención');
      return this.mediaSvc.signedUrlFor(row);
    });
  }

  /** Sirve archivos del driver local (solo desarrollo). URL firmada con HMAC. */
  @Get('media/local/:key')
  async local(
    @Param('key') key: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    if (!(this.storage instanceof LocalStorage)) throw new AppError('NOT_FOUND', 'No disponible');
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || !sig || !this.storage.verify(key, expNum, sig)) {
      throw new AppError('FORBIDDEN', 'Firma inválida o vencida');
    }
    let body: Buffer;
    try {
      body = await this.storage.get(key);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', 'Archivo no encontrado');
      throw new AppError('FORBIDDEN', 'Clave inválida');
    }
    res.setHeader('Content-Type', mimeFromKey(key));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(body);
  }
}

function mimeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'm4a':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'webm':
      return 'audio/webm';
    case 'ogg':
      return 'audio/ogg';
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
