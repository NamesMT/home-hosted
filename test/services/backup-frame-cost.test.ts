import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The per-frame path may not build the backup selection model.
 *
 * F54: `getState()` runs on every tick and on every request — ~13×/s with eight workspaces, because
 * each supervisor signals its own change and the tick coalesces only within one turn. It used to
 * call `BackupService.view()`, which read the global *and every workspace's* `.secrets.json` and
 * stat'd every archive, so the frame's cost scaled with workspaces × archives. Measured: 396
 * secrets reads in 8 s, 0.52 s of a 8 s window inside them.
 *
 * A body-level test can only see the route it asks, and a future author adding a field back to
 * `getState()` would break the cost without breaking any response assertion — so this pins the
 * call*, by reading the function bodies that run per frame.
 *
 * The scan matches a parsed call (`selection()` / `.entries(` / `.list(`) inside a named function
 * body rather than searching the file, because `backups.ts` legitimately contains all three.
 */
const root = path.resolve(import.meta.dirname, '..', '..')

/** The file's text, with CRLF normalised — a Windows checkout would otherwise break the boundaries. */
function source(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n')
}

/** The body of one top-level function, or of a class method (by its `name(` at two-space indent). */
function bodyOf(text: string, name: string): string {
  const asFunction = text.indexOf(`function ${name}(`)
  // A method may carry modifiers (`private publishState(`) or none, so match the name at column 2.
  const asMethod = text.search(new RegExp(`^  (?:private |public |protected )?${name}\\(`, 'm'))
  const method = asFunction === -1 ? asMethod : asFunction
  expect(method, `${name} not found — the scan is stale`).toBeGreaterThan(-1)

  const rest = text.slice(method)
  // The body ends at the next line that closes the function at column 0 (`}`), or the next `\n  }`
  // for a method — whichever comes first after the opening brace.
  const open = rest.indexOf('{')
  let depth = 0
  for (let i = open; i < rest.length; i++) {
    if (rest[i] === '{') {
      depth++
    }
    else if (rest[i] === '}') {
      depth--
      if (depth === 0)
        return rest.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced body for ${name}`)
}

describe('the frame builder never builds the backup selection model', () => {
  it('getState() does not call selection(), entries() or list()', () => {
    const text = source('src/services/panel.ts')
    for (const name of ['getState', 'publishState', 'stateSignature']) {
      const body = bodyOf(text, name)
      expect(body, `${name} must not build the backup selection model`).not.toMatch(/\.selection\(\)/)
      expect(body, `${name} must not read backup entries`).not.toMatch(/backups\.entries/)
      expect(body, `${name} must not stat the archive directory`).not.toMatch(/backups\.files/)
    }
  })

  it('backupService.view() returns the policy only', () => {
    const text = source('src/services/backups.ts')
    const body = bodyOf(text, 'view')
    // `view()` is what the frame calls; the selection model has to stay out of it.
    expect(body, 'view() must not read the workspace secrets files').not.toMatch(/this\.entries\(/)
    expect(body, 'view() must not stat every archive').not.toMatch(/this\.list\(/)
  })

  it('the dedicated selection() is where both halves live', () => {
    const body = bodyOf(source('src/services/backups.ts'), 'selection')
    expect(body).toMatch(/this\.entries\(/)
    expect(body).toMatch(/this\.list\(/)
  })
})
