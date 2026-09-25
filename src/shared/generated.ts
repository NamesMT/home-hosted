/**
 * Names that only ever hold build output or installed dependencies — the things
 * a `.gitignore` almost always lists.
 *
 * A backup walks a declared data directory and copies whatever it finds; on a
 * project directory that is mostly `node_modules` and framework caches, which
 * bloats the archive with content nobody needs to restore. An entry with
 * `backupIgnoreGenerated` (on by default) skips these.
 *
 * Matching is by exact name, on any segment, at any depth: `dist/` and
 * `app/node_modules/` are generated, `distributed/` and `my-node_modules/` are
 * not.
 *
 * `.git` is deliberately absent however much a `.gitignore` would not list it:
 * a package manager can reinstall `node_modules`, but nobody can restore a
 * commit that was never pushed.
 */

/** Whole directories that are regenerated, never authored. */
export const GENERATED_DIRS: readonly string[] = [
  // Installed dependencies and package-manager stores.
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.yarn',
  '.pnpm',
  '.pnpm-store',
  '.npm',
  // Framework and bundler output.
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.output',
  '.vercel',
  '.netlify',
  '.angular',
  'dist',
  'build',
  'out',
  // Caches.
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vite',
  '.rollup.cache',
  '.swc',
  // Test and coverage output.
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  // Other language toolchains.
  'target',
  '.gradle',
  '.dart_tool',
]

/** One-off files worth skipping, by exact name. */
export const GENERATED_FILES: readonly string[] = [
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.eslintcache',
  '.stylelintcache',
  'npm-debug.log',
  'yarn-error.log',
  'pnpm-debug.log',
]

const DIR_NAME_SET = new Set(GENERATED_DIRS)
const FILE_NAME_SET = new Set(GENERATED_FILES)

/**
 * True when a path *relative to the declared root* looks generated. Accepts
 * either separator, so a `path.relative` result can be passed straight in.
 */
export function isGeneratedPath(relative: string): boolean {
  const segments = relative.split(/[\\/]+/).filter(segment => segment.length > 0 && segment !== '.')
  if (segments.length === 0)
    return false
  if (FILE_NAME_SET.has(segments[segments.length - 1]!))
    return true
  return segments.some(segment => DIR_NAME_SET.has(segment))
}
