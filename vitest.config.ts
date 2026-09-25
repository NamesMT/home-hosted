import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  // The SPA's own aliases, so its modules are testable from `uis/stock/test/`:
  // pure logic directly, and a component with `// @vitest-environment happy-dom`
  // at the top of the file (the rest of the suite stays on node).
  plugins: [vue()],
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
      // A floor, not a target: it fails the run when a change quietly drops a whole
      // area (a route factory, a provider) out of the suite.
      thresholds: {
        statements: 75,
        branches: 63,
        functions: 80,
        lines: 75,
      },
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
