import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Env } from '../config/env';

export const STORAGE = 'STORAGE' as const;

/** Forma exacta de las claves que genera MediaService.buildKey: sin `..`, sin barras dobles. */
const KEY_PATTERN = /^[a-z0-9-]+\/\d{4}-\d{2}\/[0-9a-f-]{36}\/(audio|photo)-[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface Storage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSeconds: number): Promise<SignedUrl>;
  ping(): Promise<boolean>;
}

/** MinIO / S3 (producción). */
@Injectable()
export class S3Storage implements Storage {
  private readonly client: S3Client;
  /** Solo firma URLs (no toca la red): apunta a la dirección pública si existe. */
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(env: Env) {
    if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
      throw new Error('STORAGE_DRIVER=s3 requiere S3_ACCESS_KEY y S3_SECRET_KEY');
    }
    this.bucket = env.S3_BUCKET;
    const base = {
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    };
    this.client = new S3Client({ ...base, endpoint: env.S3_ENDPOINT });
    // La firma incluye el host: se firma contra el host que el navegador va a pedir. El proxy
    // (Caddy) reenvía ese Host a MinIO sin cambiarlo, así que la firma se valida igual.
    this.signer = env.S3_PUBLIC_ENDPOINT ? new S3Client({ ...base, endpoint: env.S3_PUBLIC_ENDPOINT }) : this.client;
  }

  async put(key: string, body: Buffer, mime: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }),
    );
  }

  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Objeto vacío: ${key}`);
    return Buffer.from(bytes);
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async signedUrl(key: string, ttlSeconds: number) {
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async ping() {
    try {
      // HeadBucket requiere permisos extra; una firma no toca la red y basta como "configurado".
      await this.signedUrl('healthcheck', 10);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Disco local (solo desarrollo). Las URLs se firman con HMAC y las sirve
 * GET /v1/media/local/:key?exp=&sig=.
 */
@Injectable()
export class LocalStorage implements Storage {
  private readonly logger = new Logger(LocalStorage.name);
  private readonly dir: string;

  constructor(private readonly env: Env) {
    this.dir = resolve(env.LOCAL_STORAGE_DIR);
    this.logger.warn(`Almacenamiento local en ${this.dir} (solo desarrollo)`);
  }

  private path(key: string) {
    if (!KEY_PATTERN.test(key)) throw new Error('Clave de almacenamiento inválida');
    const p = resolve(join(this.dir, key));
    if (p !== this.dir && !p.startsWith(this.dir + sep)) throw new Error('Clave de almacenamiento inválida');
    return p;
  }

  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  sign(key: string, exp: number) {
    return createHmac('sha256', this.env.LOCAL_STORAGE_SECRET).update(`${key}:${exp}`).digest('hex');
  }

  verify(key: string, exp: number, sig: string): boolean {
    if (exp * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async signedUrl(key: string, ttlSeconds: number) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.sign(key, exp);
    const url = `${this.env.PUBLIC_API_URL}/v1/media/local/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
    return { url, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async ping() {
    try {
      await mkdir(this.dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}
