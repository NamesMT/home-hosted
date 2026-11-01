# Readings — one home per number

**Goal:** why a reading's absence, band, scale and aggregate are each decided once.
**Scope:** `src/shared/host-readings.ts`, `src/shared/server-readings.ts`, `src/shared/cpu-scale.ts`,
`src/shared/probe-latency.ts` and the surfaces that render them. The rules are in `AGENTS.md`; this is the reasoning.

## A reading's absence is decided where it is rendered, not on the wire

`emptyHostView()` is the frame a panel boots with and the one it keeps for ever with sampling off:
`sampledAt: null` with every value `0`, because the wire type says `number`. `/api/metrics` refuses
those zeros — a scrape has no page to qualify a number — and the pages printed them.

The wire fields stay `number`: an overridden UI under `.hh/.ui` calls `.toFixed()` on them, so a
nullable field would crash it. `hostReadings()` therefore decides `sampled: false` → every reading
`null`, and a surface renders that.

`cpus` and `uptimeMs` are **not** readings — they describe the machine, and the empty frame reports
them truthfully.

## A band names the threshold it was measured against

`host.<x>` is configurable, so a hardcoded band disagrees with the panel's own notification the
moment someone changes it. Each threshold travels on the frame as `<x>Alert` (optional, so a panel
that predates the field still parses), and a band predicate reads it:

- `loadBand` — a per-cpu count. `danger` at the threshold, `warn` at 70% of it.
- `percentageBand` — memory, swap, temperature: the same rule.
- `hostReadings` puts a `band` on **each disk**, not one beside the frame: the reading is per path.
- `hostCpuBand` — the host's CPU share has no configurable alert, so the band is a fixed constant.
  It was written twice (70/90 and 80/95), and two copies of a *fixed* number cannot be caught by
  raising a config.
- `probeBand` — the same shape for a health probe's latency. `healthSchema` has no latency field,
  so `300`/`1000` is fixed too, and it was painted three ways: the detail tile's number via
  `toneClass(responseMs, 300, 1000)`, the sparkline under it via a `probeColor()` holding its own
  copy of the same pair, and the list row's `>= 1000` alone. A `1500 ms` reading was `danger` in the
  pane and `warn` in the row; a probe that never ran was `--ok`, because the sparkline read
  `responseMs ?? 0`.

`0` disables an alert in `sampleHost`, so nothing can breach it and the band is `ok`. A panel that
sends no threshold gets `HOST_ALERT_DEFAULTS`, which is what the older panel alerted on —
`hostSchema` writes its own defaults from that constant so the two cannot drift.

**A dial's scale is the same threshold.** There is no natural `100 °C`, so a temperature dial is drawn
full at the alert (`tempDialPercent`/`tempScale`). A colour assertion cannot see a wrong arc, which is
how one surface drew `113.10` where another drew `101.19`.

## A component default is a copy you cannot see

`Gauge`/`Meter` shipped `warnAt: 75, dangerAt: 90`, which read as "the component's business" rather
than a restated rule — and the disk alert was configured at 80. Both now *require* a `tone`, so a
call site cannot omit the verdict.

## An aggregate is a reading of the set

`sumReadings` answers `null` when any member has no reading. Summing with `?? 0` made a workspace
whose only server had just started print `0.0% cpu now` — the fabricated idle process, in the one
number that summarises every entry at once. An empty list is a genuine `0`, and so is a measured one.

## The scans that enforce this

`test/shared/host-readings.test.ts` and `test/shared/ui-readings.test.ts`, both reading templates
through `test/helpers/template-render.ts`:

- every `.vue` for `?? 0` on a host measurement, in **any** render shape (`{{ }}`, `:value`,
  `:display`, `v-text`) — reading only the interpolation missed a fabricated `0 °C` in a prop;
- a load or percentage compared against a literal, or a tone computed outside the predicate;
- a temperature divided, clamped or defaulted by a number;
- a host surface passing `warn-at`/`danger-at` to a dial;
- a reading followed into whatever local it was destructured or derived into, and that local's own
  initializer — a fallback inside a `computed` never appears in the template;
- `sumReadings` used for a total rather than a hand-rolled loop.

`test/shared/probe-band.test.ts` pins `probeBand` and scans every UI source for a probe latency
compared against a literal — the fourth copy, in a file no surface test mounts. The rendered half is
`uis/noc-console/test/probe-tile-agrees.test.ts`, which mounts the tile and the list row and reads the
class and stroke off both.

`test/shared/cpu-scale.test.ts` reads every UI source for a capacity written by hand. It carried the
same narrowing twice: the first matcher wanted *two* bare literals, because the copy it was written
for was `toneClass(cpuPercent, 40, 80)`, so `cpuBand(x, 100)` and `cpuCapacity(100)` were green. The
second read only a `Math.max(100, …)` floor, so the expression the original fix replaced —
`(cpus ?? 1) * 100` — was green again, in a `computed` and in a `:max` binding alike, which is the
one shape the module exists to forbid. A core count times `100` *is* the capacity, so one predicate
reads that, its commuted form, and the floor. A share of a fixed scale (`clamp((value / max) * 100)`)
and a `cpuCapacity(cpus)` call are outside it, and both were measured in the corpus before the
predicate was written.
