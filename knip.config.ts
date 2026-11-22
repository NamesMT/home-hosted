import type { KnipConfig } from 'knip'

/**
 * Dead-code and unused-dependency detection for `pnpm knip`.
 *
 * **Every entry below is a verified false positive, not a suppressed real finding.** Each was checked by
 * reading the code and by grepping for real uses outside the file knip names; the reason is written
 * beside it so a later reader can re-verify instead of trusting.
 *
 * Not part of `quickcheck`: knip builds a whole module graph (tens of seconds) and its output needs a
 * human to sort. Run it after a refactor, not on every save.
 */
const config: KnipConfig = {
  // The CLI dispatches through lazy `import()`s in `src/cli.ts`, and citty command modules export
  // `*Args` objects that only `defineCommand` reads. Both look unused to a static graph.
  ignoreExportsUsedInFile: true,

  entry: [
    'scripts/*.mjs',
    'test/**/*.test.ts',
    'uis/*/src/main.ts',
    'uis/*/vite.config.ts',
    // Shared by both UIs, imported as `./vite.shared` from each vite config.
    'uis/vite.shared.ts',
    // Selected by `vitest --sinceLastRun`; never imported.
    'test/support/changed-since-commit.ts',
    // Run by `pnpm run brand`.
    'scripts/build-social-preview.mjs',
  ],

  project: ['src/**/*.ts', 'test/**/*.ts', 'uis/*/src/**/*.{ts,vue}'],

  // `tailwindcss` is reached by `@import 'tailwindcss'` in `uis/stock/src/styles.css`, which a static
  // import graph does not follow. `vue-tsc` is run as a binary from `scripts/typecheck-uis.mjs`, never
  // imported — a real dependency, just not a module one.
  ignoreDependencies: ['tailwindcss', 'vue-tsc'],

  /**
   * Re-export barrels, citty `*Args`, and module-level `ref`s read through a composable.
   *
   * Each UI's `src/lib/{fields,format,proxy}.ts` re-exports from `@shared/*` "so this UI's imports
   * stay local", which is their documented purpose — knip sees a re-export with no importer in the
   * same graph and calls every name in it unused. Verified by grep: `commaList` has 3 real uses
   * outside its barrel, `formatDateTimeIso` has 5, `routesEqual` has 2.
   *
   * `uis/noc-console/src/composables/useUi.ts` exports `filter`, `drawerOpen` and `keyPrefix` as
   * module-level refs; `App.vue` and `ServersView.vue` read them through `useUi()`, which knip cannot
   * see into.
   */
  ignoreIssues: {
    'uis/noc-console/src/lib/fields.ts': ['exports', 'types'],
    'uis/noc-console/src/lib/format.ts': ['exports', 'types'],
    'uis/noc-console/src/lib/proxy.ts': ['exports', 'types'],
    'uis/stock/src/lib/fields.ts': ['exports'],
    'uis/noc-console/src/lib/api.ts': ['types'],
    'uis/noc-console/src/composables/useUi.ts': ['exports'],
    'uis/noc-console/src/composables/useControlPlane.ts': ['exports', 'types'],
    'uis/stock/src/composables/useControlPlane.ts': ['exports', 'types'],
    'uis/stock/src/lib/login-redirect.ts': ['types'],
    // `ResolvedServersFile` is the return type of a public store method; callers name the shape.
    'src/config/store.ts': ['types'],
    // `requestIp` is re-exported here and imported from `#src/middleware/loopback` by `api/auth`.
    'src/middleware/auth.ts': ['exports'],
    // citty `*Args`, read by `defineCommand`, and the prompt helper they share.
    'src/cli/secret.ts': ['exports'],
    'src/cli/io.ts': ['exports'],
    // Test helpers reached only through a template string or a dynamic path.
    'test/helpers/stock-copy.ts': ['exports'],
    'test/support/capabilities.ts': ['exports'],
    'test/support/uis.ts': ['exports'],
  },
}

export default config
