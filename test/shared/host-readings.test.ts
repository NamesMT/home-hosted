import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hostReadings } from '#src/shared/host-readings'

/**
 * A host frame with no sample has no readings, and the panel's own pages said otherwise.
 *
 * `emptyHostView()` — the frame a panel boots with, and the one it keeps for ever when host vitals
 * are switched off — carries `sampledAt: null` with every value `0`, because the wire type declares
 * them `number`. `/api/metrics` refuses to publish those zeros (`fix(metrics): publish the host CPU
 * share, and no reading where there is none`): a scrape has no page to qualify a number, and an
 * invented `0` silences the alert rule that exists to catch a full disk.
 *
 * The pages that exist to *show* the frame printed it: noc-console's vitals page read `0.0%`
 * memory, `0.0%` swap and `0.00` load under a green `quiet` chip, and its always-on rail read
 * `mem 0%` / `swap 0%`. On a homelab box an unsampled panel claiming 0% memory is the same lie as
 * a dashboard being told it — told to the person instead. The cpu and temperature tiles were
 * already gated; the other four were not, because the rule lived in one route and not in a shared
 * decision.
 *
 * The rule is `hostReadings`, and this pins both halves: the predicate, and the scan that keeps a
 * fifth surface from reading the frame directly.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

/** The all-zero, never-sampled frame, exactly as `emptyHostView()` builds it. */
const empty = {
  enabled: true,
  cpus: 8,
  loadAvg: [0, 0, 0],
  cpuUsedPercent: null,
  uptimeMs: 1000,
  memoryUsedPercent: 0,
  swapUsedPercent: 0,
  tempCelsius: null,
  disks: [],
  alerts: [],
  sampledAt: null,
}

describe('hostReadings', () => {
  it('reports no measurement for a frame that was never sampled', () => {
    expect(hostReadings(empty)).toEqual({
      sampled: false,
      cpuUsedPercent: null,
      memoryUsedPercent: null,
      swapUsedPercent: null,
      load1m: null,
      load5m: null,
      load15m: null,
      loadPerCpu: null,
      tempCelsius: null,
      disks: [],
    })
  })

  it('treats a missing frame the same way', () => {
    expect(hostReadings(null).memoryUsedPercent).toBeNull()
    expect(hostReadings(undefined).sampled).toBe(false)
  })

  it('keeps an honestly idle sample as the reading it is', () => {
    // The other direction matters as much: a sampled box with nothing running really does measure
    // 0%, and turning that into an absence would hide a working reading.
    const idle = { ...empty, sampledAt: 1, cpuUsedPercent: 0, tempCelsius: 41 }
    const readings = hostReadings(idle)
    expect(readings.sampled).toBe(true)
    expect(readings.memoryUsedPercent).toBe(0)
    expect(readings.swapUsedPercent).toBe(0)
    expect(readings.load1m).toBe(0)
    expect(readings.loadPerCpu).toBe(0)
    expect(readings.cpuUsedPercent).toBe(0)
    expect(readings.tempCelsius).toBe(41)
  })

  it('divides load by the machine, at one core when the count is nonsense', () => {
    const sampled = { ...empty, sampledAt: 1, loadAvg: [4, 3, 2], cpus: 8 }
    expect(hostReadings(sampled).loadPerCpu).toBe(0.5)
    expect(hostReadings({ ...sampled, cpus: 0 }).loadPerCpu).toBe(4)
  })

  it('keeps a disk list that came from a real sample, and none otherwise', () => {
    const disk = { path: '/', totalBytes: 100, freeBytes: 50, usedPercent: 50 }
    expect(hostReadings({ ...empty, sampledAt: 1, disks: [disk] }).disks).toEqual([disk])
    // A panel switched off after a sample still carries disks. They are a per-path measurement, so
    // they go with the rest when there is no sample behind them.
    expect(hostReadings({ ...empty, disks: [disk] }).disks).toEqual([])
  })
})

/**
 * A measurement field name, read off some frame — including through a nullable or reactive one:
 * `host.memoryUsedPercent`, `props.host.disks`, `view?.loadAvg`, `readings.tempCelsius`.
 *
 * The declared-frame scan below is what makes this a *frame* read rather than a name match; the
 * template scan is name-based on purpose, because the surface nobody declared yet is the whole
 * point of it.
 */
const MEASUREMENTS = 'cpuUsedPercent|memoryUsedPercent|swapUsedPercent|loadAvg|tempCelsius|disks'

