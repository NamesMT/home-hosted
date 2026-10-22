import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * A failed lifecycle call must show the panel's own sentence, never a status code.
 *
 * This API answers two error envelopes and both are real: a thrown `DetailedError` carries
 * `{ message, code, detail }`, while a **refusal** from start/stop/restart/free-port carries
 * `{ ok: false, error }`. The UIs' call sites read only `message`, so the second became
 * `request failed with 409` — on the one button a person presses when a server will not start.
 *
 * `failureMessage` is the single reader, and this is the scan that keeps the next call site from
 * skipping it. A unit test cannot see a *new* file that hand-rolls the ternary; a source rule can.
 */
describe('every UI reads a failed action through failureMessage', () => {
  /** Every `.ts`/`.vue` file under a UI's `src`, in POSIX form so the labels match on Windows. */
  function uiFiles(ui: string): Array<{ rel: string, body: string }> {
    const found: Array<{ rel: string, body: string }> = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist')
            continue
          walk(full)
        }
        else if (/\.(?:ts|vue)$/.test(entry.name)) {
          found.push({ rel: path.relative(root, full).replaceAll('\\', '/'), body: fs.readFileSync(full, 'utf8') })
        }
      }
    }
    walk(path.join(root, 'uis', ui, 'src'))
    return found
  }

  /**
   * The shape that was wrong: a fallback straight from `payload.message` to a status number.
   *
   * Matched on the *fallback*, not on the variable name — the next author will not call it `payload`.
   * `failureMessage(...)` never matches, because it does not spell the status template itself.
   */
  const HAND_ROLLED = /\.message\s*\?\?\s*`request failed with/u

  it('has no call site reading only `message`', () => {
    const offenders = ['stock', 'noc-console'].flatMap(ui =>
      uiFiles(ui).filter(file => HAND_ROLLED.test(file.body)).map(file => file.rel),
    )
    expect(offenders).toEqual([])
  })

  it('is what both UIs actually use for a lifecycle action', () => {
    // Anti-vacuity: the scan above passes trivially if the call sites simply stopped existing, or if
    // the shared reader were deleted. Both UIs must still route their action through it.
    for (const ui of ['stock', 'noc-console']) {
      const api = fs.readFileSync(path.join(root, 'uis', ui, 'src', 'lib', 'api.ts'), 'utf8')
      expect(api, `${ui} must import the shared reader`).toContain('failureMessage')
      const action = /export async function serverAction[\s\S]*?\n\}/.exec(api)?.[0] ?? ''
      expect(action, `${ui}'s serverAction must use the shared reader`).toContain('failureMessage(')
      // And the helper itself is one definition, in the shared client.
      expect(action, `${ui} must not re-implement it`).not.toContain('function failureMessage')
    }
  })
})
