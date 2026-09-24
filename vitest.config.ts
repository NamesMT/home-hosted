import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  // The SPA's own aliases, so its pure modules (forms, formatting, the API
  // client's parsing) are testable — `uis/stock/test/` — without mounting components.
  resolve: {
    alias: {
      '@': `${root}uis/stock/src`,
      '@shared': `${root}src/shared`,
    },
  },
  test: {
    // The supervisor suite drives real child processes and port probes.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      exclude: [
        ...configDefaults.coverage.exclude!,
        'src/helpers/logger.ts',
        'src/index.ts',
        'scripts/**',
        // The SPA is covered by behaviour tests in uis/*/test/ instead.
        'uis/**',
      ],
    },
  },
}) as ReturnType<typeof defineConfig>
