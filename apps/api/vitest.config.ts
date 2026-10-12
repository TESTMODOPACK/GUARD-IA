import { defineConfig } from 'vitest/config';

// `vitest run --mode db` (pnpm test:db) activa los tests contra base real; sin variables de shell
// para que funcione igual en Windows y en Linux.
export default defineConfig(({ mode }) => ({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: mode === 'db' ? { RUN_DB_TESTS: '1' } : {},
  },
}));