function sourceOf(rel: string): string {
  // Comments name the fields to explain the rule, so only code is read.
  return fs.readFileSync(path.join(root, rel), 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/^\s*\/\/.*$/gm, '')
}

function vueFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist')
        continue
      vueFiles(full, found)
    }
    else if (entry.name.endsWith('.vue')) {
      found.push(path.relative(root, full).replaceAll('\\', '/'))
    }
  }
  return found
}

describe('the panel reads host measurements from one module', () => {
  /**
   * Every surface that displays the host frame, with the name that file uses for it. Declared
   * rather than guessed: the settings pages bind `form.host.memoryUsedPercent`, which is a
   * **threshold** (`HostConfig`), not a reading, and a scan that cannot tell the two apart would
   * either flag correct config code or miss a real read.
   */
  const surfaces: Array<{ file: string, frame: string }> = [
    { file: 'uis/noc-console/src/components/HostVitals.vue', frame: 'host' },
    { file: 'uis/noc-console/src/components/HostRail.vue', frame: 'view' },
    { file: 'uis/stock/src/components/host/HostVitalsPanel.vue', frame: 'props.host' },
    { file: 'uis/stock/src/components/shell/InstrumentCluster.vue', frame: 'props.host' },
    { file: 'src/api/metrics.ts', frame: 'deps.panel.getState().host' },
  ]

  it('each host surface imports the shared predicate', () => {
    const missing = surfaces
      .filter(surface => !sourceOf(surface.file).includes('@shared/host-readings') && !sourceOf(surface.file).includes('#src/shared/host-readings'))
      .map(surface => surface.file)
    expect(missing, 'a surface showing a host reading without the predicate is the defect this pins').toEqual([])
  })

  it('finds the surfaces, so a broken list cannot pass for free', () => {
    for (const surface of surfaces)
      expect(fs.existsSync(path.join(root, surface.file)), surface.file).toBe(true)
  })

  it('no surface reads a measurement straight off the frame', () => {
    const offenders: string[] = []
    for (const surface of surfaces) {
      const frame = surface.frame.replaceAll('.', '\\.').replaceAll('(', '\\(').replaceAll(')', '\\)')
      const raw = new RegExp(`\\b${frame}\\??\\.(?:${MEASUREMENTS})\\b`, 'g')
      for (const match of sourceOf(surface.file).matchAll(raw))
        offenders.push(`${surface.file}: ${match[0]}`)
    }
    expect(offenders, 'a host measurement read straight off the frame instead of from hostReadings').toEqual([])
  })

  /**
   * The render half, which is where the defect actually was: `(host?.memoryUsedPercent ?? 0)`.
   *
   * Every `.vue` under both UIs is read, not the declared list — the declared list is a fixture
   * that rots, and the surface nobody thought of yet is the one that matters. Only `{{ }}` text is
   * checked: a `?? 0` in a comparison chooses an empty bar, not a number on screen.
   */
  it('renders a host measurement with no zero fallback', () => {
    const offenders: string[] = []
    for (const ui of ['stock', 'noc-console']) {
      for (const rel of vueFiles(path.join(root, 'uis', ui, 'src'))) {
        const source = sourceOf(rel)
        const start = source.indexOf('<template>')
        if (start < 0)
          continue
        for (const text of source.slice(start).matchAll(/\{\{([\s\S]*?)\}\}/g)) {
          const expression = text[1] ?? ''
          if (!new RegExp(`\\b(?:${MEASUREMENTS})\\b`).test(expression))
            continue
          if (/\?\?\s*0\b|\|\|\s*0\b/.test(expression))
            offenders.push(`${rel}: {{ ${expression.trim()} }}`)
        }
      }
    }
    // Anti-vacuity: the walk must reach the templates, and the matcher must see the old shape.
    expect(vueFiles(path.join(root, 'uis', 'noc-console', 'src')).length).toBeGreaterThan(20)
    const planted = '{{ (host?.memoryUsedPercent ?? 0).toFixed(1) }}%'
    const expression = /\{\{([\s\S]*?)\}\}/.exec(planted)![1]!
    expect(new RegExp(`\\b(?:${MEASUREMENTS})\\b`).test(expression)).toBe(true)
    expect(/\?\?\s*0\b|\|\|\s*0\b/.test(expression)).toBe(true)
    expect(offenders, 'a host measurement rendered with a zero fallback reads as a measured idle machine').toEqual([])
  })
})
