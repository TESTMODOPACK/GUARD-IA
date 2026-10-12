import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
};

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

  it('exige un secreto JWT de 32+ caracteres', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'corto' })).toThrow(/JWT_ACCESS_SECRET/);
  });
});
