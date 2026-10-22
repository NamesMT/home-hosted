import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * `health`, `healthFailures` and `unhealthySince` are one fact and must move together.
 *
 * The streak describes one process's run: the failures since it began, and when that streak turned
 * unhealthy. They were written wherever a caller happened to remember, so a path that reset
 * `health` and kept `unhealthySince` reported `status=crashed health=unknown` beside a duration
 * that kept counting (`Unhealthy for 3m 17s` next to a `Not Probed` row, on the card and on the
 * detail page). The stop path had the same shape and was fixed alone in round 13; this round found
 * the exit paths behind it, which is why the fix is one helper (`setHealth`/`resetHealth`) rather
 * than a third field cleared in a third place.
 *
 * A unit test cannot see the *next* path that assigns the field directly, so this scans the
 * supervisor: the reset lives in the helper, and the only write allowed to start a streak is the
 * probe that measured one.
 */
describe('the supervisor writes health through one helper', () => {
  const source = fs.readFileSync(path.join(root, 'src/services/supervisor.ts'), 'utf8')
  const lines = source.split('\n')

  /** The lines of one method body, from its signature to the closing brace at method indentation. */
  function methodBody(name: string): string[] {
    const start = lines.findIndex(line => /^ {2}(?:private |async )*[\w$]+\(/.test(line) && line.includes(` ${name}(`))
    expect(start, `${name} must exist for this scan to guard anything`).toBeGreaterThan(-1)
    const end = lines.findIndex((line, index) => index > start && line === '  }')
    expect(end, `${name} must have a body`).toBeGreaterThan(start)
    return lines.slice(start, end + 1)
  }

  it('assigns entry.health nowhere but inside setHealth', () => {
    const writes = [...source.matchAll(/entry\.health = /g)].length
    expect(writes, 'exactly one assignment, in `setHealth`').toBe(1)
    expect(methodBody('setHealth').join('\n'), 'and it is the helper’s own line').toMatch(/^ {4}entry\.health = health$/m)
  })

  it('clears the streak only in setHealth, and starts one only in the probe', () => {
    // A `null`/`0` reset anywhere but the helper ends a streak without the health that describes it
    // — the defect. The probe's own `unhealthySince = now` starts one, which is the other direction.
    // Legitimate streak *starts*: the probe, and the readiness timeout that gave up waiting.
    const allowed = new Set(['setHealth', 'endHealthStreak', 'probeEntry', 'probeEntryHealth', 'awaitReadiness'])
    const methods = ['setHealth', 'endHealthStreak', 'resetHealth', 'probeEntry', 'probeEntryHealth', 'awaitReadiness', 'createEntry']
    const offenders: string[] = []
    for (const [index, line] of lines.entries()) {
      if (!/entry\.(?:unhealthySince|healthFailures) = /.test(line))
        continue
      const owner = methods.find(name => methodBody(name).includes(line))
      if (owner === undefined || !allowed.has(owner))
        offenders.push(`line ${index + 1} (${owner ?? 'unknown method'}): ${line.trim()}`)
    }
    expect(offenders, 'a health streak written without going through the helper').toEqual([])
  })
})
