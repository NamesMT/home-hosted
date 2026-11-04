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
| [`.agentDocs/READINGS.md`](.agentDocs/READINGS.md) | why a reading's absence, band, scale and aggregate are each decided once |
| [`.agentDocs/COMPATIBILITY.md`](.agentDocs/COMPATIBILITY.md) | config and UI compatibility, migrations |
| [`.agentDocs/RELEASING.md`](.agentDocs/RELEASING.md) | how a release is cut, and which version to dispatch |
| [`.agentDocs/REVIEW-LOG.md`](.agentDocs/REVIEW-LOG.md) | end-user review ideas: what shipped, what is still open, what was verified good |
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
  second press — a double click fires an armed button. Safe choice first in tab order. `ConfirmButton`
  is that popover in both UIs. **It must name what it costs, the right cost for that row** — one row
  bound a single kind's sentence for both kinds. It also silently accepts a prop it does not declare
  (Vue puts it in `$attrs`), so a call site binding the wrong name gets the fallback copy without a
  word; `test/shared/ui-prop-contract.test.ts` pins both copies to one prop set.
  `test/shared/ui-destructive-confirm.test.ts` reads the armed shape in any handler form and any flag
  name, so a new destructive control gets the rule from a red test. `test/shared/ui-confirm-consequence.test.ts`
  reads every `.vue` in both UIs: a confirmation without a `title` fails, and so does a plain control
  whose click acts. A row whose own text already states the cost needs no repeated copy; a missing
  string does not, and an exemption is keyed to one label rather than a file.
- **A numeric option is a whole decimal integer, never a prefix parse** (`src/cli/up.ts`): `--port 1e3`
  and `--port 8000x` are refused, not read as 1 and 8000. A flag the command cannot honour is refused
  too — `restart --workspace <id>` with no server id exits 1 before anything is attempted, because the
  panel's own restart is not per-server and `down` then `up` would restart every server
  (`test/cli/server-action.test.ts`). That includes a modifier whose base flag is absent:
  `setup-temp --download` exited 0 having done nothing, so a script read it as "installed"
  (`test/cli/setup-temp.test.ts`). **The same rule covers a promise made in the help text**:
  `--clear` says it deletes the helper, and the CLI cleared the setting while the script survived —
  so `removeWslTemperatureScript` is one helper both callers use. It covers a flag read on one path
  and outranked on another: `ui-update --asset` lost to the installed asset on every path but
  `--tag` (`test/cli/ui-update.test.ts`). Decide a flag once, where the identity is read.
- **A bounded read stays bounded.** `logs --lines 1e3` falls back to the default and `0x10` is not the
  "whole log" sentinel (`src/cli/logs.ts`); `--lines N` reads a tail, never the whole file
  (`test/cli/logs.test.ts`).
- **A duration a person edits is in the unit its schema floor allows, on every surface.** A floor of a
  second or more means seconds (`msToSeconds`/`secondsToMs`); below that (`health.intervalMs` 500) ms
  stays, because seconds would round its whole range away. `cooldownMs`' floor is `0` — the "off"
  sentinel. Read and convert through `readSeconds`/`secondsToMsOr` (`src/shared/ui-format.ts`); a
  seconds box is `:value`/`@input`, so its read-back is hand-written and a `v-model` scan cannot see
  it — an emptied box is `NaN`, never `0`, which would store "every 0 seconds". A scan names the
  object a box reads through, because `intervalMs` is declared four times with four floors, and reads
  every UI's sources (`test/shared/ms-fields-seconds.test.ts`).
