import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Migrador mínimo: aplica apps/api/src/db/migrations/*.sql en orden, una vez cada uno,
 * dentro de una transacción, y lo registra en schema_migrations.
 * Se ejecuta con el rol dueño (DATABASE_ADMIN_URL), nunca con guardia_app.
 */
export interface MigrateOptions {
  adminUrl: string;
  /** Contraseña de guardia_app; se toma de DATABASE_URL si no se indica. */
  appPassword?: string;
  migrationsDir?: string;
  log?: (msg: string) => void;
}

export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const dir = opts.migrationsDir ?? join(__dirname, 'migrations');
  const sql = postgres(opts.adminUrl, { max: 1, onnotice: () => undefined });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const done = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), 'utf8');
      log(`aplicando ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }
    const appPassword = opts.appPassword;
    if (appPassword) {
      // ALTER ROLE no acepta parámetros: se arma con format('%L') dentro de la base.
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('guardia.app_password', ${appPassword}, true)`;
        await tx.unsafe(`DO $$ BEGIN
          EXECUTE format('ALTER ROLE guardia_app WITH PASSWORD %L', current_setting('guardia.app_password'));
        END $$`);
      });
    }
    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Deja la base vacía (solo tests). */
export async function dropAll(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO public;
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
