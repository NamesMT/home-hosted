import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | null = null

/**
 * The running release, read from the package manifest.
 *
 * The caller may be `src/**` under tsx or the built `dist/cli.js`, so the manifest
 * is found by walking up rather than by a fixed relative path. `src/cli.ts` keeps
 * its own read because it may only import node builtins statically.
 */
export function appVersion(): string {
  if (cached !== null)
    return cached

  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth++) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string, version?: string }
      if (manifest.name === 'home-hosted' && typeof manifest.version === 'string') {
        cached = manifest.version
        return cached
      }
    }
    catch {
      // no manifest here; keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir)
      break
    dir = parent
  }

  cached = '0.0.0'
  return cached
}
