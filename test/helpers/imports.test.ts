import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Node ESM refuses a *directory* import: `import '#src/providers/ddns'` resolves through
 * `"#src/*": "./src/*"` to a directory, and the specifier fails however tsx is invoked —
 * which broke the panel outright in the linked-checkout path `bin/home-hosted.mjs` documents,
 * whenever the process cwd was not the repository root. `up` spawned the daemon with
 * `cwd: projectDir`, so `home-hosted up` from anywhere else died with
 * "Directory import ... is not supported resolving ES modules".
 *
 * A bare `#src/<name>` is only safe when `<name>` is a *file*. Anything else needs its own
 * entry in `imports`, which is what this pins.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory())
        walk(full)
      else if (entry.name.endsWith('.ts'))
        found.push(full)
    }
  }
  walk(path.join(root, 'src'))
  return found
}

describe('#src import mappings', () => {
  it('never leaves a directory-targeting specifier without its own mapping', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { imports: Record<string, string> }
    const mapped = new Set(Object.keys(manifest.imports))
    const offenders: string[] = []

    for (const file of sourceFiles()) {
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/from '(#src\/[^']+)'/g)) {
        const specifier = match[1]!
        // Exact mappings (and anything with a file extension) resolve on their own.
        if (mapped.has(specifier) || /\.[a-z]+$/.test(specifier))
          continue
        const target = path.join(root, 'src', specifier.slice('#src/'.length))
        // A directory here is the bug: `fs.statSync` succeeds but the import cannot resolve.
        if (fs.existsSync(target) && fs.statSync(target).isDirectory())
          offenders.push(`${path.relative(root, file)} imports ${specifier}, which is a directory`)
      }
    }

    expect(offenders, 'a directory import needs its own `imports` entry pointing at index.ts').toEqual([])
  })

  it('points each exact mapping at a file that exists', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { imports: Record<string, string> }
    for (const [key, target] of Object.entries(manifest.imports)) {
      // The wildcard covers everything else; a missing target here is a typo.
      if (key.includes('*'))
        continue
      expect(fs.existsSync(path.join(root, target)), `${key} -> ${target} does not exist`).toBe(true)
      expect(fs.statSync(path.join(root, target)).isFile(), `${key} -> ${target} is not a file`).toBe(true)
    }
  })
})

/**
 * The brand's favicon reaches each UI through `uis/vite.shared.ts`, which serves and emits the
 * files from `docs/branding/` — so there is exactly one copy of each.
 *
 * A committed copy per UI is what this replaces: it was two files to keep in step with the brand
 * by hand, and nothing failed when they drifted. A symlink is not the alternative either — npm
 * drops symlinks from the tarball, and a Windows checkout with `core.symlinks=false` writes the
 * link target as text, so the UI would ship a file containing `../docs/branding/logo-mark.svg`.
 */
describe('the brand favicon has one source', () => {
  it('keeps no committed copy under a UI', () => {
    const uisDir = path.join(root, 'uis')
    const copies = fs.readdirSync(uisDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap((entry) => {
        const publicDir = path.join(uisDir, entry.name, 'public')
        if (!fs.existsSync(publicDir))
          return []
        return fs.readdirSync(publicDir, { withFileTypes: true })
          .filter(file => /^favicon\.(?:ico|svg)$/.test(file.name))
          .map(file => `uis/${entry.name}/public/${file.name}`)
      })

    expect(copies, 'the favicon is emitted from docs/branding/, not committed per UI').toEqual([])
  })

  it('emits exactly the files the brand directory holds', () => {
    const shared = fs.readFileSync(path.join(root, 'uis', 'vite.shared.ts'), 'utf8')
    for (const name of ['favicon.ico', 'favicon.svg'])
      expect(shared, `${name} must be served/emitted by the shared config`).toContain(name)

    // Each emitted name must map to a source that is really there, or the build fails late.
    for (const source of ['favicon.ico', 'logo-mark.svg'])
      expect(fs.existsSync(path.join(root, 'docs', 'branding', source)), `docs/branding/${source}`).toBe(true)
  })
})
