import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let cachedRoot: { dir: string, version: string } | null = null

/**
 * The package's own directory and release, found by walking up to the manifest named `home-hosted`.
 *
 * The caller may be `src/**` under tsx, `dist/cli.js`, or a code-split chunk under `dist/chunks/`,
 * so no fixed relative path is right for all of them; a nested manifest is not trusted.
 *
 * `src/cli.ts` reaches this through a **relative** import, not `#src/*`: the bootstrap may only pull
 * in modules that load node builtins statically.
 */
function findPackage(): { dir: string, version: string } {
  if (cachedRoot !== null)
    return cachedRoot
  const start = path.dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string, version?: string }
      if (manifest.name === 'home-hosted' && typeof manifest.version === 'string') {
        cachedRoot = { dir, version: manifest.version }
        return cachedRoot
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
  cachedRoot = { dir: path.dirname(start), version: '0.0.0' }
  return cachedRoot
}

/** The running release, read from the package manifest. */
export function appVersion(): string {
  return findPackage().version
}

/** Where the package is installed: the base for files it ships (`uis/stock/dist`). */
export function packageRoot(): string {
  return findPackage().dir
}

/**
 * The one line to add when this CLI and the panel it is talking to are not the same
 * release — which is what a linked checkout, a global install and a project pin
 * produce. `null` when they agree.
 */
export function versionMismatchNote(panelVersion: string): string | null {
  const cli = appVersion()
  return cli === panelVersion ? null : `note: this CLI is ${cli}, the panel is ${panelVersion}`
}
