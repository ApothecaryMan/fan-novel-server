import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist', '.wrangler'],
    // Boots a throwaway local cluster so the isolated PostgreSQL suite runs
    // instead of silently skipping. No-ops if PHASE1_PG_URL is already set.
    globalSetup: ['./src/test/pgGlobalSetup.ts'],
  },
});
