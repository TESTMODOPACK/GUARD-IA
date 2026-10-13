/**
 * pnpm --filter @guardia/api platform:user --email persona@guard-ia.cl --name "Nombre Apellido" [--role SUPERADMIN]
 * (en el VPS: docker compose run --rm migrate node dist/cli/platform-user.js --email ... --name ...)
 *
 * Crea una cuenta de la consola de plataforma con contraseña temporal; el segundo factor se enrola en el
 * primer ingreso. Sirve para el primer superadministrador: los demás se crean desde la consola. Si el correo
 * ya existe, restablece esa cuenta (contraseña temporal nueva y segundo factor por enrolar de nuevo).
 * La contraseña se imprime una sola vez en esta terminal; entregarla por un canal seguro.
 */
import postgres from 'postgres';
import { PLATFORM_ROLES, type PlatformRole } from '@guardia/shared';
import { hashPassword, temporaryPassword } from '../admin/passwords';
import { loadEnvFiles } from './load-env';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadEnvFiles();
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('Falta DATABASE_ADMIN_URL');
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const role = (arg('role') ?? 'SUPERADMIN') as PlatformRole;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Indica --email válido');
  if (!name || name.length < 2) throw new Error('Indica --name');
  if (!PLATFORM_ROLES.includes(role)) throw new Error(`--role debe ser ${PLATFORM_ROLES.join(', ')}`);

  const temp = temporaryPassword();
  const passwordHash = await hashPassword(temp);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    const [u] = await sql<{ id: string; created: boolean }[]>`
      INSERT INTO platform_user (email, name, role, password_hash, must_change_password)
      VALUES (${email}, ${name}, ${role}::platform_role, ${passwordHash}, true)
      ON CONFLICT (email) DO UPDATE
        SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
            must_change_password = true, active = true, failed_attempts = 0, locked_until = NULL,
            totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL
      RETURNING id, (xmax = 0) AS created`;
    await sql`UPDATE platform_session SET revoked_at = now() WHERE user_id = ${u.id} AND revoked_at IS NULL`;
    await sql`
      INSERT INTO platform_audit_log (actor_id, action, target_id, payload)
      VALUES (NULL, ${u.created ? 'USER_CREATED' : 'USER_RESET'}::platform_action, ${u.id},
              ${sql.json({ email, role, via: 'cli' })})`;
    console.log(`[platform] ${u.created ? 'cuenta creada' : 'cuenta restablecida'}: ${email} (${role})`);
    console.log(`[platform] contraseña temporal (se muestra una vez): ${temp}`);
    console.log('[platform] al entrar a la consola se pide cambiarla y enrolar el segundo factor (TOTP).');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
