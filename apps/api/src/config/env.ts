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
  /**
   * Refresh de operador: un turno + 1 h de margen. Se renueva mientras la central está abierta;
   * cerrada más de 13 h, pide login. El de 30 días (JWT_REFRESH_TTL_SECONDS) queda para el vecino.
   */
  JWT_OPERATOR_REFRESH_TTL_SECONDS: z.coerce.number().int().default(13 * 3600),

  /**
   * Consola de plataforma (0010). Secreto propio para sus JWT (distinto del de vecinos y operadores) y llave
   * para cifrar los secretos TOTP. Sin ellos, /v1/platform responde 404 (desarrollo); en producción son
   * obligatorios.
   */
  PLATFORM_JWT_SECRET: z.string().min(32).optional(),
  PLATFORM_ENCRYPTION_KEY: z.string().min(32).optional(),
  /** Access de la consola: 15 min. La sesión se cae tras 30 min sin uso o 8 h desde el ingreso. */
  PLATFORM_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(15 * 60),
  PLATFORM_SESSION_IDLE_SECONDS: z.coerce.number().int().min(300).max(24 * 3600).default(30 * 60),
  PLATFORM_SESSION_MAX_SECONDS: z.coerce.number().int().min(900).max(24 * 3600).default(8 * 3600),
  /** Nombre que muestra la app de autenticación junto al correo. */
  PLATFORM_TOTP_ISSUER: z.string().min(2).max(40).default('Guard-IA'),

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
  /**
   * Dirección pública del mismo bucket para las URLs firmadas que abre el navegador de la central.
   * Con MinIO en Docker, S3_ENDPOINT es interno (http://minio:9000) y el navegador no lo alcanza.
   */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
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
  /**
   * Servicio compatible con la API de OpenAI (vacío = OpenAI). Ej. Groq, con plan gratuito para
   * pruebas: https://api.groq.com/openai/v1 con OPENAI_STT_MODEL=whisper-large-v3-turbo.
   */
  OPENAI_BASE_URL: z.string().url().optional(),
  /**
   * Solo para modelos de razonamiento (gpt-oss, o-series, gpt-5): esfuerzo de razonamiento al
   * clasificar. "low" basta y deja tokens para el JSON. Vacío para modelos sin razonamiento.
   */
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
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
  // `VAR=` en un env_file llega como "": se trata como no definida (rige el default o "requerida").
  const defined = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(defined);
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
    if (env.STORAGE_DRIVER === 's3' && env.S3_ENDPOINT?.startsWith('http://') && !env.S3_PUBLIC_ENDPOINT) {
      problems.push('S3_ENDPOINT es interno (http): define S3_PUBLIC_ENDPOINT o la central no podrá abrir audio ni fotos');
    }
    if (!env.PLATFORM_JWT_SECRET || !env.PLATFORM_ENCRYPTION_KEY) {
      problems.push('PLATFORM_JWT_SECRET y PLATFORM_ENCRYPTION_KEY son obligatorias (consola de plataforma)');
    } else if (env.PLATFORM_JWT_SECRET === env.JWT_ACCESS_SECRET || env.PLATFORM_ENCRYPTION_KEY === env.PLATFORM_JWT_SECRET) {
      problems.push('PLATFORM_JWT_SECRET y PLATFORM_ENCRYPTION_KEY deben ser distintas entre sí y de JWT_ACCESS_SECRET');
    }
    if (problems.length) throw new Error(`Configuración inválida para producción:\n  - ${problems.join('\n  - ')}`);
  }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    // Degradación explícita: sin key no hay IA real, pero el SOS sigue funcionando.
    env = { ...env, AI_PROVIDER: 'mock' };
  }
  return env;
}

export const ENV = 'ENV' as const;
