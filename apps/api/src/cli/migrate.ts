/**
 * pnpm migrate  (node dist/cli/migrate.js en producción)
 * Usa DATABASE_ADMIN_URL (dueño) y fija la contraseña de guardia_app tomada de DATABASE_URL.
 */
import { join } from 'node:path';
import { loadEnvFiles } from './load-env';
import { migrate } from '../db/migrator';

async function main() {
  loadEnvFiles();
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('Falta DATABASE_ADMIN_URL');
  if (!appUrl) throw new Error('Falta DATABASE_URL');
  const appPassword = decodeURIComponent(new URL(appUrl).password);
  const applied = await migrate({
    adminUrl,
    appPassword: appPassword || undefined,
    migrationsDir: join(__dirname, '..', 'db', 'migrations'),
    log: (m) => console.log(`[migrate] ${m}`),
  });
  console.log(applied.length ? `[migrate] aplicadas: ${applied.join(', ')}` : '[migrate] sin cambios');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
