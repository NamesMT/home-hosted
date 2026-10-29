import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cpuBand, cpuCapacity } from '#src/shared/cpu-scale'

/**
 * A server's `cpuPercent` is a share of **this machine**, and one rule decides it.
 *
 * The process tree is summed across cores, so four busy cores on a 24-core box read `400` — a real
 * reading, not an error. So the chart's ceiling, the sparkline's colour and the number's colour are
 * all `cpus × 100`, never `100`.
 *
 * The rule was correct in three places and stale in a fourth: `ServerDetail`'s **chart** scaled with
 * `cpus × 100` while the **number beside it** still used the fixed `40`/`80` per-core bands. On a
 * 24-core host it painted `1000%` red while the sparkline in the same tile stayed on `--accent`, and
 * the list row one click away agreed with the sparkline. That is the drift a fourth copy of
 * `Math.max(100, (cpus ?? 1) * 100)` produces, so there is now one function and this pins it.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('the cpu scale', () => {
  it('is the whole machine, so four busy cores are not the top of the chart', () => {
    expect(cpuCapacity(24)).toBe(2400)
    expect(cpuCapacity(1)).toBe(100)
  })

  it('never shrinks below one core, however the core count reads', () => {
    // A missing host frame must not divide by zero, and a nonsense zero must not clamp every value.
    expect(cpuCapacity(0)).toBe(100)
    expect(cpuCapacity(null)).toBe(100)
    expect(cpuCapacity(undefined)).toBe(100)
  })

  it('bands a value as a share of that capacity', () => {
    // A sixth of a 24-core box is normal work, not an emergency.
    expect(cpuBand(400, 24)).toBe('ok')
    expect(cpuBand(1000, 24)).toBe('warn')
    expect(cpuBand(2000, 24)).toBe('danger')
    // On a single core the same thresholds are the per-core bands the number always used.
    expect(cpuBand(40, 1)).toBe('warn')
    expect(cpuBand(80, 1)).toBe('danger')
    expect(cpuBand(39, 1)).toBe('ok')
    expect(cpuBand(2400, 24)).toBe('danger')
  })

  it('reports an absent reading as unknown, never as a healthy zero', () => {
    expect(cpuBand(null, 24)).toBe('unknown')
    expect(cpuBand(Number.NaN, 24)).toBe('unknown')
  })
})

/**
 * The scan for the class: a UI may not restate the rule.
 *
 * A test of the helper cannot see a fourth copy written beside it — that is exactly how the number's
 * band went stale — so this reads every UI source for the capacity expression and for a cpu value
 * compared against a literal band. The module is the one home; a call site imports it.
 */
describe('the UIs read the cpu scale from one module', () => {
  const sources = (): Array<{ rel: string, text: string }> => {
    const found: Array<{ rel: string, text: string }> = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist')
            continue
          walk(full)
        }
        else if (/\.(?:ts|vue)$/.test(entry.name)) {
          found.push({
            rel: path.relative(root, full).replaceAll('\\', '/'),
            // Comments discuss the expression by name, so only code is read.
            text: fs.readFileSync(full, 'utf8')
              .replaceAll(/\/\*[\s\S]*?\*\//g, '')
              .replaceAll(/^\s*\/\/.*$/gm, ''),
          })
        }
      }
    }
    for (const ui of ['stock', 'noc-console'])
      walk(path.join(root, 'uis', ui, 'src'))
    return found
  }

  it('finds the UI sources, so a broken walk cannot pass for free', () => {
    const rels = sources().map(source => source.rel)
    expect(rels).toContain('uis/stock/src/components/server/ServerCard.vue')
    expect(rels).toContain('uis/noc-console/src/components/ServerDetail.vue')
  })

  it('declares no second copy of the capacity', () => {
    const offenders = sources()
      .filter(source => /Math\.max\(\s*100\s*,/.test(source.text))
      .map(source => source.rel)
    expect(offenders, 'a UI recalculating the machine capacity instead of importing cpuCapacity').toEqual([])
  })

  /**
   * The stale shape, matched by **shape** rather than by spelling.
   *
   * The defect was `toneClass(cpuPercent, 40, 80)`. A scan for that exact string would pass the
   * moment someone renamed the helper — the trap `ui-readings.test.ts` already paid for — so this
   * matches any cpu-named value followed by two bare literals, however it is called. The plant below
   * proves the matcher still reaches the shape it claims to read.
   */
  const PER_CORE_BAND = /\w*cpu\w*\.?\(?\s*,\s*\d{1,3}\s*,\s*\d{1,4}\b/gi

  it('still reaches the shape it forbids, so the matcher cannot silently rot', () => {
    const planted = ['toneClass(cpuPercent, 40, 80)', 'band(cpu, 40, 80)', 'cpuColor(cpuPercent, 80, 95)']
    for (const line of planted)
      expect([...line.matchAll(PER_CORE_BAND)].length, `the scan must see ${line}`).toBe(1)
    // And it leaves a reading that is not a cpu band alone.
    expect([...'toneClass(responseMs, 300, 1000)'.matchAll(PER_CORE_BAND)]).toHaveLength(0)
  })

  it('does not band a cpu reading against a per-core literal', () => {
    const offenders: string[] = []
    for (const source of sources()) {
      for (const match of source.text.matchAll(PER_CORE_BAND))
        offenders.push(`${source.rel}: ${match[0]}`)
    }
    expect(offenders, 'a cpu band measured against a fixed number, not the machine').toEqual([])
  })
})
