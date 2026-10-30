# AGENTS.md

`home-hosted` is a Node 24 / TypeScript harness for self-hosted servers: `up` starts a Hono/srvx panel
(default `127.0.0.1:3999`) that supervises the entries in each workspace's `servers.config.json` and
serves a UI. Package manager: pnpm. User docs: `README.md` and `docs/`.

State lives only in `$HHOSTED_HOME/.hh` (default `~/.home-hosted/.hh`). Global files sit at its top
level: `settings.json` (listener, auth, TLS policy, host vitals, backups, reverse proxy),
`workspaces.json`, `.control-secrets.json` (0600: password hash, API token hash), `.tls/`, `.backups/`,
`.ui/`, `.logs/` (the panel console), `.proxy/` (the engine, its generated config and nanny state), and
`run.json` (the live daemon's pid/url/token, 0600).

Every workspace owns `.hh/<id>/`: `settings.json` (server defaults, log retention, notifications,
DDNS), `servers.config.json`, `.secrets.json` (0600: Telegram bot tokens, one per destination, plus
DDNS credentials sealed with AES-256-GCM under `HHOSTED_DDNS_SECRET` — only DDNS is sealed, because it
is the one thing replayed to a third party), `.logs/` (per server, `<id>.log` plus `<id>.log.1` when it
rotates), and `.state/` (nanny state, its 0600 spawn spec until read, `<id>.run.json` — the last
detached child, which is how an orphan is found, and `ddns.json`).

A home still on the 0.6.x layout is **refused** by `ensureLayout()`, which names the file and tells the
person to install the latest 0.7.x; 0.8.0 does not relocate it. **The package ships no servers**: never
commit a config, a seed entry, or a path that names one.

## Docs

Where knowledge lives, and when to reach for each:

| tier | what it holds | when you use it |
| --- | --- | --- |
| `AGENTS.md` — this file | orientation and the rules that prevent defects | read every session; write when a rule is learned the hard way |
| `.agentDocs/` | depth: module rationale, traps with their causes, compatibility | read on demand, before touching that area; write when a rule needs its reasoning kept |
| `docs/` | how-to and reference for a person using this package | read when the task is user-facing; write in the same commit as the change |
| `README.md` | the first read, for a person | write alongside `docs/` |

- **One home per fact.** State the rule here, keep the reasoning in `.agentDocs/` and link it — never both.
- **A dead pointer is a bug.** If the target is gone, delete the pointer rather than leave it.
- Move depth behind a pointer once a section outgrows a screen or two; keep the rule inline.

| file | what it covers |
| --- | --- |
| [`.agentDocs/ARCHITECTURE.md`](.agentDocs/ARCHITECTURE.md) | what each module owns and why; UI versioning |
| [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md) | the traps this codebase already paid for, with causes |
| [`.agentDocs/COMPATIBILITY.md`](.agentDocs/COMPATIBILITY.md) | config and UI compatibility, migrations |
| [`.agentDocs/RELEASING.md`](.agentDocs/RELEASING.md) | how a release is cut, and which version to dispatch |
| [`docs/SERVERS.md`](docs/SERVERS.md) | entries, presets, port conflicts, persistent entries |
| [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md) | notification destinations: Telegram, webhooks, shared defaults |
| [`docs/DDNS.md`](docs/DDNS.md) | dynamic-DNS providers and hostnames |
| [`docs/REVERSE_PROXY.md`](docs/REVERSE_PROXY.md) | the Caddy engine, routes, certificates |
| [`docs/UI_CREATION.md`](docs/UI_CREATION.md) | the contract for a new UI |

## Commands

`pnpm-workspace.yaml` is load-bearing: dropping an `allowBuilds` entry makes `pnpm install` **exit 1**
(`Ignored build scripts: …`). Keep the file's own comments explaining why each entry is there.

```sh
pnpm run cli <command>             # any command, against state in .dev-state/ — never ~/.home-hosted
pnpm run cli backup list           # e.g. `pnpm run cli <anything the CLI takes>`
pnpm run up|down|restart|status    # shorthand for the four most-used; detached, and `down` asks
                                   # /_hh/shutdown and signals only a pid whose identity it confirmed
pnpm run start                     # up --foreground (systemd, docker, a foreground shell)
pnpm dev                           # tsx-watch panel :6000 + the stock UI's Vite :6001, state in .dev-state/
pnpm dev --ui noc-console          # the same, for another UI; --port/--ui-port override
pnpm dev --home /tmp/hh-dev        # state elsewhere; HHOSTED_HOME is IGNORED here, and the real
                                   #   ~/.home-hosted is refused. Dev password: `dev`
pnpm run build                     # dist/cli.js + the stock UI (uis/stock/dist)
pnpm run build:uis                 # every UI under uis/, zipped into uis/dist/ (release assets)
pnpm run build:locales             # i18n/sheets/*.csv -> the git-ignored i18n/generated/*.json (also
                                   #   runs on install and before every UI build)
pnpm run quickcheck                # eslint + tsc + vue-tsc + the doc links — NOT the tests
pnpm exec vitest run               # `pnpm test` is vitest in watch mode
pnpm run check                     # ← THE GATE: quickcheck + vitest run --coverage. Run before every
                                   #   push — CI's `test.yml` is `pnpm test --coverage`, so an area floor
                                   #   failing there fails the push while `quickcheck` stays green.
pnpm run cli set-password          # non-interactive through HHOSTED_PASSWORD
pnpm run cli set-token --generate  # print a new API token once
pnpm run cli migrate               # bring the config up to this release's schema
pnpm exec tsx src/cli.ts init      # scaffold a project (interactive; --yes for defaults)
pnpm run media                     # regenerate docs/media; needs `pnpm exec playwright install chromium`
                                   #   once (browser only; `gif` alone does not)
```

The published bin is `home-hosted`, with an `hh` alias: both names run the same CLI.

**Dev servers and test instances stay in the 6xxx range** — panel 6000, UI 6001, test-spawned panels
6100+ (`--port`/`--ui-port`, or `HHOSTED_DEV_PANEL_PORT`/`HHOSTED_DEV_UI_PORT`). Never assume 3999 is
free: an installed panel or another dev instance may hold it, and the port preflight runs *before* the
workspace config guard, so a busy default port turns config tests red for the wrong reason.

## Conventions

- **ArkType at every runtime boundary.** Routes use `validate('json'|'query'|'param', schema)` then
  `c.req.valid(...)`; ad-hoc payloads use `parseOrThrow`. **A request schema rejects undeclared keys**
  (`.onUndeclaredKey('reject')`); **a response/view schema does not** — a newer panel may add a field an
  older client still reads, and rejecting there would blank that client.
- **Every failure is a `DetailedError`** (`@namesmt/utils`), mapped by `src/helpers/error.ts` into one
  envelope `{ message, code, detail }`. Never hand-roll `c.json({ error })`.
- **Document routes with `describeRoute` + `jsonBody(schema)`**; `jsonBody` needs a real schema.
- **Patch schemas carry no defaults**; nested groups merge key-by-key and an explicit `null` clears a
  key. `ddns`'s `accounts`/`domains` are **replaced** — a merge cannot express removing a hostname.
- **Two-sided bounds read inclusively** (`'1 <= number.integer <= 512'`). `test/shared/contracts.test.ts`
  pins every boundary and the patch/schema parity — update it with any schema change.
- **A single on/off setting is a `ToggleSwitch`**; `CheckField` is only for picking items out of a set.
- **A destructive action one click away confirms in a popover**, never by arming the same button for a
  second press — an impatient double click fires an armed button. Safe choice first in tab order.
  `ConfirmButton` is that popover in both UIs; `test/shared/ui-destructive-confirm.test.ts` reads every
  `.vue` for the armed shape — a label chosen by a flag, and the branch that arms on the first press
  and acts on the second, whichever way the handler is written and whatever the flag is called — so a
  new destructive control gets the rule from a red test rather than from review.
  **And the popover must name what it costs — the right cost for that row.** A destination row bound
  one kind's sentence for both kinds, so removing a webhook promised a bot token would go; the
  webhook's own copy sat unused in all nine catalogs. `ConfirmButton` also *silently* accepts a prop
  it does not declare (Vue puts it in `$attrs`), which is how `:question`/`:body` reached a component
  that expects `title`/`hint` and the popover fell back to "Confirm remove?" — typechecking cannot see
  a template, and a consequence scan asking only whether a `title` was present read the typo as
  "untitled". `test/shared/ui-prop-contract.test.ts` pins the two copies to one prop set and fails a
  call site that binds a name its own copy lacks. An exemption recorded for a row whose own text
  already states the cost is fine; a missing string is not.
- **A numeric option is a whole decimal integer, never a prefix parse** (`src/cli/up.ts`): `--port 1e3`
  and `--port 8000x` are refused, not read as 1 and 8000. A flag the command cannot honour is refused
  too — `restart --workspace <id>` with no server id exits 1 before anything is attempted, because the
  panel's own restart is not per-server and `down` then `up` would restart every server
  (`test/cli/server-action.test.ts`). That includes a modifier whose base flag is absent:
  `setup-temp --download` exited 0 having done nothing, so a script read it as "installed"
  (`test/cli/setup-temp.test.ts`). **The same rule covers a promise made in the help text**:
  `--clear` says it deletes the helper, and the CLI cleared the setting while the script survived —
  so `removeWslTemperatureScript` is one helper both callers use.
- **A bounded read stays bounded.** `logs --lines 1e3` falls back to the default and `0x10` is not the
  "whole log" sentinel (`src/cli/logs.ts`); `--lines N` reads a tail, never the whole file
  (`test/cli/logs.test.ts`).
- **A duration a person edits is in the unit its schema floor allows, on every surface.** A field whose
  floor is a second or more has no sub-second value, so its box edits seconds and converts with
  `msToSeconds`/`secondsToMs` (`src/shared/ui-format.ts`); below that (`health.intervalMs` 500,
  `health.timeoutMs` 100) ms stays, because seconds would round the field's whole accepted range away.
  `cooldownMs`' floor is `0` — the "off" sentinel — and every other value is whole seconds. **The guard
  reads every UI's sources, not one UI's catalog**: this was announced as done for both UIs while
  `noc-console` kept raw millisecond boxes, so one panel showed `120` where the other showed `120000`
  for one setting (`test/shared/ms-fields-seconds.test.ts`). A field name is not a field — `intervalMs`
  is declared four times with four floors — so a scan names the object a box reads through. An emptied
  seconds box is `NaN`, never `0`, which would store "every 0 seconds" or silently disable the throttle.
  **A seconds box is `:value`/`@input`, so its read-back is hand-written and a `v-model` scan cannot
  see it**: three boxes read `secondsToMs(Number(value))`, where `''` is `0` — a *decided* value the
  client schema then refused for the whole page (`sessionTtlMs must be at least 60000 (was 0)`), and
  the stock cooldown guarded `null` against a control that reports `NaN`. `readSeconds` and
  `secondsToMsOr` (`src/shared/ui-format.ts`) are the one read and the one conversion; the scan
  matches the coercion, not the attribute.
- **A reader that hangs up is a finished conversation, not a crash.** `treatClosedReaderAsDone()`
  (`src/cli/io.ts`) is installed **once** at the entry; only `EPIPE` is the reader leaving
  (`test/cli/epipe.test.ts`). Why not `SIGPIPE`: [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **One refusal is one message on one stream.** A refusal's whole text goes to stderr, including any
  list it exists to explain; stdout carries only an answer (`test/cli/backup-args.test.ts`).
- **A browser API that needs a secure context is absent on the origin the docs promise.** Guard the
  feature, not the call: `copyText` (`uis/stock/src/lib/clipboard.ts`) falls back to `execCommand` and
  returns a verdict, or a button is dead on a LAN page; `uis/stock/test/clipboard-source.test.ts`
  fails any other file that reaches the clipboard object — `navigator.clipboard`,
  `navigator['clipboard']` and `const { clipboard } = navigator` are one rule, not three spellings.
- **A row of chrome is measured at 320 px with the tap floor counted.** No mount can measure a
  layout, so `uis/stock/test/topbar-width.test.ts` pins the declarations that keep the title from
  collapsing to 0 px.
- **A retention knob bounds the directory, not a loop.** Derive the set from the directory once
  (`ownedFiles`/`retained`, `src/services/log-files.ts`) so the list, the size and the tail agree with
  `readdir`, and prune inside `rotate` (`test/services/log-files.test.ts`).
- **A file a route hands back is streamed, and the bound decides how much it matters.** `logs.maxBytes`
  allows 100 MB per rotation, so `createReadStream` + `stat` for `Content-Length`, in both routes. A
  schema ceiling is not a reason to buffer: it is the size a person downloads at.
- **A page the panel serves must not be blank without a CDN.** Render real content from
  `spec.json` first (`src/openapi-reference.ts`), then load any richer browser as optional
  enhancement, **pinned** — an unpinned `import` from a CDN is a third party that can break the
  panel's page. Before blaming a library for being online-only, drive its self-hosted build offline:
  the claim is usually about the integration, not the library.
- **An entry's server is not always the process the panel spawned.** A compose entry's containers
  outlive their wrapper, so resolve what the entry *declares it runs* (`composeTarget`), stop that,
  and decide from a **fresh listing** — never the signal or `docker stop`'s exit code, which is 0 for
  a container it could not end. A survivor is a `conflict` naming it (`src/providers/docker.ts`).
- **A per-frame path may not call a syscall per server.** The frame is built once a second and once
  per request, so anything reading the host, the filesystem or the process table from a view builder
  is cached on its own clock, not merely memoised per call (`lanAddress`, `src/helpers/bind.ts`).
- **What makes a frame "news" is derived from the block, never hand-picked out of it.** The signature
  gate (`stateSignature`, `src/services/panel.ts`) only decides whether a built frame is *published*,
  so a field it does not name is a change no client ever sees — and the field carrying a surface's
  **empty state** is the easiest one to forget. `host.enabled` is the whole empty state of four host
  surfaces, and the branch that writes it (`HostMonitor.tick` with sampling off) changes nothing else,
  so a signature naming only `sampledAt` and `alerts` published **no frame at all** when sampling was
  switched off, and a second tab kept drawing dials. Sign the whole view (`JSON.stringify(state.host)`)
  rather than a list of its fields, so a field added to a view is published without anyone remembering;
  a hand-picked list goes stale the next time a field earns a use. **A test for a transition must
  publish the preceding state first**, or the change it claims to watch is still banked in the
  signature and the test passes for the wrong reason
  (`test/services/panel.test.ts`: "carries a switch of host sampling into a published frame"). Why this
  keeps recurring: [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **A generated config says what it means for every branch, not just the one it names.** A name no
  policy names gets the engine's **default** (the public CA), not "no automation" — so every local
  name must be named in the internal policy too. A state describing something that has not happened
  is a promise: decide `local` from the leaf in the store, not the hostname's shape.
- **A metric with no reading is absent, never zero.** A scrape has no page to qualify a number, so an
  alerted-on gauge published as `0` from an unsampled view is indistinguishable from a healthy one
  and silences the rule that exists to catch it. Omit the series (`src/api/metrics.ts`), and never
  suffix `_total` a value that a user action resets — no series here is a counter, and
  `test/api/panel.test.ts` enumerates the scrape and fails on a `_total` name or a `counter` type.
  **The page a person reads has no page to qualify it either.** `emptyHostView()` is the all-zero
  frame a panel boots with and the one it keeps for ever with host vitals switched off, and the
  panel's own pages printed it — `0.0%` memory, `0.0%` swap, `0.00` load under a green `quiet` chip,
  in the rail on every screen. One predicate decides a host's readings (`hostReadings`,
  `src/shared/host-readings.ts`); a surface renders it, never the frame. The wire fields stay
  `number` because an overridden older UI in `.hh/.ui` calls `.toFixed()` on them.
  `test/shared/host-readings.test.ts` walks every `.vue` for a `?? 0` on one of those fields, in
  **any** shape a template renders one — `{{ }}`, a bound attribute (`:value`, `:display`) or
  `v-text` — because reading only the interpolation missed a fabricated `0 °C` in a `:display` prop.
  The scan shares its template reader with `test/shared/ui-readings.test.ts`
  (`test/helpers/template-render.ts`), so the two cannot drift apart again. **A binding has two
  spellings, and the scan must excuse both or neither**: `isGeometry` matches `:style`/`:class` and
  `v-bind:style`/`v-bind:class`, because a short-only predicate read the long form as text a person
  reads. The same rule for a scan's own matcher: **read the argument by its own delimiter, never by
  forbidding quote characters** — a body that may not contain `'` or `"` cannot match
  `toasts.failure("Couldn't rename the workspace")`, which is how an English toast stayed green
  behind `uis/stock/test/toast-copy.test.ts`. The reasons are in
  [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **A reading is labelled with what it measured, and a fallback must measure the same thing.** The
  "CPU temp" tile took `Math.max` over every hwmon chip, so a box with an NVMe reported the **disk's**
  temperature as the CPU's — and fired the temperature alert on it. Pick the sensor *by name*
  (`coretemp`/`k10temp`/`x86_pkg_temp`/`cpu-thermal`, then `acpitz`), and take the max only inside that
  tier, because a CPU package honestly has several dies. `pickCpuTemperature` (`src/providers/host.ts`)
  is the one place that decides, so it is testable without a sensor. **A platform with no sensor
  reports `null` and the UI says `n/a`** — WSL2 exposes no thermal zone at all, and the Windows host's
  `MSAcpi_ThermalZoneTemperature` returns a constant 20 °C whatever the load, so reaching for it
  would publish a fabricated number in the tile that exists to warn about heat.
- **A throttle window belongs to a message that arrived.** A send that failed must give its window
  back (`releaseCooldown`), or the alert that would have reached a recovering receiver is the one the
  outage took. Undo only the deadline *this* send armed; `notify()` is fire-and-forget.
- **A header is a byte string, and a stub does not make it one.** HTTP headers are Latin-1, so
  validate at the door (`headerProblem`/`parseHeaders`) rather than let a `ByteString` engine message
  land on a person's row, and treat a header name as case-insensitive
  (`test/services/notifications.test.ts`).
- **Name the cause the fix follows, not the one the code path suggests.** Node reports a missing
  working directory and a missing program with the same `ENOENT`, so `describeSpawnError` checks the
  resolved `cwd` **and** whether the field holds a whole command line before it blames the command —
  otherwise a deploy under systemd reads "`node` is not installed" while `node` is fine and only the
  launch directory is wrong, and a pasted `node server.js` reads the same way while `node` is
  installed. The same rule decides which advice a refused start prints: a config that needs `migrate`
  must say so rather than "install the release", and a file that cannot be parsed must not claim a
  migration `migrate` cannot perform. Ask what the person will *do* with the sentence before choosing
  it — and when a function's own docstring names the misreading it exists to prevent, that is a claim
  to test, not a description of the code.
- **One envelope per reader.** This API answers `{ message, code, detail }` for a thrown error and
  `{ ok: false, error }` for a refused lifecycle action. A client that reads one field shows
  `request failed with 409` for the other, losing the only sentence that explains the refusal while
  the card beside it prints that sentence in full. Read both in **one** helper
  (`failureMessage`, `src/shared/api-client.ts`) and scan for the hand-rolled fallback — a unit test
  cannot see a call site that has not been written yet. **The scan reads the construct, not the
  sentence**: a phrase-match on `` `request failed with …` `` passed a branch that rewrote the wording
  and one that destructured `message` before falling back. It reads the awaited `fetch`/`rpc.$post`
  binding and the `!response.ok` branch, and refuses a refusal that throws without the helper or
  renders `response.status` as text (`test/shared/action-failure-message.test.ts`).
- **A state and the streak behind it are written together.** `health`, `healthFailures` and
  `unhealthySince` describe one process's run, so a path that resets one and leaves the others
  reports a duration that keeps counting while nothing is measured — measured as `status=crashed
  health=unknown` beside `Unhealthy for 3m 17s` and a `Not Probed` row, on the card and the page.
  The explicit stop had that shape and was fixed alone once; the exit paths behind it were the same
  defect. One helper decides the trio (`setHealth`/`resetHealth` in `src/services/supervisor.ts`)
  and a scan fails a direct assignment. **A client cannot assume the server got there** — a newer
  UI is served against an older panel, so a UI rendering a *duration* gates it on the verdict it
  prints beside it, not on whether the timestamp is present.
- **A measurement belongs to the process that produced it, and goes when that process does.**
  `pid`, `responseMs` and `resources` are one run's numbers; a path that detaches the pid and keeps
  them reports a stopped entry with a live CPU, RSS and probe (`Probe 2 Ms / RSS 64.2 MB / Procs 1`
  beside `Stopped`, and `hh_server_cpu_percent` in the scrape). The two **exit** paths cleared them
  and the explicit stop did not — and an **adopted** successor has no exit event at all, because the
  panel is not its parent, so one helper (`endProcessReadings`) owns all four and a scan fails a
  clear outside it. The rule is general: ask which **lifecycle** clears a field, not which function
  happened to. `portState` is the deliberate exception — a port's occupancy outlives its process.
  The client half is the same predicate as the paragraph above: both UIs read a reading through
  `liveReadings` (`src/shared/server-readings.ts`), never off the frame, and never `?? 0` (a zero
  is the value that looks like a measured idle process). The read is not the whole gate — the
  *render* must carry the absence too: a percent goes through `pct`
  (`uis/noc-console/src/lib/format.ts`), because `{{ (… ?? 0).toFixed(0) }}%` put a measured `0%`
  on every stopped entry of the panel-wide overview, and `test/shared/ui-readings.test.ts` walks
  every UI template for that shape — following the reading into whatever local it was *destructured*
  or *derived* into, since `const { responseMs } = liveReadings(...)` and a second `computed` are the
  same number on screen, and reading that local's own initializer, because a fallback inside a
  `computed` never appears in the template. **An aggregate is a reading of the set**: `sumReadings`
  (`src/shared/server-readings.ts`) answers `null` when any member has no reading, so a workspace
  total is absent until every entry in it has a sample — summing with `?? 0` made a workspace whose
  only server had just started print `0.0% cpu now`, the fabricated idle process in the one number
  that summarises every entry at once. An empty list is a genuine `0`, and so is a measured one.
  **A chart is the same render**: an absent point stays absent in
  the series and the line breaks at it — `sparkSegments` (`uis/noc-console/src/lib/format.ts`) and
  stock's `components/telemetry/Sparkline.vue` — because a zero vertex drew a stopped entry as a flat
  line on the floor: a measured `0%` by eye, on every page the number beside it had already been
  fixed on. A new chart reads this paragraph before it picks its geometry function. **And a chart's
  scale is not the chart's alone**: `cpuPercent` sums a process tree, so it counts cores — the ceiling,
  the line's colour and the number's colour all come from `cpuCapacity`/`cpuBand`
  (`src/shared/cpu-scale.ts`), one home for the rule. Four surfaces restating it left the detail
  page's number on the old per-core bands, painting a sixth of a 24-core box red while its own
  sparkline stayed accent; `test/shared/cpu-scale.test.ts` fails a restated copy. **The capacity
  arrives as a core count, never as a number written at the call site** — `cpuBand(x, 100)` and
  `cpuCapacity(100)` restate it as surely as the retired `toneClass(cpu, 40, 80)` pair, and the scan
  reads the *call* (callee plus arguments, brackets balanced), so needing two literals is exactly
  the narrowing that missed them. **A verdict is
  measured against the threshold a person configured, and the frame has to carry it.** The band for
  a per-cpu load was the schema's *default* `2`/`1.4` written into two surfaces, so raising
  `host.loadPerCpu` painted a normal box `danger` for a notification that could never fire. The
  threshold travels on the frame (`host.loadAlertPerCpu`) and `loadBand`
  (`src/shared/host-readings.ts`) decides the band once, for both UIs; `0` disables the alert, so it
  cannot be breached, and a panel that sends no threshold gets the default it alerted on.
  `test/shared/host-readings.test.ts` fails a load compared against a literal, or a load tone
  computed outside the predicate. **The percentages are the same rule, and they were missed the first
  time.** `memoryUsedPercent`, `swapUsedPercent` and `tempCelsius` carry their thresholds
  (`…Alert`) and `percentageBand` bands them against those, because the literals contradicted the
  panel's own notifications: `hostSchema` alerts on swap at **50**, and the rail painted 52% `warn`;
  raising `host.tempCelsius` to 95 left a 90 °C box `danger`. **A disk is the same rule again, and it
  is the one the second pass still missed.** `host.diskUsedPercent` travels as
  `diskUsedPercentAlert`, and `hostReadings` puts a `band` on **each** disk rather than one beside the
  frame, because the reading is per path and a frame carries several: with the alert lowered to 80 the
  panel notified at 82% while `Gauge`/`Meter`'s `75`/`90` defaults and both noc-console helpers called
  it `warn`. Both components now *require* a `tone` (`warnAt`/`dangerAt` are gone), so the fallback
  that let a default stand in for a verdict cannot be reintroduced. So a host band always names the
  field it is measured against — when the paragraph above
  grows a new reading, check that the threshold is on the frame *and* that every surface reads the
  predicate, on both UIs; a component default is a copy you cannot see. **A dial's *scale* is that
  threshold too, and a band guard cannot see it.** There is no natural `100 °C`, so a temperature
  dial is drawn full at the alert — which one stock surface took from the frame and the other kept
  as `(tempCelsius / 85) * 100`, the schema's default. One frame at 60 °C against an alert of 95
  therefore drew arcs of `101.19` and `113.10`, and noc-console's rail sized its bar by the °C value
  itself. Every *colour* was right, so the tone tests stayed green while the needle disagreed —
  `tempDialPercent` (`src/shared/host-readings.ts`) decides the fill once, and the scan in
  `test/shared/host-readings.test.ts` fails a temperature divided, clamped or defaulted by a number.
  **A reading with no alert still has one band, and it is a constant here.** `host.cpuUsedPercent` is
  a share of the whole machine and `hostSchema` has no threshold for it, so there is nothing a person
  chose — but the band was written *twice*: noc-console painted `70`/`90` and every stock dial
  `80`/`95`, so one 75% reading came back `warn` on one page and `ok` on the other, each side
  self-consistent and neither tested against its twin. `hostCpuBand`/`HOST_CPU_BAND` decide it, and
  the scan fails a host surface that passes `warn-at`/`danger-at` to a dial. When a fixed band is a
  real decision, make it one decision — a component's default is a copy you cannot see, and two
  copies of a *fixed* number cannot even be caught by raising a config.
  Why these copies survived: [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **A list card and its detail page answer the same question; fix both.** The card is a summary of a
  page someone opens *precisely because the summary was not enough* — so a fact the card states and
  the page omits is worse than either alone. A stopped entry's card learned to say "not running"
  where the chart's default promised "collecting…", and the detail page kept the promise on all
  three of its charts, on the one screen a confused person reaches. A disabled entry's card showed a
  `disabled` chip; its detail page greyed out Start and Restart and said nothing, losing the only
  explanation on the way in. When you give a surface an empty state, a reason or a qualifier, grep
  for the other surface that renders the same field and land it there too — and prefer a shared
  component or a scan test over two call sites remembering in parallel.
- **A replaced list is sent only when *this form* changed it, and merged against what it was
  filled with.** `destinations` and `routes` are lists a patch replaces, so a save writes the
  sender's whole view — including entries it never saw. Deciding that against live state makes
  another client's save look like this form's own edit: measured with two tabs on one workspace
  settings page, a destination added in one tab was removed from `settings.json` by the other
  saving an unrelated toggle. Keep the baseline the block was filled with and compare the draft to
  *that* (`mergeReplacedList`); a list that was never filled must not travel, because `[]` on a
  replaced list means "delete every entry".
- **A replaced block is sent whole but *counted* as a diff.** A block the route replaces (`ddns`) has
  no partial wire form, so the patch carries every key — and counting that patch's leaves reported
  "9 fields changed" for one IPv6 toggle, with the untouched ones listed as `true → true`. What the
  footer counts, and what the change list shows, is `ddnsConfigPatch` against the block the form was
  filled with; the wire body stays whole.
- **A reactive value detaches by being rebuilt, never by `structuredClone(toRaw(...))`.** Reading a
  reactive array hands back **proxies for its members**, so a list the form rebuilt
  (`domains = domains.filter(...)`) stores them inside the raw array: `toRaw` on the parent unwraps
  nothing below it and the clone throws `DataCloneError: #<Object> could not be cloned`. Measured on
  the DDNS form, where removing one hostname left every later edit unable to publish a patch. One
  helper (`clonePlain`, `src/shared/clone.ts`) rebuilds plain objects at every level and needs no Vue,
  which is what lets the form logic live in `src/shared` rather than once per UI; a scan fails any UI
  source that names `structuredClone`. **Every source scan reads through
  `test/helpers/strip-comments.ts`; none strips comments by pattern.** A `/*` in a glob string or a
  `content: '/*'` in CSS opens a "comment" that closes at the next real one and deletes the code
  between them, so the scan goes green on the defect it exists to catch. `cssRules` parses a
  stylesheet: ask a rule's selector list and its `@media` tier, never a text pattern.
  **And a template is a region and a tag set, not a slice and a spelling.** `templateRegion` is the
  one root-`<template>` reader (depth-counted over the blanked source, so a `</template>` in a string
  or a nested `<template #slot>` cannot end it), and `openingTags` (`test/helpers/template-render.ts`)
  is the one call-site reader — self-closing `<X … />` and paired `<X …></X>` are the same call
  site, and a `>` inside a `:title` ternary is inside an attribute. `<MetricSpark …></MetricSpark>`
  with its hint dropped, and a `:question` bound after a `>` in the tag, each left their scan green.
- **A refused operation is a failure, never an empty success.** The backup service answers a *plan*
  for every archive, including ones it cannot read: `plan.error` carries the refusal and `items` is
  empty. A caller that reads only `items` reports "restored 0 items" with exit 0, which on a blank
  host — the one situation where nobody can check the result — is indistinguishable from a restore
  that worked. Read `error`/`needsPassword` before anything else, exit non-zero, and print `skipped`
  when an apply leaves pieces behind (`src/cli/backup.ts`). The same shape is why a scoped id is
  checked against the plan in **both** directions: `--exclude` with a typo excludes nothing, and an
  archive restored that way carries exactly the credentials the person meant to drop.
- **An archive outlives the release that wrote it.** Read a snapshot through the migrations `migrate`
  would run (`liftArchived`, `src/services/backups.ts`), write the **lifted** file, and stamp it with
  the release that wrote it; the newer direction stays a refusal from the manifest.
- **A summary line that disagrees with the lines above it is a bug.** Count every outcome a command
  can have.
- **Conventional commits** — changelogen derives the changelog and `scripts/check-release-version.mjs`
  the version bump. Below 1.0 the **minor is the breaking channel**: a fix is a patch, a minor means
  someone has to read the release notes and act — ask what the user has to do, not whether the commit
  says `feat:`. Never hand-edit `package.json`. See [`.agentDocs/RELEASING.md`](.agentDocs/RELEASING.md).

## Rules that matter

These prevent defects if broken. The *why* for the non-obvious ones is in
[`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).

- **A server gets only its own fields; UIs are clients.** No blessed ids and no `dataDir`-style
  globals: an entry is `command`/`args`/`env`/`dataEnvs`/`envFile`/`bootstrap`, and `#src/*` inside
  `src/` is the only import form — UIs use `@shared/*` (and `@server` for types only). A test fails
  if a core file names a particular server. Integrations the panel owns as infrastructure (the proxy
  engine, docker's container lookup, notification providers, DDNS) are not server entries and are
  expected in `src/`.
- **UIs are external clients.** Nothing in `src/**` may know a UI's markup or files;
  `$HHOSTED_HOME/.hh/.ui` overrides the packaged UI at runtime.
- **`src/shared` has exactly one declaration per member** — neither a UI nor `src/**` may re-declare
  one (`test/shared/ui-parity.test.ts`).
- **A new response *field* is optional (`'x?'`)** and read defensively: an upgrade writes a new UI while
  an old panel keeps serving, so a required field blanks the app.
- **UIs move together.** A change to `uis/stock` — or to a shared contract it reads — lands in every
  other UI under `uis/`, and each altered UI raises its `ui.json` version; `scripts/stamp-uis.mjs`
  **refuses** a commit that changed a shipped UI without raising it (a UI's `test/` and its own
  `README.md` are exempt — neither is in the built asset).
  `src/shared/**` is a UI build input, so a runtime contract needs the bump too — the hook does not
  inspect that commit. **`tag` and `unix` are build provenance**, stamped into `dist/ui.json` by
  `build-uis.mjs`; never committed to `uis/<name>/public/ui.json`.
- **Paths.** `dataRoot` is state, under `dataRoot/.hh`; `projectDir` is the base for relative entry
  paths. `{…}` and `${ENV}` expand in config — the full list is the table in
  [`docs/SERVERS.md`](docs/SERVERS.md), which is what to keep in step. No package-relative state.
- **Secrets never enter the config.** Only policy goes in a config file; every secret is 0600.
- **Never expose beyond loopback without auth and a non-default password.** `checkExposure()` is the
  single rule, enforced at startup, on every settings write, and in the UI. `checkProxyExposure()` is
  the same bar for a proxy route pointing at the panel — **`tls` does not change that bar.**
- **A credential is scoped to its origin.** A release-asset download must not carry its token across a
  cross-origin redirect; the runtime strips `authorization` today, so that is pinned against two real
  servers rather than a stubbed `fetch` (`test/providers/ui-release.test.ts`).
- **The CLI drives a running panel through `/_hh`, never `/api`.** `down` and `start`/`stop` read
  run.json's token over loopback through one guard (`assertLocalCall`), so they need no session. A new
  local command must not open an unauthenticated `/api` route.
- **A server id is only unique inside its workspace.** Anything keyed by id alone — SSE, log buffers,
  series, route params — must key on `(workspaceId, serverId)`, or same-named servers mix frames.
  **So must "what this panel owns."** A per-workspace service answering a panel-wide question — "is
  this pid ours?" — asks its own workspace and silently gets the wrong answer for the others: a port
  held by a sibling workspace's server read as a stranger, so `free-port` terminated it and `follow`
  adopted it into the wrong workspace (two workspaces then claimed one pid). The panel is the only
  thing that can see every workspace, so it injects the answer (`SupervisorOptions.siblingServers`)
  and a lone supervisor has none. Such a refusal must also say **where** the holder lives: "stop that
  server instead" is a dead end when that server is on a page this workspace cannot show.
- **A workspace is the ownership boundary.** Servers, secrets, logs and nanny state belong to exactly
  one; only listener, auth, TLS, host vitals, backups, UI and `run.json` are panel-wide. Reach a
  per-workspace service through `PanelService.requireWorkspace(id)`, never a module global.
- **A restore writes only where a config says** — archive allowlist, `origin` matching first, symlinks
  never recreated.
- **A declared path is the capture boundary, and its bytes keep their modes.** *Both* directions of a
  backup obey the declared path: the restore may not write through a link that leaves it, and the
  capture may not read through one — a `media -> /mnt/nas` link inside a declared `data/` put the whole
  share in every archive, and `du` on the declared path still said empty. The allowlist is a *move*
  rule, not a character rule: `My Photos/` and `ünïcode/日本語.txt` are what a real data tree holds, so
  a `\w` allowlist refused the archive the panel had just written. And a mode is part of the data —
  `0600`/`0700`/`0755` travel, a setuid bit does not — because a restore that widens a secret to `0644`
  changes who can read what the backup existed to protect.
  `src/providers/archive.ts` (`walk`, `permissionBits`), `src/services/backups.ts`
  (`isSafeArchiveEntry`), `test/providers/archive.test.ts`.
- **A port is only ever freed from a fresh lookup, never a quoted pid.** `free-port` re-lists the
  listeners and refuses any in `supervisedPids()` instead of killing it; a docker-published port has
  no pid this user may see, so the container docker reports publishing *that* port is stopped instead.
- **A live pid is not the running panel.** Pids are recycled and a zombie still answers signal 0, so `up`/`status`/`down` decide
  with `runtimeIsAlive`/`runtimeLiveness` (pid **plus** `run.json`'s own `startedAt`), never
  `isProcessAlive` alone. Only `'gone'` deletes a record; `'unknown'` counts as alive, and `'recycled'`
  blocks a **signal** but still allows the token-authenticated `/_hh/shutdown`, because the birth time is
  wall-clock-derived.
- **Only `kill` ever touches a process the panel could not identify** — which is why it logs the pids
  it stopped. `follow` adopts this entry's own successor, `reclaim` replaces it; ownership is the
  entry's whole **tree**, and the panel's own tree is excluded.
- **A persistent entry is run by its own nanny** (`src/services/nanny.ts`), which owns the pipes and
  mirrors the exit — the only arrangement that outlives the panel *and* keeps logging. The nanny never
  restarts anything: retries and health stay the supervisor's. Three lifetimes are pinned (see
  [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md)).
- **The reverse proxy's engine is a process the panel owns, not a server entry.** Its config is applied
  through the engine's admin API (atomic, never hand-edited), it runs under the same nanny a
  `persistent: true` entry uses, and its admin endpoint stays panel-side.
- **A claim that a dependency touches nothing else has to be checked against the dependency.** The
  proxy docs said "nothing else on the machine is touched", and the engine's own log said otherwise on
  the very first start: `pki.ca.local | installing root certificate (you might be prompted for
  password)` then `certificate installed properly in linux trusts` — the local CA's root goes into
  `/etc/ssl/certs`, which is why a `.lan` name is trusted at all, and why that first start needs
  `sudo`. Measured: one new `Caddy_Local_Authority_-_2026_ECC_Root*.pem` per engine data directory, so
  two homes on one box leave two roots, and a root outlives the `.hh` it came from. The knob exists
  (`apps.pki.certificate_authorities.local.install_trust`, verified by `POST /load`: `install_trust`
  under `ca`, under `apps.tls`, and on the issuer are all `unknown field`) and the panel does not set
  it, which is the right default — but the doc has to say what happens. Any run of the engine against
  a scratch home therefore **writes the host's trust store**; say so and clean up the root and its
  `/etc/ssl/certs` hash symlinks, or the next round inherits a machine with a dozen dead CAs.

- **Cross-platform is a hard requirement.** Linux/macOS/Windows: `/proc` vs `ps` vs Win32_Process,
  process groups vs `taskkill /T`, graceful fallbacks, no shell utilities assumed. Three Windows
  behaviours no other runner here can exercise, so each is decided in **one shared helper** rather
  than at the call site: a state file hand-edited in a Windows editor carries a byte-order mark or is
  UTF-16, so it is read through `readStateFile` (`src/helpers/config-text.ts`) and never
  `readFileSync(file, 'utf8')`. **That includes the files a UI author writes** — a BOM'd `ui.json`
  made the panel call an installed UI unnamed and `ui-update` print "the stock UI is in use", and
  `--print-config` printed `"settings": null` for a config that was fine; the scan in
  `test/helpers/config-text.test.ts` lists each hand-editable file with its reason, so a new one is a
  line there rather than a reader nobody audits. **A hand-edited file is not always JSON**: an entry's
  `envFile` is `KEY=value`, written by a person and never by this panel, so it goes through the same
  decoder — a `'utf8'` read gave every key a NUL, which `resolveSpawn` then dropped, and the process
  started without the secret the file exists to keep out of the config. The scan matches the
  **spelling** of the read too (`{ encoding: 'utf8' }`, `.toString('utf8')`, `'utf-8'`), because a
  matcher for one spelling let the others through. A bare command found in `node_modules/.bin` must
  resolve to a shim Windows can start, never the `#!/bin/sh` script written beside it
  (`resolveCommand`); and text printed **for a person to paste** is quoted for the shell it targets
  (`cdCommand`).
- **Writes are atomic** (`writeFileAtomic`) and validated before commit.

## How to work here

- **Check the callers before you change anything.** Grep who uses it and which tests name it. If the
  impact is unclear, say so — do not guess.
- **Never overwrite or delete a large section you have not understood.** Read it, or say what you could
  not determine and ask.
- **Do not invent requirements.** Build what was asked; surface what else you notice and let it be
  decided.
- **Fix the class, not the instance.** A copied helper, a rule stated twice, a guard bypassed by a
  second path is one problem: one implementation, one guard. That is the work, not a follow-up to ask
  for. Stay inside the task rather than refactoring the world.
- **Verify before claiming, and say what you checked.** A passing test is not evidence it pins
  anything — **break the thing it guards and watch it fail.** If it still passes, either the test is
  decoration or a different guard is running; find out which. Where a stub cannot answer the question,
  drive the real thing.
- **Never write an identifier from memory.** A commit hash, path, line number or version must be quoted
  from the source; a plausible-looking invented one is worse than none.
- **A stated blocker is a hypothesis, not a fact.** Re-test "cannot install X" / "tool unavailable"
  before inheriting it, and never report a failure your own flag forced.
- **Report the risk with the change** — correctness, security, operational and integration; plus what
  you could not verify and every assumption you made. An unverified claim marked as such beats a
  confident one that is wrong.
- **Missing recall of this repo?** Read this file, `.agentDocs/` and `git log` before acting, then ask
  1–3 focused questions rather than guessing at intent.
- **One guard here looked like the one that runs and was not**: `declaredData` marks a path
  `included: false` so the copy never starts, while the check inside `copyInto` is a second line that
  route does not reach.

## Conciseness

**Prune verbose, keep correctness** — code, comments, docs alike.

- Code: a comment only for non-obvious *intent*, never to restate the line, and never long. An
  argument for the change belongs in the commit message.
- Docs: one idea per sentence. Cut anything that would not change what a reader does.
- Delete history `git log` already holds — keep the *rule* that came out of it, not the story.
- **Never drop a caveat to save a line.** Concise means no filler, not fewer facts.

## User-facing docs

`README.md` and the topical `docs/*.md` are for a person, not an agent:

- **Concise first read**, depth behind collapsible `<details>` spoilers, and **visuals for skimmers** —
  the media in `docs/media/` is regenerated by `pnpm run media`.
- **Docs ship with the change.** A user-visible change updates the docs that describe it in the *same
  commit*. A stale doc is a bug like stale code.

## Where to extend

- **Route**: `src/api/<x>.ts` (chained factory) → mount in `src/app.ts` → schemas in
  `src/shared/contracts.ts` → `describeRoute` + `jsonBody`. A workspace-scoped route takes
  `?workspace=<id>` (`workspaceQuerySchema` + `requireWorkspace` in `src/helpers/workspace.ts`); an
  omitted id means the default workspace, never another one.
- **Server field**: `serverSchema` + its patch in contracts, merge keys in `src/config/patch.ts` when
  nested, the form in `uis/stock/src/components/settings/`, and the contract tests.
- **UI**: a new `uis/<name>/` with a `vite.config.ts` from the shared factory;
  `node scripts/build-uis.mjs <name> --zip`. The contract is `docs/UI_CREATION.md`.
- **Capability**: a stateless `src/providers/*` returning plain data; a DDNS provider is one file plus a
  registry line (`src/providers/ddns/index.ts`) — the settings form, credentials and validation follow
  from its metadata (`docs/DDNS.md`). A provider that is a **directory** also needs its own
  `package.json#imports` entry, because `#src/*` maps to a path and Node refuses a directory import
  (`test/helpers/imports.test.ts`).
