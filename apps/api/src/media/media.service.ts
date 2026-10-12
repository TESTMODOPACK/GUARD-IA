import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { MediaKind, MediaPublic } from '@guardia/shared';
import { toMediaPublic } from '../common/mappers';
import { ENV, type Env } from '../config/env';
import { DbService, type Tx } from '../db/db.service';
import { media, type MediaRow } from '../db/schema';
import { STORAGE, type Storage } from './storage';

const ALLOWED_MIME: Record<MediaKind, readonly string[]> = {
  AUDIO: ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/3gpp'],
  PHOTO: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
};

const EXT_BY_MIME: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/3gpp': '3gp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(STORAGE) private readonly storage: Storage,
    private readonly dbs: DbService,
  ) {}

  isAllowed(kind: MediaKind, mime: string): boolean {
    return ALLOWED_MIME[kind].includes(mime.toLowerCase());
  }

  /** Clave determinista por alerta: tenant (o 'unrouted') / año-mes / alerta / kind-uuid.ext */
  buildKey(kind: MediaKind, alertId: string, tenantId: string | null, mime: string): string {
    const d = new Date();
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const ext = EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
    return `${tenantId ?? 'unrouted'}/${ym}/${alertId}/${kind.toLowerCase()}-${randomUUID()}.${ext}`;
  }

  /** Sube el archivo y registra la fila en la misma transacción de la alerta. */
  async store(
    tx: Tx,
    input: {
      alertId: string;
      tenantId: string | null;
      kind: MediaKind;
      body: Buffer;
      mime: string;
      retentionDays: number;
    },
  ): Promise<MediaRow> {
    const key = this.buildKey(input.kind, input.alertId, input.tenantId, input.mime);
    await this.storage.put(key, input.body, input.mime);
    const [row] = await tx
      .insert(media)
      .values({
        alertId: input.alertId,
        tenantId: input.tenantId,
        kind: input.kind,
        storageKey: key,
        mime: input.mime,
        bytes: input.body.byteLength,
        retentionUntil: new Date(Date.now() + input.retentionDays * 86_400_000),
      })
      .returning();
    return row;
  }

  async download(key: string): Promise<Buffer> {
    return this.storage.get(key);
  }

  async toPublic(rows: MediaRow[]): Promise<MediaPublic[]> {
    return Promise.all(
      rows.map(async (r) =>
        toMediaPublic(
          r,
          r.deletedAt ? null : await this.storage.signedUrl(r.storageKey, this.env.SIGNED_URL_TTL_SECONDS),
        ),
      ),
    );
  }

  async signedUrlFor(row: MediaRow) {
    return this.storage.signedUrl(row.storageKey, this.env.SIGNED_URL_TTL_SECONDS);
  }

  /**
   * Purga diaria: marca deleted_at primero (la URL deja de firmarse) y luego borra del storage,
   * sin retener una transacción mientras se habla con S3. La transcripción queda en alert.
   */
  async purgeExpired(limit = 500): Promise<number> {
    const rows = await this.dbs.asSystem((tx) =>
      tx
        .select()
        .from(media)
        .where(and(isNull(media.deletedAt), lt(media.retentionUntil, new Date())))
        .limit(limit),
    );
    let n = 0;
    for (const r of rows) {
      try {
        await this.dbs.asSystem((tx) => tx.update(media).set({ deletedAt: new Date() }).where(eq(media.id, r.id)));
        await this.storage.delete(r.storageKey).catch((e: Error) => {
          // Un archivo que ya no existe no es un error de purga.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        });
        n++;
      } catch (e) {
        this.logger.error(`No se pudo purgar ${r.storageKey}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  async storagePing() {
    return this.storage.ping();
  }
}
