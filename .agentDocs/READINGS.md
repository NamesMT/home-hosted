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

Two more things make a frame carry no reading, and both are decided in `hostReadings()` rather than
per surface:

- **`enabled: false`** — sampling was switched off, and the stamped sample the frame keeps is the
  *last* reading, not the current one. `HostMonitor` keeps it so a page can say how old it is; every
  reading is `null` regardless of the numbers still beside it.
- **A stale sample** — a sample older than three sampling intervals (a sampler that stopped
  returning) is published as the empty frame by `HostMonitor.view`, so readings stay absent until a
  fresh one lands rather than being repainted as the machine's state for an hour.

## A reading the platform could not take is named, not faked

`host.unmeasured?: ('load' | 'memory' | 'swap')[]` is how a sample says so. Windows has no load
average (`os.loadavg()` is a constant zero — not an idle box, no reading at all), macOS' `vm_stat` can
fail, and a swap read can come back empty. The wire value stays `0` for the older UI that calls
`.toFixed()` on it; `hostReadings()` drops it to `null`, `hostBreaches()` never fires a threshold
against it, and the scrape leaves it out. A surface that shows a number for a named-unmeasured reading
is showing a `0` it invented — which is the same defect as inventing one for an unsampled frame.

## A band names the threshold it was measured against

`host.<x>` is configurable, so a hardcoded band disagrees with the panel's own notification the
moment someone changes it. Each threshold travels on the frame as `<x>Alert` (optional, so a panel
that predates the field still parses), and a band predicate reads it:

- `thresholdBand` — **the one rule**: `danger` at the threshold, `warn` at 70% of it, `ok` under
  that. It bands the per-cpu load, memory, swap, temperature and each disk; they differ only in what
  the number means, and the mistake it replaced was four surfaces each deciding a band for itself. The
  load's threshold is a per-cpu count (`loadAlertPerCpu`) and the rest are percentages, which is a
  difference in the *value* handed in, not in the rule.
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

- `test/shared/host-readings.test.ts`, `test/shared/ui-readings.test.ts` — host readings in every
  render shape, followed into locals and their initializers (through `test/helpers/template-render.ts`).
- `test/shared/probe-band.test.ts` — `probeBand`, and no probe latency compared against a literal;
  the rendered half is `uis/noc-console/test/probe-tile-agrees.test.ts`.
- `test/shared/cpu-scale.test.ts` — no CPU capacity written by hand (`cpus * 100` in any order, or a
  `Math.max(100, ...)` floor).
- `test/shared/server-readings.test.ts`, `uis/noc-console/test/cpu-tile-agrees.test.ts`,
  `uis/noc-console/test/host-vitals-unsampled.test.ts`, `uis/noc-console/test/host-band-thresholds.test.ts`.
