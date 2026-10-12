import { z } from 'zod';

/**
 * Validación de entorno con zod. La app no arranca con una variable inválida:
 * es preferible fallar en el deploy que descubrirlo con una alerta real.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** Origen permitido para CORS y Socket.io (la central). Separar varios con coma. */
  CORS_ORIGINS: z.string().default('http://localhost:3001'),

  /** Conexión de la app: rol guardia_app, sujeto a RLS. */
  DATABASE_URL: z.string().url(),
  /** Conexión de migraciones y seed: dueño de las tablas. No la usa la API en runtime. */
  DATABASE_ADMIN_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().default(30 * 24 * 3600),
  /** Sesiones de operador: 12 h (sección 11). */
  JWT_OPERATOR_ACCESS_TTL_SECONDS: z.coerce.number().int().default(12 * 3600),

  /** console | twilio */
  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  /** Expone GET /v1/dev/otp/:phone para el simulador. Nunca en producción. */
  OTP_DEBUG_ENDPOINT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** s3 | local. `local` guarda en disco y sirve por URL firmada HMAC (solo desarrollo). */
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('guardia-media'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOCAL_STORAGE_DIR: z.string().default('.storage'),
  /** Secreto para firmar URLs del driver local. */
  LOCAL_STORAGE_SECRET: z.string().min(16).default('dev-only-local-storage-secret'),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().default(5 * 60),
  /** URL pública de la API (para construir URLs del driver local y links). */
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),

  /** openai | mock. Si no hay OPENAI_API_KEY, se fuerza mock. */
  AI_PROVIDER: z.enum(['openai', 'mock']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_STT_MODEL: z.string().default('whisper-1'),
  OPENAI_CLASSIFY_MODEL: z.string().default('gpt-4o-mini'),
  AI_MAX_AUDIO_SECONDS: z.coerce.number().int().default(60),

  EXPO_PUSH_URL: z.string().url().default('https://exp.host/--/api/v2/push/send'),
  EXPO_ACCESS_TOKEN: z.string().optional(),

  /** Límites (sección 9 y 11). */
  RATE_OTP_PER_HOUR: z.coerce.number().int().default(3),
  RATE_OTP_PER_IP_PER_HOUR: z.coerce.number().int().default(10),
  RATE_OTP_VERIFY_PER_5MIN: z.coerce.number().int().default(10),
  RATE_LOGIN_PER_MINUTE: z.coerce.number().int().default(5),
  RATE_SOS_PER_10MIN: z.coerce.number().int().default(3),
  RATE_CIVIC_PER_DAY: z.coerce.number().int().default(10),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(10 * 1024 * 1024),
  /** Si se define, GET /v1/metrics exige `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().min(16).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Variables de entorno inválidas:\n${issues}`);
  }
  let env = parsed.data;
  // Las guardas de producción van primero: ninguna degradación puede saltárselas.
  if (env.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (env.OTP_DEBUG_ENDPOINT) problems.push('OTP_DEBUG_ENDPOINT no puede estar activo en producción');
    if (env.STORAGE_DRIVER === 'local') problems.push('STORAGE_DRIVER=local es solo para desarrollo');
    if (env.SMS_PROVIDER === 'console') problems.push('SMS_PROVIDER=console escribe los OTP en el log; usa twilio');
    if (env.LOCAL_STORAGE_SECRET.startsWith('dev-only')) problems.push('LOCAL_STORAGE_SECRET tiene el valor por defecto');
    if (problems.length) throw new Error(`Configuración inválida para producción:\n  - ${problems.join('\n  - ')}`);
  }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    // Degradación explícita: sin key no hay IA real, pero el SOS sigue funcionando.
    env = { ...env, AI_PROVIDER: 'mock' };
  }
  return env;
}

export const ENV = 'ENV' as const;
