import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Both UIs read a process's numbers through one predicate.
 *
 * `responseMs` and `resources` are one run's measurements. The panel drops them when a process
 * ends, but a newer UI is served against an older panel, and an *adopted* entry's stop used to keep
 * them — measured as a stopped card printing `Probe 2 Ms / RSS 64.2 MB / Procs 1`. The gate has to
 * be in the client, because the client cannot assume the panel got there.
 *
 * A fix in one call site would leave the next one open, and these components have no mount that
 * would notice a raw field read. So this derives the rule from the sources: the shared predicate is
 * the only place the fields are read for display, and every surface that shows one imports it.
 */
describe('the UIs read a process’s numbers through one predicate', () => {
  const ui = (name: string, rel: string): string =>
    fs.readFileSync(path.join(root, 'uis', name, 'src', rel), 'utf8')

  /**
   * Every surface that displays one of the measurements, with the file it lives in and the name
   * that file uses for the frame. The name is declared rather than guessed: `value` in the stock
   * detail view is still the *server*, and a rule that cannot tell it from the predicate's result
   * would either miss that file or flag a correct call site.
   */
  const surfaces: Array<{ ui: string, file: string, frame: string }> = [
    { ui: 'stock', file: 'components/server/ServerCard.vue', frame: 'server' },
    { ui: 'stock', file: 'views/ServerDetailView.vue', frame: 'value' },
    { ui: 'stock', file: 'lib/telemetry.ts', frame: 'server' },
    { ui: 'stock', file: 'views/OverviewView.vue', frame: 'server' },
    { ui: 'noc-console', file: 'components/ServerList.vue', frame: 'server' },
    { ui: 'noc-console', file: 'components/ServerDetail.vue', frame: 'props.server' },
    { ui: 'noc-console', file: 'views/GlobalOverviewView.vue', frame: 'server' },
    { ui: 'noc-console', file: 'composables/useControlPlane.ts', frame: 'server' },
  ]

  it('each reading surface imports the shared predicate', () => {
    const missing = surfaces
      .filter(surface => !ui(surface.ui, surface.file).includes('@shared/server-readings'))
      .map(surface => `uis/${surface.ui}/src/${surface.file}`)
    expect(missing, 'a surface showing a reading without the predicate is the defect this pins').toEqual([])
  })

  it('no surface reads the raw fields for display any more', () => {
    // The predicate itself is the one place allowed to touch them. `sampledAt` is exempt: it is the
    // sampler's own freshness key, not a displayed measurement, and the predicate does not expose it.
    // A read through `server.`/`props.server.`/`value.` is the shape that bypassed the gate.
    const offenders: string[] = []
    for (const surface of surfaces) {
      const source = ui(surface.ui, surface.file)
      // `sampledAt` is the sampler's freshness key, not a displayed measurement — the predicate
      // does not expose it, so the two readers that need it are allowed.
      const frame = surface.frame.replace('.', '\\.')
      const raw = [
        ...source.matchAll(new RegExp(`\\b${frame}\\.responseMs\\b`, 'g')),
        ...source.matchAll(new RegExp(`\\b${frame}\\.resources\\?\\.(?!sampledAt)\\w+`, 'g')),
      ]
      if (raw.length > 0)
        offenders.push(`uis/${surface.ui}/src/${surface.file}: ${raw.map(m => m[0]).join(', ')}`)
    }
    expect(offenders, 'a measurement read straight off the frame instead of the shared predicate').toEqual([])
  })

  it('the noc-console sampler stops writing a zero for an absent reading', () => {
    // `pushCapped(ring.cpu, server.resources?.cpuPercent ?? 0)` drew a stopped entry as a measured
    // idle one. A zero is what the chart cannot tell from a real reading.
    const source = ui('noc-console', 'composables/useControlPlane.ts')
    expect(source, 'the sampler must build its point from the predicate').toMatch(/const live = liveReadings\(server\)/)
    expect(source, 'a raw `resources?.cpuPercent ?? 0` here is the zero this pins').not.toMatch(/ring\.cpu, server\.resources\?\.cpuPercent/)
  })
})
