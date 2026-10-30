import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isGeometry, renderedExpressions } from '../helpers/template-render'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * A reading rendered with a zero fallback, whichever local it travelled through.
 *
 * `liveReadings(...)` is the predicate, and a file rarely puts its result straight on screen: it
 * holds it in a `computed`, then derives another `computed` from that one — `readings` →
 * `responseMs` in `ServerDetail.vue`. Each hop is a name the template renders, so the scan follows
 * the chain to a fixpoint. Only names a file bound *from the predicate* are followed, so a bare
 * `cpuPercent` that came from config, or a function parameter, is not swept in.
 */
function zeroReadings(script: string, template: string): string[] {
  const FIELDS = 'cpuPercent|rssBytes|responseMs|processes'
  // `const live = liveReadings(server)` — and any initializer may span lines, because the shape that
  // hid the real defect is a `computed` whose body is a block.
  const declarations = new Map<string, string>()
  for (const match of script.matchAll(/\bconst\s+(\w+)\s*=\s*/g)) {
    const from = match.index + match[0].length
    let depth = 0
    let index = from
    for (; index < script.length; index += 1) {
      const char = script[index]!
      if (char === '(' || char === '[' || char === '{')
        depth += 1
      else if (char === ')' || char === ']' || char === '}')
        depth -= 1
      else if (char === '\n' && depth <= 0)
        break
    }
    declarations.set(match[1]!, script.slice(from, index))
  }

  const locals = new Set<string>()
  for (const [name, init] of declarations) {
    // `sumReadings(...)` is the aggregate form of the same predicate: a total over several entries is
    // a reading of the set, so it inherits the set's absence.
    if (init.includes('liveReadings(') || init.includes('sumReadings('))
      locals.add(name)
  }
  for (const match of script.matchAll(/\{([^}]*)\}\s*=\s*liveReadings\(/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      // `cpuPercent: cpu` binds `cpu`; a bare `rssBytes` binds itself.
      const name = part.split(':').pop()?.trim()
      if (name !== undefined && /^\w+$/.test(name))
        locals.add(name)
    }
  }
  // The hops after it, until nothing new is derived: `responseMs = computed(() => readings.value.responseMs)`.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, init] of declarations) {
      if (locals.has(name))
        continue
      const fromReading = new RegExp(`\\.(?:${FIELDS})\\b`).test(init)
        && [...locals].some(local => new RegExp(`\\b${local}\\b`).test(init))
      if (fromReading) {
        locals.add(name)
        changed = true
      }
    }
  }

  const zero = /\?\?\s*0\b|\|\|\s*0\b/
  /**
   * Whether a reading reaches a zero fallback *here*, either straight in the rendered expression or
   * in the initializer of a local the expression renders.
   *
   * The second half is the shape this scan could not see. `OverviewView` summed a workspace's CPU in
   * a `computed` — `total += liveReadings(server).cpuPercent ?? 0` — and rendered `liveCpu.toFixed(1)`;
   * the fallback was in the script and the template held only a local's name, so a workspace whose
   * only server had just started printed a measured `0.0% cpu now`. A `?? 0` inside a `computed` is
   * the same number on screen as one in `{{ }}`, and this is the only place it is decided.
   */
  const zeroOnReading = (text: string): boolean => zero.test(text)
  const shapes = [
    // The predicate's own field, read at the call site.
    new RegExp(`liveReadings\\([^)]*\\)\\.(?:${FIELDS})`),
    /\bsumReadings\([^)]*\)/,
  ]
  const rendered = renderedExpressions(template).filter(expression => !isGeometry(expression))
  const offenders: string[] = []
  for (const expression of rendered) {
    const mentioned = [...locals].filter(local => new RegExp(`\\b${local}\\b`).test(expression.text))
    const reached = shapes.some(shape => shape.test(expression.text)) || mentioned.length > 0
    if (!reached)
      continue
    if (zeroOnReading(expression.text))
      offenders.push(expression.source)
    // The local's own initializer: the fallback the template cannot show.
    for (const local of mentioned) {
      if (zeroOnReading(declarations.get(local) ?? ''))
        offenders.push(`${local} = ${(declarations.get(local) ?? '').trim()}`)
    }
  }
  return offenders
}

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

  /**
   * The noc-console's charts keep an absent reading absent, all the way to the SVG.
   *
   * This test used to assert that the text `ring.cpu, server.resources?.cpuPercent` was absent.
   * The commit that introduced the predicate deleted that literal, so the assertion could not
   * fail again — a guard that looks like it runs and does not. The defect it was meant to catch
   * survived underneath: the sampler writes `live.cpuPercent ?? 0`, the ring is typed `number[]`,
   * and the renderer draws one vertex per index, so a stopped entry's CPU chart was a **flat line
   * on the floor** — 0% by eye, the exact value `AGENTS.md` forbids a surface to invent. So this
   * reads the shape rather than a spelling.
   */
  it('the noc-console sampler keeps an absent reading absent in its series', () => {
    const source = ui('noc-console', 'composables/useControlPlane.ts')
    expect(source, 'the sampler must build its point from the predicate').toMatch(/const live = liveReadings\(server\)/)

    // Every ring push, read from the source: the value must be the predicate's own field with no
    // fallback. `?? 0` is the coercion this exists for, and it is a shape, not one spelling.
    const pushes = [...source.matchAll(/pushCapped\(ring\.(\w+), (.*)\)$/gm)].map(match => ({
      ring: match[1]!,
      value: match[2]!.trim(),
    }))
    // Anti-vacuity: the sampler writes three points, so an empty match list cannot pass.
    expect(pushes.map(push => push.ring).sort()).toEqual(['cpu', 'probe', 'rss'])

    const coerced = pushes.filter(push => /\?\?\s*0\b|\|\|\s*0\b/.test(push.value))
    expect(coerced.map(push => `ring.${push.ring} <- ${push.value}`), 'a zero for an absent reading is a measured idle process').toEqual([])
    for (const push of pushes)
      expect(push.value, `ring.${push.ring} must carry the reading, not a re-read of the frame`).toMatch(/^live\.\w+$/)

    // And the ring type has to admit the absence, or the sampler could not keep it anyway.
    const iface = /export interface ServerSeries \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    expect(iface, 'the series type must be declared for this to guard anything').toContain('cpu')
    for (const field of ['cpu', 'rss', 'probe'])
      expect(iface, `ServerSeries.${field} must allow a null reading`).toMatch(new RegExp(`${field}: \\(number \\| null\\)\\[\\]`))
  })

  /**
   * The other half of the same rule: `liveReadings` returns `null` for an absent measurement, and
   * a surface that *renders* that null as `0` has undone the gate.
   *
   * `GlobalOverviewView` printed `{{ (liveReadings(server).cpuPercent ?? 0).toFixed(0) }}%`, so a
   * stopped entry read `0%` — exactly the "measured idle process" the predicate exists to prevent,
   * on the panel-wide table where a person scans many workspaces at once. The rule is written in
   * `AGENTS.md` ("never `?? 0`"), and the scan above watched for a raw *field* read, so a read
   * through the predicate followed by a zero fallback passed it.
   *
   * Every `.vue` under both UIs is read, not the `surfaces` list above: that list is a fixture that
   * rots, and the whole point is the surface nobody thought of yet.
   *
   * Only rendered text is checked. A `?? 0` in a *comparison* (`(… ?? 0) >= 1000` for a warning
   * tone) is a sentinel that means "no warning", not a number on screen, and flagging it would fail
   * working code.
   *
   * Reading only `liveReadings(...)`/`live.` in `{{ }}` was the same one-spelling matcher the host
   * guard had: a reading destructured into a local, or handed to a component, walked past it.
   * `:title="`probe ${responseMs ?? 0} ms`"` on a detail page stayed green, and that is the exact
   * `0 ms` this rule exists to forbid. Every local a predicate result lands in is collected from the
   * `<script>`, and every rendered expression is read — the shapes are shared with
   * `test/shared/host-readings.test.ts` so the two guards cannot drift apart again.
   */
  it('renders an absent reading as unknown, never as a zero', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist')
            continue
          walk(full)
        }
        else if (entry.name.endsWith('.vue')) {
          const source = fs.readFileSync(full, 'utf8')
          const start = source.indexOf('<template>')
          if (start < 0)
            continue
          const rel = path.relative(root, full).replaceAll('\\', '/')
          for (const hit of zeroReadings(source.slice(0, start), source.slice(start)))
            offenders.push(`${rel}: ${hit}`)
        }
      }
    }
    for (const name of ['stock', 'noc-console'])
      walk(path.join(root, 'uis', name, 'src'))

    // Anti-vacuity: the walk must see the templates, not an empty directory, and the matcher must
    // reach every shape a reading is rendered through.
    expect(fs.existsSync(path.join(root, 'uis', 'noc-console', 'src', 'views', 'GlobalOverviewView.vue'))).toBe(true)
    const direct = '{{ (liveReadings(server).cpuPercent ?? 0).toFixed(0) }}%'
    expect(zeroReadings('', direct), 'the reported text shape').toHaveLength(1)
    expect(zeroReadings('const live = liveReadings(server)', '{{ live.rssBytes ?? 0 }}'), 'the local a file already has').toHaveLength(1)
    expect(zeroReadings('const { responseMs } = liveReadings(server)', `:title="\`probe ${'$'}{responseMs ?? 0} ms\`"`), 'a destructured local handed to a component').toHaveLength(1)
    expect(zeroReadings('const { cpuPercent: cpu } = liveReadings(server)', '<b>{{ cpu ?? 0 }}</b>'), 'a renamed destructured local').toHaveLength(1)
    // The hop that hid the real file: the predicate's result lands in a computed, and the template
    // renders a second computed derived from it.
    expect(zeroReadings('const readings = computed(() => liveReadings(props.server))\nconst responseMs = computed(() => readings.value.responseMs)', `:title="\`probe ${'$'}{responseMs ?? 0} ms\`"`), 'a second computed derived from the predicate').toHaveLength(1)
    expect(zeroReadings('', '{{ cpuPercent === null ? \'—\' : cpuPercent }}'), 'a guarded read is the fix, not the defect').toHaveLength(0)
    // The aggregate shape, which the scan could not see: a workspace total rendered through a
    // `computed` that added a zero fallback in its *body*. The template holds only the local's name.
    expect(zeroReadings('const liveCpu = computed(() => {\n  let total = 0\n  for (const server of running.value)\n    total += liveReadings(server).cpuPercent ?? 0\n  return total\n})', '{{ liveCpu.toFixed(1) }}%'), 'a zero fallback inside the computed that builds a total').toHaveLength(1)
    expect(zeroReadings('const liveCpu = computed(() => sumReadings(running.value, \'cpuPercent\'))', '{{ liveCpu.toFixed(1) }}%'), 'the sum carries the absence, so the render is the fix').toHaveLength(0)
    // A zero that picks a colour or an empty bar is not a number a person reads.
    expect(zeroReadings('const { responseMs } = liveReadings(server)', ':class="{ warn: (responseMs ?? 0) >= 1000 }"'), 'a class is not text').toHaveLength(0)
    expect(offenders, 'an absent reading rendered as a zero reads as a measured idle process').toEqual([])
  })
})
