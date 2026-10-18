import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
};
const PLATFORM = { PLATFORM_JWT_SECRET: 'y'.repeat(40), PLATFORM_ENCRYPTION_KEY: 'z'.repeat(40) };
const PRIVACY = { PRIVACY_CONTACT_EMAIL: 'privacidad@guardia.cl' };

describe('validateEnv', () => {
  it('degrada a mock sin OPENAI_API_KEY', () => {
    const env = validateEnv({ ...base, STORAGE_DRIVER: 'local' });
    expect(env.AI_PROVIDER).toBe('mock');
  });

  it('rechaza producción con OTP_DEBUG_ENDPOINT aunque falte OPENAI_API_KEY', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', OTP_DEBUG_ENDPOINT: 'true', STORAGE_DRIVER: 's3', SMS_PROVIDER: 'twilio', LOCAL_STORAGE_SECRET: 'p'.repeat(32) }),
    ).toThrow(/OTP_DEBUG_ENDPOINT/);
  });

  it('rechaza producción con storage local, SMS console o secreto por defecto', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', STORAGE_DRIVER: 'local', SMS_PROVIDER: 'twilio' })).toThrow(/STORAGE_DRIVER=local/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', STORAGE_DRIVER: 's3', SMS_PROVIDER: 'console' })).toThrow(/SMS_PROVIDER=console/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', STORAGE_DRIVER: 's3', SMS_PROVIDER: 'twilio' })).toThrow(/LOCAL_STORAGE_SECRET/);
  });

  it('rechaza producción con MinIO interno sin dirección pública', () => {
    const prod = { ...base, ...PLATFORM, ...PRIVACY, NODE_ENV: 'production', STORAGE_DRIVER: 's3', SMS_PROVIDER: 'twilio', LOCAL_STORAGE_SECRET: 'p'.repeat(32) };
    expect(() => validateEnv({ ...prod, S3_ENDPOINT: 'http://minio:9000' })).toThrow(/S3_PUBLIC_ENDPOINT/);
    expect(() => validateEnv({ ...prod, S3_ENDPOINT: 'http://minio:9000', S3_PUBLIC_ENDPOINT: 'https://media.example.cl' })).not.toThrow();
    // S3 de un proveedor (sin endpoint propio): la URL firmada ya es pública.
    expect(() => validateEnv(prod)).not.toThrow();
  });

  it('en producción exige los secretos de la consola de plataforma, distintos entre sí y del de la API', () => {
    const prod = { ...base, ...PRIVACY, NODE_ENV: 'production', STORAGE_DRIVER: 's3', SMS_PROVIDER: 'twilio', LOCAL_STORAGE_SECRET: 'p'.repeat(32) };
    expect(() => validateEnv(prod)).toThrow(/PLATFORM_JWT_SECRET/);
    expect(() => validateEnv({ ...prod, ...PLATFORM, PLATFORM_JWT_SECRET: base.JWT_ACCESS_SECRET })).toThrow(/distintas/);
    expect(() => validateEnv({ ...prod, ...PLATFORM })).not.toThrow();
    // En desarrollo son opcionales: sin ellas la consola responde 404.
    expect(validateEnv(base).PLATFORM_JWT_SECRET).toBeUndefined();
  });

  it('el segundo factor de la consola solo se apaga en desarrollo', () => {
    const prod = { ...base, ...PLATFORM, ...PRIVACY, NODE_ENV: 'production', STORAGE_DRIVER: 's3', SMS_PROVIDER: 'twilio', LOCAL_STORAGE_SECRET: 'p'.repeat(32) };
    expect(validateEnv(base).PLATFORM_TOTP_REQUIRED).toBe(true);
    expect(validateEnv({ ...base, PLATFORM_TOTP_REQUIRED: 'false' }).PLATFORM_TOTP_REQUIRED).toBe(false);
    expect(() => validateEnv({ ...prod, PLATFORM_TOTP_REQUIRED: 'false' })).toThrow(/PLATFORM_TOTP_REQUIRED/);
  });

  it('en producción exige el contacto de privacidad que se muestra al vecino (Ley 21.719)', () => {
    const prod = { ...base, ...PLATFORM, NODE_ENV: 'production', STORAGE_DRIVER: 's3', SMS_PROVIDER: 'twilio', LOCAL_STORAGE_SECRET: 'p'.repeat(32) };
    expect(() => validateEnv(prod)).toThrow(/PRIVACY_CONTACT_EMAIL/);
    expect(() => validateEnv({ ...prod, ...PRIVACY })).not.toThrow();
    expect(validateEnv(base).PRIVACY_CONTACT_EMAIL).toBeUndefined();
  });

  it('trata `VAR=` vacía (env_file) como no definida', () => {
    const env = validateEnv({ ...base, METRICS_TOKEN: '', S3_PUBLIC_ENDPOINT: '', LOG_LEVEL: '' });
    expect(env.METRICS_TOKEN).toBeUndefined();
    expect(env.S3_PUBLIC_ENDPOINT).toBeUndefined();
    expect(env.LOG_LEVEL).toBe('info');
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: '' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('exige un secreto JWT de 32+ caracteres', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'corto' })).toThrow(/JWT_ACCESS_SECRET/);
  });
});
