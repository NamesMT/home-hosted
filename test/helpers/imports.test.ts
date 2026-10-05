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
