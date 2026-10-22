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
  // Split on either ending: a Windows checkout writes CRLF, and a `line === '  }'` comparison
  // against a line that still carries `\r` silently finds no method body at all.
  const lines = source.split(/\r?\n/)

  /**
   * The line range of one method body, from its signature to the closing brace at method indent.
   *
   * A **range**, not the lines, because two methods can contain byte-identical lines: the clears
   * `endProcessReadings` performs and the ones a bad call site would perform are the same text, so
   * deciding ownership with `.includes(line)` attributed the broken call site to the helper and the
   * scan passed against the defect (learned by breaking it).
   */
  function methodRange(name: string): { start: number, end: number } {
    const start = lines.findIndex(line => /^ {2}(?:private |async )*[\w$]+\(/.test(line) && line.includes(` ${name}(`))
    expect(start, `${name} must exist for this scan to guard anything`).toBeGreaterThan(-1)
    const end = lines.findIndex((line, index) => index > start && line === '  }')
    expect(end, `${name} must have a body`).toBeGreaterThan(start)
    return { start, end }
  }

  /** The lines of one method body. */
  function methodBody(name: string): string[] {
    const { start, end } = methodRange(name)
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

  /**
   * The *measurements* a process produced are the same kind of fact as its health.
   *
   * `pid`, `responseMs` and `resources` describe one run. The two exit paths dropped them; an
   * adopted entry has no exit event, so an explicit stop was the one path that detached the pid
   * and kept the numbers — measured as a stopped entry showing `Probe 2 Ms`, `RSS 64.2 MB`,
   * `Procs 1` beside `Status Stopped / Health Not Probed`, and publishing a real
   * `hh_server_cpu_percent` in the scrape. A third path added later would make the same mistake,
   * so this pins the rule rather than the three call sites.
   */
  it('drops a process’s measurements only in endProcessReadings', () => {
    const helper = methodBody('endProcessReadings').join('\n')
    for (const field of ['pid', 'responseMs', 'resources', 'adopted'])
      expect(helper, `endProcessReadings must clear ${field}`).toMatch(new RegExp(`^ {4}entry\\.${field} = `, 'm'))

    // Ownership is decided by **which method the line is in**, by line index. Comparing the text
    // passes against both the helper and a broken call site, because the lines are identical.
    // *Clearing* one of these is the rule. `entry.pid = child.pid` (a spawn) and `entry.pid = pid`
    // (an adoption) legitimately set the field, and `responseMs = probe.ms` is the measurement
    // itself — the failure mode is the `null`, on a path that forgot the process was gone.
    const helperRange = methodRange('endProcessReadings')
    const offenders: string[] = []
    for (const [index, line] of lines.entries()) {
      if (!/^ {4}entry\.(?:pid|adopted|responseMs|resources) = (?:null|false)$/.test(line))
        continue
      if (index < helperRange.start || index > helperRange.end)
        offenders.push(`line ${index + 1}: ${line.trim()}`)
    }
    expect(offenders, 'a reading cleared outside the helper is the defect this rule exists for').toEqual([])
  })
})
