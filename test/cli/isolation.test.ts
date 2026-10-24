import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A test that calls a CLI *command* in-process must point `HHOSTED_HOME` at a temp directory
 * first, or it drives the developer's **live** panel.
 *
 * `#src/cli/*` commands act on whatever host `HHOSTED_HOME` resolves to: `runDown` shuts a
 * panel down and, with `--with-persistent`, signals the nannies it finds. Measured by doing
 * exactly that — an in-process `runDown({ withPersistent: true })` reached the real panel on
 * this machine and stopped its running `dsh` and gitea entries.
 *
 * The safe shapes already used in this suite:
 * - `spawn` the CLI with its own `HHOSTED_HOME` (`test/cli/*.test.ts`), or
 * - assign `process.env.HHOSTED_HOME` to a temp dir before importing, then `vi.resetModules()`
 *   so the path helpers resolve against it (`test/cli/logs.test.ts`).
 *
 * Importing a pure helper from a command module is fine — `toUpFlags` parses its argument and
 * `exitCodeForStops` reads only what it is given — so those are named here rather than the
 * whole module being off-limits.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The command modules that act on this host, mapped to the symbols a test may still take from
 * them without isolating the state directory: parsers and formatters, which read only their
 * argument. Everything else in these modules resolves `$HHOSTED_HOME` and reaches a real panel.
 */
const PURE_SYMBOLS: Record<string, Set<string>> = {
  'down': new Set(['persistentLabel', 'exitCodeForStops']),
  'restart': new Set(),
  'up': new Set(['buildDaemonArgv', 'toUpFlags']),
  'server': new Set(),
  'status': new Set(),
  'logs': new Set(),
  'backup': new Set(),
  'migrate': new Set(),
  'init': new Set(),
  'nanny': new Set(),
  'set-password': new Set(),
  'set-token': new Set(),
}

/** Modules that are pure by construction, so nothing in them is a host action. */
const ALWAYS_PURE = new Set(['io', 'nearest', 'args', 'backup-offline'])

/** Every `import … from '#src/cli/<command>'` in a file, with the symbols it takes. */
function cliImports(text: string): Array<{ specifier: string, symbols: string[] }> {
  const found: Array<{ specifier: string, symbols: string[] }> = []
  const named = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'#src\/cli\/([^']+)'/g
  for (const match of text.matchAll(named)) {
    const symbols = match[1]!.split(',').map(part => part.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean)
    found.push({ specifier: `#src/cli/${match[2]}`, symbols })
  }
  // A dynamic `await import('#src/cli/<command>')` followed by destructuring is the other shape
  // (`const { runLogs } = await import(...)`); its symbols are read from the assignment.
  const dynamic = /const\s+\{([^}]+)\}\s*=\s*await\s+import\('(#src\/cli\/[^']+)'\)/g
  for (const match of text.matchAll(dynamic)) {
    const symbols = match[1]!.split(',').map(part => part.trim().split(':')[0]!.trim()).filter(Boolean)
    found.push({ specifier: match[2]!, symbols })
  }
  return found
}

function testFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory())
        walk(full)
      else if (entry.name.endsWith('.test.ts'))
        found.push(full)
    }
  }
  walk(path.join(root, 'test'))
  return found
}

describe('a CLI command is only called in-process against an isolated home', () => {
  it('requires HHOSTED_HOME in any test that imports a state-touching command symbol', () => {
    const offenders: string[] = []

    for (const file of testFiles()) {
      const text = fs.readFileSync(file, 'utf8')
      const touching = cliImports(text)
        .filter((entry) => {
          const module = entry.specifier.replace('#src/cli/', '')
          if (ALWAYS_PURE.has(module))
            return false
          const pure = PURE_SYMBOLS[module]
          // An unknown command module is treated as state-touching: a new one defaults to safe.
          if (pure === undefined)
            return true
          return entry.symbols.some(symbol => !pure.has(symbol))
        })

      if (touching.length === 0)
        continue
      // An assignment anywhere in the file is what keeps the module off the real host.
      if (/process\.env\.HHOSTED_HOME\s*=/.test(text))
        continue
      offenders.push(`${path.relative(root, file)} imports ${touching.map(entry => `${entry.specifier} { ${entry.symbols.join(', ')} }`).join(', ')}`)
    }

    expect(offenders, 'set process.env.HHOSTED_HOME to a temp dir before importing, then vi.resetModules()').toEqual([])
  })
})