- **A reader that hangs up is a finished conversation, not a crash.** `treatClosedReaderAsDone()`
  (`src/cli/io.ts`) is installed **once** at the entry; only `EPIPE` is the reader leaving
  (`test/cli/epipe.test.ts`). Why not `SIGPIPE`: [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **One refusal is one message on one stream.** A refusal's whole text goes to stderr, including any
  list it exists to explain; stdout carries only an answer (`test/cli/backup-args.test.ts`). A
  refusal a command still has work to do after — `logs --json` has written its document, `down` has
  a persistent sweep to report — goes through `refusal()` (`src/cli/io.ts`), not `process.stdout`,
  because `fail()` exits and a hand-rolled `process.stdout.write('error …')` puts the reason in the
  answer (`test/cli/logs.test.ts`, `test/cli/down-persistent.test.ts`). `fail()` never returns, so it
  is a statement: `` `${fail('x')} — ${why}` `` exits before `${why}` exists and the reason is lost
  (`test/cli/setup-temp-refusal.test.ts`).
- **A browser API that needs a secure context is absent on the origin the docs promise.** Guard the
  feature, not the call, and return a verdict the button can render; one helper owns the fallback and
  a scan fails any other file that reaches the API, in every spelling. What it cost:
  [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **A row of chrome is measured at 320 px with the tap floor counted.** No mount can measure a
  layout, so `uis/stock/test/topbar-width.test.ts` and `mobile-layout.test.ts` pin the declarations
  that keep the title from collapsing to 0 px. Both read an element through `templateElements`, by
  its own body and its class *tokens*: a bound `:class="cn(…)"` is a class list too, and two elements
  sharing a class list are still two elements.
- **A retention knob bounds the directory, not a loop.** One derivation feeds the list, the size and
  the tail. Which failure taught it: [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **A file a route hands back is streamed, and the bound decides how much it matters.** `logs.maxBytes`
  allows 100 MB per rotation, so a stream plus `stat` for `Content-Length`, never a buffer. A schema
  ceiling is not a reason to buffer: it is the size a person downloads at.
- **A page the panel serves must not be blank without a CDN.** Render real content from
  `spec.json` first (`src/openapi-reference.ts`), then load any richer browser as optional
  enhancement, **pinned** — an unpinned `import` from a CDN is a third party that can break the
  panel's page. Before blaming a library for being online-only, drive its self-hosted build offline:
  the claim is usually about the integration, not the library.
- **An entry's server is not always the process the panel spawned.** Resolve what an entry *declares
  it runs*, stop that, and decide from a **fresh listing** — never the signal or `docker stop`'s exit
  code, which is 0 for a container it could not end. A survivor is a `conflict` naming it.
- **A per-frame path may not call a syscall per server.** The frame is built once a second and once
  per request, so anything reading the host, the filesystem or the process table from a view builder
  is cached on its own clock, not merely memoised per call (`lanAddress`, `src/helpers/bind.ts`).
  **A route is the same, and a *synchronous* spawn is worse**: `execFileSync` stops the event loop, so
  a settings read that spawned `powershell.exe` twice blocked every in-flight response for ~720 ms
  (`wslTemperatureStatus`). Cache the success; never cache a failure.
- **What makes a frame "news" is derived from the block, never hand-picked out of it.** The signature
  gate (`stateSignature`, `src/services/panel.ts`) decides whether a built frame is published, so a
  field it does not name is a change no client sees — and the field carrying a surface's **empty
  state** is the easiest to forget. Sign the whole view (`JSON.stringify(state.host)`); a hand-picked
  field list goes stale the next time a field earns a use. **A test for a transition must publish the
  preceding state first**, or the change is still banked in the signature and the test passes for the
  wrong reason (`test/services/panel.test.ts`).
- **A generated config says what it means for every branch, not just the one it names.** A name no
  policy names gets the engine's **default** (the public CA), not "no automation" — so every local
  name must be named in the internal policy too. A state describing something that has not happened
  is a promise: decide `local` from the leaf in the store, not the hostname's shape.
- **A metric with no reading is absent, never zero.** Omit the series (`src/api/metrics.ts`) rather
  than publish `0` — an alerted-on gauge reading zero is indistinguishable from a healthy one and
  silences the rule that catches it. Never suffix `_total` a value a user action resets; no series
  here is a counter, and `test/api/panel.test.ts` enumerates the scrape. **The page has no page to
  qualify it either**: the panel's own surfaces printed the boot frame's zeros, so one predicate
  decides a host's readings and a surface renders it, never the frame
  ([`.agentDocs/READINGS.md`](.agentDocs/READINGS.md)).
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
  resolved `cwd` *and* whether the field holds a whole command line. A config that needs `migrate`
  must say so rather than "install the release"; a file that cannot be parsed must not claim a
  migration `migrate` cannot perform. Ask what the person will *do* with the sentence — and when a
  docstring names the misreading it prevents, that is a claim to test, not a description.
- **One envelope per reader.** This API answers `{ message, code, detail }` for a thrown error and
  `{ ok: false, error }` for a refused lifecycle action. Read both in **one** helper
  (`failureMessage`, `src/shared/api-client.ts`) and scan for the hand-rolled fallback. The scan reads
  the construct — the awaited binding and its `!response.ok` branch — never one sentence
  (`test/shared/action-failure-message.test.ts`).
- **A state and the streak behind it are written together.** `health`, `healthFailures` and
  `unhealthySince` describe one process's run, so a path that resets one and leaves the others
  reports a duration that keeps counting while nothing is measured — measured as `status=crashed
  health=unknown` beside `Unhealthy for 3m 17s` and a `Not Probed` row, on the card and the page.
  The explicit stop had that shape and was fixed alone once; the exit paths behind it were the same
  defect. One helper decides the trio (`setHealth`/`resetHealth` in `src/services/supervisor.ts`)
  and a scan fails a direct assignment. **A client cannot assume the server got there** — a newer
  UI is served against an older panel, so a UI rendering a *duration* gates it on the verdict it
  prints beside it, not on whether the timestamp is present.
- **A measurement belongs to the process that produced it, and goes when that process does.** One
  helper clears it (`endProcessReadings`), because the exit paths, the explicit stop and an adopted
  successor are four lifecycles and only three were handled. `portState` is the exception — occupancy
  outlives its process. The client half is the same predicate: both UIs read a reading through
  `liveReadings`/`pct`/`sparkSegments`, never off the frame and never `?? 0`, and an aggregate is a
  reading of the set (`sumReadings`). **A verdict is measured against the threshold the person
  configured, and the frame carries it** (`loadBand`/`percentageBand`/`hostCpuBand`, each with its
  `…Alert` field; `Gauge`/`Meter` require a `tone`), and a dial's *scale* is that threshold too
  (`tempDialPercent`). **A capacity is a core count from the frame too**, never `(cpus ?? 1) * 100`
  written at the call site; one predicate scans that and a `Math.max(100, …)` floor.
  One home per reading, on both UIs. Depth, causes and the scans that enforce
  each: [`.agentDocs/READINGS.md`](.agentDocs/READINGS.md).
- **A list card and its detail page answer the same question; fix both.** The card is a summary of a
  page someone opens *precisely because the summary was not enough* — so a fact the card states and
  the page omits is worse than either alone. A stopped entry's card learned to say "not running"
  where the chart's default promised "collecting…", and the detail page kept the promise on all
  three of its charts, on the one screen a confused person reaches. A disabled entry's card showed a
  `disabled` chip; its detail page greyed out Start and Restart and said nothing, losing the only
  explanation on the way in. When you give a surface an empty state, a reason or a qualifier, grep
  for the other surface that renders the same field and land it there too — and prefer a shared
  component or a scan test over two call sites remembering in parallel. **A reading painted beside
  its own chart is the worst case**: a probe's number and the sparkline under it are one reading, so
  one band decides both (`probeBand`), and neither may restate the thresholds.
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
  reactive array hands back proxies for its members, so a list the form rebuilt
  (`domains = domains.filter(...)`) holds them inside the raw array and the clone throws. One helper
  (`clonePlain`, `src/shared/clone.ts`) rebuilds plain objects at every level and needs no Vue, which
  is what lets form logic live in `src/shared`; a scan fails a UI source that names `structuredClone`.
  **Every source scan reads through `test/helpers/strip-comments.ts`** — a hand-rolled stripper eats
  code at a `/*` inside a string and the scan then passes the defect it guards. Templates go through
  `templateRegion`/`openingTags`/`templateElements` (`test/helpers/template-render.ts`): a template is
  a region, a tag ends at the first `>` outside an attribute, and an element's classes and body come
  from that element — never from a search for its class text.
- **A refused operation is a failure, never an empty success.** The backup service answers a *plan*
  for every archive, including ones it cannot read: `plan.error` carries the refusal and `items` is
  empty. A caller that reads only `items` reports "restored 0 items" with exit 0 — on a blank host,
  where nobody can check, that reads as a restore that worked. Read `error`/`needsPassword` first,
  exit non-zero, and print the **apply's** `skipped`, never the plan's: a skip only the apply can
  make (a dump staged for an entry with no `load` hook) is absent from the plan's list
  (`src/cli/backup.ts`). A scoped id is checked against the plan in **both** directions too:
  `--exclude` with a typo excludes nothing, and that archive carries the credentials meant to drop.
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
- **A live pid is not the running panel, and a heartbeat is not its identity.** Pids are recycled and a
  zombie still answers signal 0, so `up`/`status`/`down` decide with `runtimeIsAlive`/`runtimeLiveness`
  (pid **plus** `run.json`'s own `startedAt`), never `isProcessAlive` alone. Only `'gone'` deletes a
  record; `'unknown'` counts as alive, and `'recycled'` blocks a **signal** but still allows the
  token-authenticated `/_hh/shutdown`, because the birth time is wall-clock-derived. A process named by
  a **record** is asked the same question with `processLiveness` before it is signalled or adopted —
  `nannyIsAlive`'s heartbeat is written *into* the file, so it says nothing about the pid it names.
- **Only `kill` ever touches a process the panel could not identify** — which is why it logs the pids
  it stopped. `follow` adopts this entry's own successor, `reclaim` replaces it; ownership is the
  entry's whole **tree**, and the panel's own tree is excluded.
- **A persistent entry is run by its own nanny** (`src/services/nanny.ts`), which owns the pipes and
  mirrors the exit — the only arrangement that outlives the panel *and* keeps logging. The nanny never
  restarts anything: retries and health stay the supervisor's. It traps only `NANNY_TRAPPED_SIGNALS`, so
  the configured signal decides whether the stop was forwarded, and whoever signals it stops the child
  too. Three lifetimes are pinned (see [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md)).
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
  behaviours no other runner here exercises, so each is one shared helper, never a call site: a
  hand-edited state file is read through `readStateFile` (`src/helpers/config-text.ts`), never
  `readFileSync(f, 'utf8')` — a BOM or UTF-16 is what Windows editors write, and a `'utf8'` read has
  already destroyed the bytes that tell them apart; a bare command in `node_modules/.bin` resolves
  through `resolveCommand` to a shim Windows can start; text a person will paste is quoted for their
  shell (`cdCommand`). A hand-edited file is not always JSON (`envFile` is `KEY=value`) and the scan
  matches every spelling of the read (`test/helpers/config-text.test.ts`). **A process-table readback
  is a word list where an empty argument is a word**: `/proc/<pid>/cmdline` NUL-terminates every word,
  so dropping every empty element shifted the rest (`processArgv`, `test/providers/identity.test.ts`).
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
- **A command that answers on spawn reports a lie when the process dies.** `start` and `restart <id>`
  return `ok` the moment the child is spawned, so an entry whose command exits immediately printed
  "started" and exited 0 while already in its crash-restart loop, and `start x && curl x` raced every
  boot. The CLI reads the entry back (`GET /_hh/servers/:id`) and refuses when it is gone. **`start`
  reporting on spawn is right for the panel and wrong for a script** — the decision belongs to the
  caller that knows which it is.
- **"Not running" is a claim about the machine, not about the record.** With `run.json` gone but a
  panel still listening, `down` printed "not running" and exited 0, so `down && up` proceeded against
  a live panel holding its port. It now probes the port its own `settings.json` names and **refuses**,
  naming where the answer came from — and signals nothing, because without a record there is no pid
  it can prove it owns.
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
