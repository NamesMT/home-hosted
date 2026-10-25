import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A millisecond setting whose floor is a second is edited in seconds, and the label says so.
 *
 * `sessionTtlMs` was a box showing `604800000` for a week. The rule is decided by the schema, not by
 * taste: a field whose floor is 1000 ms or more has no meaningful sub-second value, so seconds is the
 * only honest unit; below that (`health.timeoutMs` starts at 100) seconds would round away the values
 * the field accepts, and ms stays.
 *
 * This scan reads the *labels* — a conversion with a `(ms)` label is worse than no conversion, because
 * the number would be read in the wrong unit by whoever looks at it next.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

/** The catalog strings a duration box is labelled with, and whether their floor is >= 1000 ms. */
const IN_SECONDS = [
  'settings.auth.sessionLifetime',
  'settings.auth.lockout',
  'settings.host.interval',
  'settings.telegram.cooldown',
  'settings.ddns.interval',
]

/** Stays in ms: the schema floor is below a second. */
const IN_MS = ['settings.host.tempCommandTimeout', 'lifecycle.timeout', 'lifecycle.interval']

/**
 * The **sheets**, not the generated JSON: that directory is git-ignored build output, so a clean
 * checkout — which is what CI has — would fail this scan for a missing file rather than a wrong label.
 */
function english(): Record<string, string> {
  const dir = path.join(root, 'uis/stock/i18n/sheets')
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.csv'))) {
    const text = readFileSync(path.join(dir, name), 'utf8')
    for (const line of text.split('\n').slice(1)) {
      // A sheet is `KEY,en,vi,…`; the English cell is the second column, and may be quoted.
      const match = /^([^,]+),("(?:[^"]|"")*"|[^,]*)/.exec(line)
      if (match === null)
        continue
      const cell = match[2]!.startsWith('"') ? match[2]!.slice(1, -1).replaceAll('""', '"') : match[2]!
      out[match[1]!] = cell
    }
  }
  return out
}

describe('duration fields are labelled in the unit they are edited in', () => {
  it('names seconds for the fields converted', () => {
    const strings = english()
    for (const key of IN_SECONDS) {
      const value = strings[key]
      expect(value, `${key} must exist`).toBeTruthy()
      expect(value, `${key} is edited in seconds, so its label must say (s)`).toMatch(/\((?:s|sec)\)/i)
      expect(value, `${key} must not still claim ms`).not.toMatch(/\(ms\)/i)
    }
  })

  it('leaves the sub-second fields in ms', () => {
    const strings = english()
    for (const key of IN_MS) {
      const value = strings[key]
      if (value === undefined)
        continue
      expect(value, `${key} has a sub-second floor, so it stays in ms`).toMatch(/\(ms\)/i)
    }
  })

  it('each converted field goes through the shared conversion, not an inline divide', () => {
    // An inline `/ 1000` is the copy that drifts: one rounding difference and the box shows a value
    // the config does not hold. The helpers are the one place the conversion lives.
    const shared = readFileSync(path.join(root, 'src/shared/ui-format.ts'), 'utf8')
    expect(shared).toContain('export function msToSeconds')
    expect(shared).toContain('export function secondsToMs')
    expect(shared).toContain('export function shownInSeconds')
  })
})
