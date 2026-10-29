import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hostSchema } from '#src/shared/contracts'
import { HOST_ALERT_DEFAULTS, hostReadings, LOAD_ALERT_PER_CPU_DEFAULT, tempDialPercent, tempScale } from '#src/shared/host-readings'

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
      loadBand: null,
      memoryBand: null,
      swapBand: null,
      tempBand: null,
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
    // The numbers survive as they were measured; the band is the one thing the predicate adds.
    expect(hostReadings({ ...empty, sampledAt: 1, disks: [disk] }).disks).toEqual([{ ...disk, band: 'ok' }])
    // A panel switched off after a sample still carries disks. They are a per-path measurement, so
    // they go with the rest when there is no sample behind them.
    expect(hostReadings({ ...empty, disks: [disk] }).disks).toEqual([])
  })

  /**
   * The load band is measured against the threshold the panel notifies on, never a literal.
   *
   * `HostVitals`' docstring claimed the bands "follow the configured alert threshold" while the body
   * compared against `2` and `1.4`, and `HostRail` carried the same pair. A person raising
   * `host.loadPerCpu` to 4 was notified at 4 and saw the tile paint `danger` at 2.5 — a verdict on a
   * threshold nobody configured. So the frame carries the threshold and this decides the band.
   */
  it('bands the load against the configured threshold, not a default', () => {
    const at = (load: number, threshold?: number) => hostReadings({
      ...empty,
      sampledAt: 1,
      cpus: 8,
      loadAvg: [load * 8, 0, 0],
      ...(threshold === undefined ? {} : { loadAlertPerCpu: threshold }),
    }).loadBand

    // A raised threshold leaves a normal box alone; the same reading at the default is a breach.
    expect(at(2.5, 4)).toBe('ok')
    expect(at(2.5, 2)).toBe('danger')
    // The edge itself is the number the alert fires at.
    expect(at(4, 4)).toBe('danger')
    // Warn is the approach to that number, and it moves with it.
    expect(at(2.9, 4)).toBe('warn')
    expect(at(1.4, 2)).toBe('warn')
  })

  it('has no band for an absent reading, and a plain ok for a switched-off alert', () => {
    // A zero on an unsampled frame is not a healthy load; it is no measurement at all.
    expect(hostReadings(empty).loadBand).toBeNull()
    // `0` disables the alert in `sampleHost`, so nothing can be a breach of it.
    expect(hostReadings({ ...empty, sampledAt: 1, loadAvg: [80, 0, 0], loadAlertPerCpu: 0 }).loadBand).toBe('ok')
  })

  it('keeps the default band for a panel that sends no threshold at all', () => {
    // An older panel predates the field and alerted on the default, so that is what it gets.
    const older = { ...empty, sampledAt: 1, cpus: 8, loadAvg: [16, 0, 0] }
    expect(LOAD_ALERT_PER_CPU_DEFAULT).toBe(2)
    expect(hostReadings(older).loadBand).toBe('danger')
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

/**
 * The band for a per-cpu load has one home too.
 *
 * Both noc-console surfaces hardcoded `2` and `1.4` — the schema's *default* — while the docstring
 * above one of them claimed the bands "follow the configured alert threshold". Raising
 * `host.loadPerCpu` to 4 made the tile paint a normal box `danger` for a notification that could
 * never fire. A scan for the helper's name would pass the moment someone renamed it, so this pins
 * both halves: no surface compares a load against a literal, and each surface that paints a load
 * tone takes its band from the predicate.
 *
 * A `loadRatio ?? 0` feeding a *bar width* is not this defect — it picks an empty bar, not a colour
 * — so only comparisons are matched, the same distinction the template scan above draws.
 */
describe('the UIs band the load against the configured threshold', () => {
  /** A load-named value compared with a numeric literal, on one line. */
  const LOAD_COMPARISON = /\bload[\w$]*(?:\.[\w$]+)?\s*(?:>=|<=|>|<)\s*\d+(?:\.\d+)?/gi

  it('still reaches the shape it forbids, so the matcher cannot silently rot', () => {
    // The rail's one-liner, exactly as it was written.
    expect([...'loadRatio.value >= 2'.matchAll(LOAD_COMPARISON)].map(m => m[0])).toEqual(['loadRatio.value >= 2'])
    // And the tile's alias, through the frame it came from.
    expect([...'readings.value.loadPerCpu >= 1.4'.matchAll(LOAD_COMPARISON)].map(m => m[0])).toEqual(['loadPerCpu >= 1.4'])
    // A correct call site is left alone — the helper takes the threshold, it does not compare.
    expect([...'loadBand(loadPerCpu, host.loadAlertPerCpu)'.matchAll(LOAD_COMPARISON)]).toHaveLength(0)
  })

  it('does not compare a per-cpu load against a literal', () => {
    const offenders: string[] = []
    for (const ui of ['stock', 'noc-console']) {
      for (const rel of vueFiles(path.join(root, 'uis', ui, 'src'))) {
        for (const match of sourceOf(rel).matchAll(LOAD_COMPARISON))
          offenders.push(`${rel}: ${match[0].trim()}`)
      }
    }
    expect(offenders, 'a load band measured against a number nobody configured').toEqual([])
  })

  /** The two surfaces that paint a load tone, and the frame each names the reading after. */
  const banded: Array<{ file: string, reading: string }> = [
    { file: 'uis/noc-console/src/components/HostVitals.vue', reading: 'readings' },
    { file: 'uis/noc-console/src/components/HostRail.vue', reading: 'readings' },
  ]

  it('takes each load tone from the predicate, so a renamed helper cannot hide a copy', () => {
    const missing = banded
      .filter(surface => !new RegExp(`\\b${surface.reading}\\.value\\.loadBand\\b`).test(sourceOf(surface.file)))
      .map(surface => surface.file)
    expect(missing, 'a load tone computed beside the predicate instead of from it').toEqual([])
  })
})

/**
 * The three percentage bands have the same one home as the load's.
 *
 * They kept literals after the load was fixed, and the literals disagreed with the alerts the panel
 * sends: `hostSchema` defaults the swap alert to **50** while `HostRail` painted 52% `warn`, and
 * `HostVitals` painted the same `warn` up to 80. A `tempCelsius` raised to 95 left a 90 °C box
 * `danger`. Those thresholds now travel on the frame (`swapUsedPercentAlert` and friends) and
 * `percentageBand` decides each band, so this pins the same two halves the load guard pins: no
 * surface compares these readings against a literal, and each takes its tone from the predicate.
 */
describe('the UIs band the percentages against the configured thresholds', () => {
  /** A percentage reading compared with a literal that could be one of its thresholds. */
  const PERCENT_COMPARISON = /\b(?:memoryUsedPercent|swapUsedPercent|tempCelsius)\s*(?:>=|<=|>|<)\s*\d+(?:\.\d+)?/g

  it('still reaches the shape it forbids', () => {
    // The rail's three one-liners, exactly as they were written.
    expect([...'band(readings.value.swapUsedPercent, 50, 80)'.matchAll(PERCENT_COMPARISON)]).toHaveLength(0)
    expect([...'readings.value.swapUsedPercent >= 80'.matchAll(PERCENT_COMPARISON)].map(m => m[0])).toEqual(['swapUsedPercent >= 80'])
    expect([...'readings.value.tempCelsius >= 85'.matchAll(PERCENT_COMPARISON)].map(m => m[0])).toEqual(['tempCelsius >= 85'])
    // The helper's call site compares nothing, so it must stay clean.
    expect([...'percentageBand(present(host.swapUsedPercent), host.swapUsedPercentAlert, HOST_ALERT_DEFAULTS.swapUsedPercent)'.matchAll(PERCENT_COMPARISON)]).toHaveLength(0)
  })

  it('does not compare a percentage reading against a literal', () => {
    const offenders: string[] = []
    for (const ui of ['stock', 'noc-console']) {
      for (const rel of vueFiles(path.join(root, 'uis', ui, 'src'))) {
        for (const match of sourceOf(rel).matchAll(PERCENT_COMPARISON))
          offenders.push(`${rel}: ${match[0].trim()}`)
      }
    }
    expect(offenders, 'a band measured against a number nobody configured').toEqual([])
  })

  it('takes each percentage tone from the predicate', () => {
    const rail = sourceOf('uis/noc-console/src/components/HostRail.vue')
    for (const band of ['memoryBand', 'swapBand', 'tempBand'])
      expect(rail, `the rail must read ${band}`).toContain(`readings.value.${band}`)
    expect(sourceOf('uis/noc-console/src/components/HostVitals.vue'), 'the swap bar must read its band').toContain('readings.swapBand')
  })

  /**
   * The frame has to carry them, or a surface could not follow one it is never given.
   *
   * Counted, not merely found: `sampleHost` and `emptyHostView` both build a frame, and a scan that
   * only asked "does the file mention it" passed after the sampled builder lost the field — the
   * boot frame still had it. Measured by deleting the three lines from `sampleHost` and watching
   * this stay green before the count was added.
   */
  it('carries every threshold on the frame, from both builders', () => {
    const provider = sourceOf('src/providers/host.ts')
    for (const field of ['memoryUsedPercentAlert', 'swapUsedPercentAlert', 'tempCelsiusAlert'])
      expect([...provider.matchAll(new RegExp(`\\b${field}: config\\.`, 'g'))], `${field} in both frame builders`).toHaveLength(2)
  })
})

/**
 * The disk band is the same rule, and it is the reading the last fix missed.
 *
 * The load and the three percentages each got a predicate; the disk bar kept `band(percent, 75, 90)`
 * in `HostRail`/`HostVitals` and the stock `Gauge`/`Meter` defaults. Those are the schema's *default*
 * (`hostSchema` ships `diskUsedPercent: 90`), so the copy is invisible on a fresh config and wrong
 * on any other: with `host.diskUsedPercent` at **80**, `sampleHost` notifies at 82% and every
 * surface painted it `warn` — the panel contradicting its own warning on the one reading where a
 * late warning costs a full filesystem.
 *
 * The threshold had never travelled on the frame, so no surface *could* have followed it. It rides
 * beside the other three now, and each disk carries its own band from the predicate.
 */
describe('a disk is banded against the threshold the panel notifies on', () => {
  const disk = (usedPercent: number) => ({ path: '/srv', totalBytes: 100, freeBytes: 100 - usedPercent, usedPercent })

  it('bands each disk against the configured alert, not the schema default', () => {
    // 82% against a threshold a person lowered to 80 is a breach — the alert fires there.
    expect(hostReadings({ ...empty, sampledAt: 1, diskUsedPercentAlert: 80, disks: [disk(82)] }).disks[0]!.band).toBe('danger')
    // The same reading at the shipped default of 90 is only the approach to it.
    expect(hostReadings({ ...empty, sampledAt: 1, disks: [disk(82)] }).disks[0]!.band).toBe('warn')
    // The edge itself is where the panel notifies.
    expect(hostReadings({ ...empty, sampledAt: 1, diskUsedPercentAlert: 80, disks: [disk(80)] }).disks[0]!.band).toBe('danger')
  })

  it('keeps the default band for a panel that sends no disk threshold', () => {
    // An older panel alerted on the schema default, which is what its surfaces banded against.
    expect(hostReadings({ ...empty, sampledAt: 1, disks: [disk(95)] }).disks[0]!.band).toBe('danger')
  })

  it('has no band, and no disks, where nothing was measured', () => {
    // A zero on an unsampled frame is not an empty filesystem.
    expect(hostReadings({ ...empty, disks: [disk(99)] }).disks).toEqual([])
  })

  it('paints nothing alarming for a disk alert switched off', () => {
    // `0` disables the alert in `sampleHost`, so there is no threshold to cross.
    expect(hostReadings({ ...empty, sampledAt: 1, diskUsedPercentAlert: 0, disks: [disk(99.9)] }).disks[0]!.band).toBe('ok')
  })
})

/**
 * The scan for the class: no UI may band a disk against a literal.
 *
 * A test of the helper cannot see a fourth copy written beside it — that is how the disk bar
 * survived while its three neighbours were fixed. Two shapes produced it: a `usedPercent` compared
 * against a number (`HostVitals`' `diskTone`), and a `band(value, 75, 90)` restatement (`HostRail`).
 * Both are read here; a surface that reads the predicate's `disk.band` matches neither.
 */
describe('the UIs band a disk from the predicate', () => {
  /**
   * The three bodies that restated the pair, matched by **shape** rather than by a helper's name.
   *
   * A scan for `diskTone` would pass the moment someone renamed it — the trap `ui-readings.test.ts`
   * already paid for — and would also flag a correct computed of that name. What is forbidden is a
   * disk reading *compared against a number*: the reading itself, a disk-named local helper that
   * bands its own parameter, and a band call handed a percentage plus two literals.
   */
  const DISK_LITERAL = new RegExp([
    // `disk.usedPercent >= 90`
    String.raw`\busedPercent\s*(?:>=|<=|>|<)\s*\d+(?:\.\d+)?`,
    // `function diskTone(percent: number) { if (percent >= 90) … }`
    String.raw`function\s+disk\w*\s*\(\s*(\w+)\s*:[^)]*\)[^{]*\{[^}]*\b\1\s*(?:>=|<=|>|<)\s*\d+`,
    // `band(percent, 75, 90)` — the `i` flag already covers the spelling.
    String.raw`\b(?:band|tone\w*)\(\s*[\w.$]*percent\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)`,
  ].join('|'), 'gi')

  it('still reaches the shape it forbids, so the matcher cannot silently rot', () => {
    // Both bodies exactly as they were written, and the call the rail's helper made.
    expect([...'disk.usedPercent >= 90'.matchAll(DISK_LITERAL)].map(m => m[0])).toEqual(['usedPercent >= 90'])
    expect([...'function diskTone(percent: number): \'ok\' { if (percent >= 90) return \'danger\' }'.matchAll(DISK_LITERAL)]).toHaveLength(1)
    expect([...'return band(percent, 75, 90)'.matchAll(DISK_LITERAL)]).toHaveLength(1)
    // A correct call site is left alone: it reads the band, and formats a number.
    expect([...'disk.usedPercent.toFixed(1)'.matchAll(DISK_LITERAL)]).toHaveLength(0)
    expect([...'disk.band ?? \'ok\''.matchAll(DISK_LITERAL)]).toHaveLength(0)
    // And the successor that reads the predicate's bands is not a restatement.
    expect([...'const diskTone = computed<Tone>(() => bands.includes(\'danger\') ? \'danger\' : \'ok\')'.matchAll(DISK_LITERAL)]).toHaveLength(0)
  })

  it('bands no disk reading against a number nobody configured', () => {
    const offenders: string[] = []
    for (const ui of ['stock', 'noc-console']) {
      for (const rel of vueFiles(path.join(root, 'uis', ui, 'src'))) {
        for (const match of sourceOf(rel).matchAll(DISK_LITERAL))
          offenders.push(`${rel}: ${match[0].trim()}`)
      }
    }
    expect(offenders, 'a disk band measured against a literal instead of the configured alert').toEqual([])
  })

  it('takes each disk tone from the predicate', () => {
    // The four surfaces that paint a disk, and what each must read.
    const surfaces: Array<[string, string]> = [
      ['uis/noc-console/src/components/HostRail.vue', 'disk.band'],
      ['uis/noc-console/src/components/HostVitals.vue', 'disk.band'],
      ['uis/stock/src/components/host/HostVitalsPanel.vue', 'disk.band'],
      ['uis/stock/src/components/shell/InstrumentCluster.vue', 'disk.band'],
    ]
    for (const [file, needle] of surfaces)
      expect(sourceOf(file), `${file} must read the band the predicate decided`).toContain(needle)
  })

  it('carries the disk threshold on the frame, from both builders', () => {
    const provider = sourceOf('src/providers/host.ts')
    // Counted, not merely found: a scan that only asked "is it mentioned" passed after the sampled
    // builder lost a field, because the boot frame still carried it.
    expect([...provider.matchAll(/\bdiskUsedPercentAlert: config\./g)], 'diskUsedPercentAlert in both frame builders').toHaveLength(2)
  })
})

/**
 * How full a temperature dial is: a share of the threshold the panel notifies on.
 *
 * The band for a temperature was moved onto the frame, and the **scale** was left behind. There is
 * no natural `100 °C`, so a dial's full scale is the alert — and one surface scaled by the frame's
 * `tempCelsiusAlert` while the other divided by the literal `85`, `hostSchema`'s default. On one
 * frame at 60 °C with the alert raised to 95 the two stock surfaces drew arcs of `101.19` and
 * `113.10`, and noc-console's rail sized its bar by the °C value as though it were a percentage.
 * Neither is a colour, so the tone tests that pinned the bands could not see either one.
 */
describe('a temperature dial is scaled by the alert the panel notifies on', () => {
  it('takes that threshold as its full scale', () => {
    expect(tempScale(95)).toBe(95)
    // Half the threshold is half the dial, and the threshold itself is a full one.
    expect(tempDialPercent(47.5, 95)).toBe(50)
    expect(tempDialPercent(95, 95)).toBe(100)
  })

  it('keeps the default scale for a panel that sends no threshold', () => {
    expect(tempScale(undefined)).toBe(HOST_ALERT_DEFAULTS.tempCelsius)
    expect(tempDialPercent(42.5, undefined)).toBe(50)
  })

  it('keeps a scale where the alert is switched off, rather than dividing by zero', () => {
    // `0` disables the alert and leaves no scale of its own.
    expect(tempScale(0)).toBe(HOST_ALERT_DEFAULTS.tempCelsius)
    expect(tempDialPercent(42.5, 0)).toBe(50)
  })

  it('has no dial where nothing was measured', () => {
    expect(tempDialPercent(null, 95)).toBeNull()
  })
})

/**
 * The scan for the class: a UI may not decide a temperature's scale for itself.
 *
 * Two shapes produced the defect — a reading divided by a number (`(tempCelsius / 85) * 100`), and
 * a °C value used as if it were a percentage (`clamp(tempCelsius, 0, 100)` sizing the rail's bar,
 * which is a 0–100 °C scale and not a share of anything). The predicate's successors match neither.
 */
describe('the UIs do not restate a temperature scale', () => {
  const TEMP_SCALE = new RegExp([
    // `(readings.tempCelsius / 85) * 100`
    String.raw`\btempCelsius\s*\/\s*\d+(?:\.\d+)?`,
    // `clamp(readings.tempCelsius, 0, 100)` — a bar sized by degrees.
    String.raw`\bclamp\(\s*[\w.]*tempCelsius\s*,`,
    // `const TEMP_FULL = 85`, and `props.host?.tempCelsiusAlert ?? 85`.
    String.raw`\bTEMP_FULL\s*=\s*\d+`,
    String.raw`\btempCelsiusAlert\s*\?\?\s*\d+`,
  ].join('|'), 'gi')

  it('still reaches the shape it forbids, so the matcher cannot silently rot', () => {
    // Both bodies exactly as they were written before the fix.
    expect([...'(readings.tempCelsius / 85) * 100'.matchAll(TEMP_SCALE)].map(m => m[0])).toEqual(['tempCelsius / 85'])
    expect([...'clamp(readings.tempCelsius, 0, 100)'.matchAll(TEMP_SCALE)]).toHaveLength(1)
    expect([...'const TEMP_FULL = 85'.matchAll(TEMP_SCALE)]).toHaveLength(1)
    expect([...'props.host?.tempCelsiusAlert ?? 85'.matchAll(TEMP_SCALE)]).toHaveLength(1)
    // The predicate's successor is not a restatement.
    expect([...'tempDialPercent(readings.value.tempCelsius, props.host?.tempCelsiusAlert)'.matchAll(TEMP_SCALE)]).toHaveLength(0)
  })

  it('scales no temperature against a number nobody configured', () => {
    const offenders: string[] = []
    for (const ui of ['stock', 'noc-console']) {
      for (const rel of vueFiles(path.join(root, 'uis', ui, 'src'))) {
        for (const match of sourceOf(rel).matchAll(TEMP_SCALE))
          offenders.push(`${rel}: ${match[0].trim()}`)
      }
    }
    expect(offenders, 'a temperature dial scaled by a literal instead of the configured alert').toEqual([])
  })

  it('takes every temperature dial from the predicate', () => {
    // The three surfaces that draw one: the stock card, the stock rail, and noc-console's rail.
    const surfaces = [
      'uis/stock/src/components/host/HostVitalsPanel.vue',
      'uis/stock/src/components/shell/InstrumentCluster.vue',
      'uis/noc-console/src/components/HostRail.vue',
    ]
    for (const file of surfaces)
      expect(sourceOf(file), `${file} must scale its temperature dial from the predicate`).toContain('tempDialPercent')
  })
})

/**
 * The fallback band and the default a fresh config gets are one number.
 *
 * `HOST_ALERT_DEFAULTS` is what a surface bands against when the frame carries no threshold — a
 * panel older than the field — and it has to equal what that older panel actually alerted on, which
 * is `hostSchema`'s own default. Two constants would have been a copy a reader cannot see: raise
 * `host.tempCelsius`'s default and the fallback band keeps drawing the old one, for a panel that
 * now notifies elsewhere. `hostSchema` is the source of truth (it is what `migrate` and the settings
 * form read), so this compares against a parsed empty config rather than restating the numbers.
 */
describe('the fallback bands are the schema defaults', () => {
  it('matches the config a fresh install gets', () => {
    const defaults = hostSchema({}) as typeof hostSchema.infer
    expect(defaults.diskUsedPercent).toBe(HOST_ALERT_DEFAULTS.diskUsedPercent)
    expect(defaults.memoryUsedPercent).toBe(HOST_ALERT_DEFAULTS.memoryUsedPercent)
    expect(defaults.swapUsedPercent).toBe(HOST_ALERT_DEFAULTS.swapUsedPercent)
    expect(defaults.tempCelsius).toBe(HOST_ALERT_DEFAULTS.tempCelsius)
  })

  /** And the schema reads them from the constant, so one edit moves both. */
  it('takes its own defaults from the constant, not a second copy', () => {
    const source = sourceOf('src/shared/contracts.ts')
    for (const key of ['diskUsedPercent', 'memoryUsedPercent', 'swapUsedPercent', 'tempCelsius'])
      expect(source, `hostSchema must write ${key}'s default from the constant`).toContain(`= \${HOST_ALERT_DEFAULTS.${key}}`)
  })
})

/**
 * A dial's `warn-at`/`danger-at` pair is a copy of a band, so no host surface may pass one.
 *
 * `host.cpuUsedPercent` has no configurable alert, so every host dial's band comes from a predicate
 * here instead — and the literal pairs had already diverged (70/90 in one UI, 80/95 in the other)
 * before anything noticed. `Gauge` keeps its own defaults for non-host callers; on a host surface the
 * band is decided once.
 */
describe('no host surface passes a literal band to a dial', () => {
  const HOST_SURFACES = [
    'uis/stock/src/components/host/HostVitalsPanel.vue',
    'uis/stock/src/components/shell/InstrumentCluster.vue',
    'uis/noc-console/src/components/HostVitals.vue',
    'uis/noc-console/src/components/HostRail.vue',
  ]

  it('finds the surfaces it checks', () => {
    for (const file of HOST_SURFACES)
      expect(sourceOf(file).length, `${file} must be readable`).toBeGreaterThan(200)
  })

  it('passes no warn-at or danger-at on a host dial', () => {
    const offenders = HOST_SURFACES
      .filter(file => /:(?:warn-at|danger-at)=/.test(sourceOf(file)))
    expect(offenders, 'a band restated at the call site instead of taken from the predicate').toEqual([])
  })
})

/**
 * A dial takes a verdict, not a pair of thresholds to work one out from.
 *
 * `Gauge`/`Meter` shipped `warnAt`/`dangerAt` defaults of `75`/`90`, and that fallback is exactly how
 * a band gets copied: the disk alert was configured at 80 while the component's default still said
 * 75/90, and the bar read `warn` where the panel notified. Once every surface was moved onto its own
 * band the pair was unreachable — a default nothing can hit, still reading like the authority on
 * where a dial changes colour. `tone` is required now, so a call site cannot omit the verdict.
 */
describe('a telemetry dial takes its verdict from the caller', () => {
  it('declares no threshold pair to fall back to', () => {
    for (const file of ['uis/stock/src/components/telemetry/Gauge.vue', 'uis/stock/src/components/telemetry/Meter.vue']) {
      const source = sourceOf(file)
      expect(source, `${file} must not declare warnAt`).not.toMatch(/^\s*warnAt\??:/m)
      expect(source, `${file} must not declare dangerAt`).not.toMatch(/^\s*dangerAt\??:/m)
      expect(source, `${file} must require a tone`).toMatch(/^\s*tone: Tone/m)
    }
  })

  it('has no call site passing one', () => {
    const offenders: string[] = []
    for (const ui of ['stock', 'noc-console']) {
      for (const rel of vueFiles(path.join(root, 'uis', ui, 'src'))) {
        if (/:(?:warn-at|danger-at)=/.test(sourceOf(rel)))
          offenders.push(rel)
      }
    }
    expect(offenders, 'a threshold pair at a call site is a band restated, and the component cannot compute it').toEqual([])
  })
})
