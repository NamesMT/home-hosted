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
      // v8 only reports files a test actually imported, so without this the gate is
      // blind to whatever nothing imports — and a whole area can leave the suite
      // without the number moving at all. Measure every source file instead.
      include: ['src/**/*.ts'],
      exclude: [
        ...configDefaults.coverage.exclude!,
        'src/helpers/logger.ts',
        'src/index.ts',
        'scripts/**',
        // The SPA is covered by behaviour tests in uis/*/test/ instead.
        'uis/**',
        // Process boundaries: these run as their own process, never inside the test
        // runner, so in-process coverage cannot attribute anything to them. Their
        // behaviour is pinned by the spawned-process suites (`test/cli/cli-smoke.test.ts`
        // for the CLI surface, `test/services/nanny.test.ts` for the nanny), which is the
        // same reason `src/index.ts` is excluded above.
        'src/cli.ts',
        'src/cli/down.ts',
        'src/cli/init.ts',
        'src/cli/migrate.ts',
        'src/cli/nanny.ts',
        'src/cli/restart.ts',
        'src/cli/set-password.ts',
        'src/cli/set-token.ts',
        'src/cli/status.ts',
        'src/cli/ui-revert.ts',
        'src/cli/up.ts',
        'src/services/nanny.ts',
        // Best-effort browser launch: no return value and no assertion surface.
        'src/helpers/open.ts',
      ],
    },
  },
}) as ReturnType<typeof defineConfig>
