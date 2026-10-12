import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env';
import { S3Storage } from '../src/media/storage';

const env = (extra: Record<string, string> = {}) =>
  validateEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'x'.repeat(40),
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'http://minio:9000',
    S3_ACCESS_KEY: 'test-access',
    S3_SECRET_KEY: 'test-secret-key',
    ...extra,
  });

const KEY = 'demo/2026-10/00000000-0000-0000-0000-000000000000/audio-00000000-0000-0000-0000-000000000001.m4a';

describe('S3Storage.signedUrl', () => {
  it('firma contra la dirección pública cuando existe (el navegador no alcanza minio:9000)', async () => {
    const { url } = await new S3Storage(env({ S3_PUBLIC_ENDPOINT: 'https://media.example.cl' })).signedUrl(KEY, 300);
    const u = new URL(url);
    expect(u.origin).toBe('https://media.example.cl');
    expect(u.pathname).toBe(`/guardia-media/${KEY}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('sin dirección pública usa el endpoint de S3', async () => {
    const { url } = await new S3Storage(env()).signedUrl(KEY, 60);
    expect(new URL(url).origin).toBe('http://minio:9000');
  });
});
