import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROBE_DANGER_MS, PROBE_WARN_MS, probeBand } from '#src/shared/probe-latency'
import { stripComments } from '../helpers/strip-comments'

/**
 * A probe's latency is banded once, in `src/shared/probe-latency.ts`.
 *
 * `responseMs` was painted three times with two answers: noc-console's detail tile used
 * `toneClass(responseMs, 300, 1000)`, the sparkline under it kept its own copy of the same two
 * numbers, and the list row tested `>= 1000` alone — so `1500 ms` was `danger` in the pane and
 * `warn` in the row, and `500 ms` was `warn` in one and plain in the other.
 *
 * The component test (`uis/noc-console/test/probe-tile-agrees.test.ts`) drives both surfaces, which
 * is what catches a re-split inside them. This pins the predicate itself and scans every UI source
 * for a fourth copy in a file no surface test mounts.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('the probe latency band', () => {
  it('calls a slow probe dangerous, at the threshold and past it', () => {
    expect(probeBand(PROBE_DANGER_MS)).toBe('danger')
    expect(probeBand(PROBE_DANGER_MS + 800)).toBe('danger')
  })

  it('calls the band between the two thresholds a warning', () => {
    expect(probeBand(PROBE_WARN_MS)).toBe('warn')
    expect(probeBand(PROBE_DANGER_MS - 1)).toBe('warn')
    expect(probeBand(PROBE_WARN_MS - 1)).toBe('ok')
  })

  it('reports the fastest reading as ok, not as a fourth state', () => {
    expect(probeBand(0)).toBe('ok')
  })

  it('reports a probe that never ran as unknown, never as a healthy zero', () => {
    expect(probeBand(null)).toBe('unknown')
    expect(probeBand(undefined)).toBe('unknown')
    expect(probeBand(Number.NaN)).toBe('unknown')
  })
})

describe('the UIs read the probe band from one module', () => {
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
            // Only code is read: a docstring discusses `300`/`1000` by name.
            text: stripComments(fs.readFileSync(full, 'utf8'), entry.name),
          })
        }
      }
    }
    walk(path.join(root, 'uis'))
    return found
  }

  /**
   * A probe reading compared against a number written at the call site.
   *
   * A latency is not a percentage or a duration a person configured — `healthSchema` has no field
   * for it — so *any* literal on one side of a comparison is a second copy of the same two
   * thresholds. The reading arrives as `responseMs`, `liveReadings(…).responseMs` or a local the
   * tile derived from it, so the matcher reads the name, not a fixed expression.
   */
  const RESTATED_BAND = /responseMs\b[^;\n,]{0,24}?(?:>=?|<=?)\s*\d[\d_]*|\d[\d_]*\s*(?:>=?|<=?)\s*[^;\n,]{0,24}?responseMs\b/

  it('sees the shape it forbids, and leaves other comparisons alone', () => {
    const planted = [
      '(liveReadings(server).responseMs ?? 0) >= 1000',
      'responseMs.value >= 300',
      '1000 <= liveReadings(server).responseMs',
    ]
    for (const line of planted)
      expect(RESTATED_BAND.test(line), `the scan must see ${line}`).toBe(true)
    // A comparison against the shared constants keeps one home for the numbers; only a literal
    // restates them. Another reading's band is not a probe band.
    for (const line of ['responseMs < PROBE_WARN_MS', 'value >= PROBE_WARN_MS', 'liveReadings(server).cpuPercent >= 40'])
      expect(RESTATED_BAND.test(line), `this is not a restated probe band: ${line}`).toBe(false)
  })

  it('finds no second copy of the thresholds in any UI', () => {
    const offenders: string[] = []
    for (const source of sources()) {
      for (const match of source.text.matchAll(new RegExp(RESTATED_BAND.source, 'g')))
        offenders.push(`${source.rel}: ${match[0].trim()}`)
    }
    expect(offenders, 'a probe latency banded against a literal instead of probeBand').toEqual([])
  })
})
