import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Carga .env desde la raíz del monorepo y desde apps/api (el segundo pisa al primero),
 * sin sobrescribir variables ya presentes en el entorno del proceso.
 */
export function loadEnvFiles(): void {
  // __dirname es apps/api/src/cli (tsx) o apps/api/dist/cli (compilado): misma profundidad.
  const candidates = [
    resolve(__dirname, '..', '..', '..', '..', '.env'), // raíz del monorepo
    resolve(__dirname, '..', '..', '.env'), // apps/api/.env
    join(process.cwd(), '.env'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, key, rawVal] = m;
      let val = rawVal;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
