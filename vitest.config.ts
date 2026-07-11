import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Next.js 16 ships no "exports" map, so bare `next/server` (used by
      // next-intl's middleware and our proxy) won't resolve under Vite's ESM
      // resolution. Pin it to the physical entry file.
      'next/server': fileURLToPath(new URL('./node_modules/next/server.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    server: {
      deps: {
        // Inline next-intl so the `next/server` alias above is applied to the
        // bare import inside its middleware (otherwise it's externalized and
        // fails to resolve under Next 16, which ships no "exports" map).
        inline: ['next-intl'],
      },
    },
  },
});
