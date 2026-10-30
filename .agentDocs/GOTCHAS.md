# Gotchas — traps and their causes

**Goal:** the non-obvious failures this codebase has already paid for, so they are not repeated.
**Scope:** traps and the reasoning behind a non-obvious choice. Hard rules that must never be
broken are stated in `AGENTS.md` too — this file carries the *why*, and the ones that need it.

Most entries are a cause, not just a symptom. Where the symptom alone is enough to act on, it is a
line in `AGENTS.md` instead.

## Process and platform

- **A pipe's reader leaving is not a write failure, but Node reports it as one.** `process.stdout` in a
  CLI is a socket, so when the reader closes (`| head -1`, `| grep -q`, an agent that reads one line)
  the next write emits an `error` event with `code: 'EPIPE'`, and an unhandled `error` on a stream kills
  the process. Measured on `dist/cli.js`: `status | head -1` printed
  `Error: write EPIPE … at runStatus (dist/cli.js:22272)` and exited **1**, and `logs --lines all` and
  `logs --follow` did the same — so `set -o pipefail`, the first line of most deploy scripts, turned a
  working panel into a failed step and put a traceback in the operator's log where the answer belonged.
  `treatClosedReaderAsDone()` (`src/cli/io.ts`) is installed **once** in `main()`, not per command:
  there are 109 `process.stdout.write` sites and a per-site guard is exactly the shape that leaves the
  next one broken. It exits **0** instead of dying of `SIGPIPE` (141, what `cat` and `git` do), because
  the command did its work and only the reader stopped listening, so nothing was refused — `node --help`
  and `python -c` exit 0 for the same reason. Only `EPIPE` is special-cased; `ENOSPC` and friends are
  real failures and are rethrown (`test/cli/epipe.test.ts`, `test/cli/io.test.ts`).
- **A test spawns the CLI through `process.execPath`, never `node_modules/.bin/tsx`.** That file is a
  `#!/bin/sh` shim; Windows has `tsx.cmd`/`tsx.ps1` there instead, so `execFile` on the POSIX path
  starts nothing and the child's streams come back empty. Nothing throws: the assertion fails as
  `expected '' to match …`, naming the output rather than the launcher, and only on the Windows
  runner. `test/support/run-cli.ts` is the one launcher and `test/cli/cli-launcher.test.ts` pins its
  argv — the old form passed every test on Linux.
- **`run.json` is the daemon's identity and `down`'s credential.** Keep `runtimeSchema` in sync with
  the `Runtime` written in `src/index.ts`. It lives at `.hh/run.json`.
- **A test or script that reads a file as text must not assume the line ending.** A Windows checkout
  has CRLF, so `indexOf('\n}\n')` found nothing, the slice ran past the function it meant to isolate and
  picked up the *next* one's contents — `global group 'defaults'` failing against the global keys list.
  Linux CI passed; only the platform gate caught it. Normalize (`replaceAll('\r\n', '\n')`) **and throw
  when the boundary is missing**, because silent bleed is the failure mode.
- **A Windows editor writes a byte-order mark, and `JSON.parse` refuses it.** PowerShell 5.1's
  `Set-Content -Encoding UTF8` and Notepad's "UTF-8 with BOM" prepend `EF BB BF`; `Out-File` and `>`
  write **UTF-16LE** with `FF FE`. Every file this panel invites a person to hand-edit is JSON, so a
  correct edit read as *"cannot parse … Unexpected token '\uFEFF'"* — an error naming a character the
  person cannot see, recreated by the editor on the next save. Read a state file through
  `readStateFile` (`helpers/config-text.ts`), never `readFileSync(file, 'utf8')`: a `'utf8'` read has
  already destroyed the bytes that tell UTF-16 from UTF-8. A new hand-editable JSON file goes through
  it too — the decoder is one function, not a per-file fix.
- **A hand-edited file is not always JSON, and the failure is quieter when it is not.** An entry's
  `envFile` is `KEY=value`, written by the person and never by this panel, so a UTF-16 save was read
  as `"\uFFFD\u0000T\u0000O\u0000K\u0000E\u0000N\u0000"` — the parser takes the text before the first
  `=` as a key, so every key carried a NUL and `resolveSpawn` dropped it as "an environment key
  containing a null byte". Nothing failed: the entry started with none of the secrets the file exists
  to keep out of `servers.config.json`. The scan that lists hand-editable files missed this one *and*
  matched only one spelling of the read — `{ encoding: 'utf8' }`, `.toString('utf8')` and `'utf-8'`
  each walked a planted break straight past it, so a guard that named every listed file still could
  not see the shape it forbade.
- **`node_modules/.bin` holds a POSIX script *and* the Windows shims under the same stem.** `foo`,
  `foo.cmd` and `foo.ps1` are all written for one dependency; `foo` is a `#!/bin/sh` script Node cannot
  start on Windows. `resolveCommand` therefore searches the extensioned shims **first** and never falls
  back to the bare name — the old `[command, ...shims]` order resolved to the shell script and the
  entry failed with the `ENOENT` that reads as a missing program.
- **A file capability makes a process non-dumpable, so attribution tools see nothing.** An engine
  told to `setcap cap_net_bind_service` (what `docs/REVERSE_PROXY.md` instructs to bind :80) has
  `/proc/<pid>/environ` and `/proc/<pid>/fd` owned by root, so `lsof`/`fuser` return an empty list
  for the port it is serving on and `processCarriesServerId` answers false — the witness the *nanny*
  path relies on. An empty holder list is not a free port, and the panel's own engine is the
  likeliest invisible holder. Identify it from records the panel wrote (the ports last applied, the
  nanny state's heartbeat), never from the process table.
- **A basename is not an identity.** `sameWord` compares two spellings of the same file, and it fell
  back to `path.basename` on **both** sides — so `/tmp/evil/server.js` matched `/srv/web/server.js`,
  the exact guarantee the comment above it claimed to make. A false match here is not cosmetic:
  `matchesSpawn` decides whether a process is *this entry's*, so the panel would adopt a stranger on
  `follow`, or remove one on `reclaim`/`kill`. The fallback is needed while one spelling is bare (the
  config says `node`, the process table says `/usr/bin/node`); it must not apply when both name a
  directory.
- `vite.server.config.ts` targets `node22` while `engines` requires >= 24 — deliberate margin.
- **A bounded read must stay bounded.** `readLog` (`helpers/daemon-log.ts`) answers `logs --lines N`
  from the tail of the file, so peak allocation does not scale with a 10 MB pair; the test asserts
  that shape rather than a wall-clock number, which would be flaky on CI.
- **`pnpm run media` needs a browser that `pnpm install` does not fetch, plus fonts and the
  X/NSS/Mesa libraries.** Playwright's package is a dependency but its Chromium is a separate
  download (`pnpm exec playwright install chromium`, ~150 MB in `~/.cache/ms-playwright`), so the
  script loads it lazily and names that command rather than letting Playwright's ad panel read as a
  crash — `gif` alone re-encodes frames already on disk and never touches it. In a bare container
  also point `FONTCONFIG_PATH` at a `fonts.conf` covering any TTF and `LD_LIBRARY_PATH` at a
  directory holding those libraries: without fonts, Skia panics instead of rendering, and the
  failure looks like a broken page rather than a missing package.
- **`capture-media.mjs` writes a *workspace-era* home.** It used to write `control` and `defaults`
  into `servers.config.json`, which the workspace split moved to `settings.json` — so the panel
  ignored the port it was given and listened on 3999, and the `uis` capture timed out waiting on
  the port it thought it had chosen. The layout it writes now is `.hh/settings.json` (panel-wide),
  `.hh/default/settings.json` and `.hh/default/servers.config.json`.

- **Three causes share one `ENOENT`: a missing directory, a missing program, and a field holding a
  whole command line.** `spawn` resolves `cwd` before it looks for the program, so both of the first
  two fail identically; and `command` is spawned with no shell, so `"node server.js"` asks for a
  program with a space in its name and fails the same way. `describeSpawnError` decides in that order
  — directory, then a command line whose **first word resolves** (`findProgram`), then the program —
  and the third test is deliberately conditional: a first word that does not resolve keeps the honest
  "not found on PATH" message, because guessing there would send someone to split a line when the real
  problem is that `java` is not installed. `describeSpawnError`'s docstring described the pasted-line
  case for a release while the code could not detect it; the docstring was right and the branch was
  missing.

- **A refusal split across two streams is invisible to a `--json` caller.** `backup create` with
  neither `--all` nor `--include` wrote the candidate ids to **stdout** and the sentence that
  introduced them to **stderr**, so a script asking for JSON got neither a document nor a reason.
  The rule is one refusal, one message, one stream: the whole text goes to stderr — including any list
  it exists to explain — and stdout carries only an answer (`test/cli/backup-args.test.ts`). Print
  helpers take their sink rather than assuming `process.stdout`.

## Supervision

- **`Supervisor.start()` sets `starting` synchronously before its first await**, and `stop()` sets
  `stopping` first: overlapping calls would double-spawn or resurrect a stopped process. Tests must
  call `supervisor.dispose()`.
  `stopping` is cleared on **every** exit path of `stopEntry()`: the early return for an entry with
  no child used to leave it set, and since `start()` refuses while it is true, one Stop on an
  already-stopped server made that entry unstartable until a daemon restart.
- **Timers and `void`-ed promises in the supervisor carry a `.catch`**: a throw in the tick or in a
  retry is an unhandled rejection, and Node 24 ends the process on one.
- **An adopted process is not a `ChildProcess`**, so nothing reports its exit — the tick polls
  liveness and hands the entry back to the normal `afterExit` path. Its output is not captured
  either; it was redirected by whoever spawned it. The exception is a persistent entry, whose output
  the panel *does* capture through its nanny's JSONL.
- **Ownership is read from `HHOSTED_SERVER_ID` in the environment** (`/proc` on Linux, `ps -E` on
  macOS), falling back to the entry's own resolved image **plus its expanded argv** where that is
  unavailable or unmatched — the fallback is what gives `follow`/`reclaim` any reach on Windows,
  which exposes no per-process environment. That fallback is **strict on purpose**, because `reclaim`
  kills what it identifies: arguments are compared **literally** (`/srv/a/server.js` must not match
  `/tmp/b/server.js`), an argument can never be satisfied by a word that is not in the argv, and two
  matching holders mean the panel refuses to guess and blocks. It cannot see through a Windows `.cmd`
  shim or a macOS argument containing a space; those block, and `kill` is the answer. The argv comes
  from the supervisor's single `resolveSpawn()` — **keep it to one resolver**, because a second one
  that expands or filters args differently re-opens these cases.
- **The marker carries no workspace, so identity is *not* the whole of ownership.** `HHOSTED_SERVER_ID`
  is the bare id, and the argv fallback compares image and arguments — both of which are identical for
  a service copied into a second workspace. Neither answers "is this pid this *panel's*?", and
  `Supervisor` is per-workspace: `supervisedPids()` used to walk only its own entries, so a sibling
  workspace's server was a stranger to every consumer of the split. Measured with two workspaces and
  one shared port: `free-port` on `staging` terminated `default`'s pid and answered
  `{ok: true, terminated: [<default's pid>], free: true}` while that entry restarted under a new pid,
  and `onPortConflict: follow` adopted the sibling's process, so both workspaces reported the same pid
  as running and stopping either left the other claiming it. **A panel-wide question needs a
  panel-wide answer**: the panel injects `siblingServers`, its roots join the tree walk, and the
  refusal names the owning `workspace/server` — a bare "stop that server instead" points at a page
  this workspace does not have. Any future per-workspace service that decides "is this ours?" has the
  same shape.
- **A persistent entry's three lifetimes are pinned deliberately.** The nanny **exits with its
  child** — an inherited pipe would keep it alive and the panel would report a healthy entry whose
  server is a detached stranger. A stop reaches the child **by pid from the state file**, because
  `SIGKILL` and `killGroup: false` cannot be forwarded (which is why a self-restarting program
  belongs on `reclaim`). And its `SIGTERM`/`SIGINT` traps arm **before the child exists** and before
  that state file appears, so a stop that beats the spawn cannot orphan a child nobody has a record
  of. Reattach is `nannyIsAlive` = live pid **and** a fresh heartbeat, plus the marker or the argv —
  a live pid alone proves nothing, since pids are reused. `logs.persist: false` keeps that file out of
  the Logs page but never stops it being written: it is the transport.
- **`stop.killPortHolders` frees a port only from a *listener* that is not our own process tree.**
  Broad `lsof -ti:<port>` sweeps and pid-as-text parses have killed supervisors in the field; do not
  add one. `free-port` reuses the same lookup and adds the supervisor's own pid set on top.
- **The tick publishes only on change, but the frame it decides on is built every tick.** `getState()`
  was believed cheap; a 40-entry home measured the opposite. `getState()` → `backups.view()` →
  `resolveBackupPaths()` → `serverTemplateVars()` **per entry** → `lanAddress()` →
  `os.networkInterfaces()`, which is 34–62 ms on a three-interface box: 82 enumerations per frame,
  ~4.2 s of a 4.3 s window blocked inside them, `/healthz` answering in 4.5 s on an **idle** panel
  with no client connected. The signature check avoids *publishing*, not the work of building the
  state, so "we only publish on change" is not a performance argument. Cache the host read on its own
  clock (`lanAddress`, `src/helpers/bind.ts`) and cost a new view-builder call at the entry count,
  never at one entry.
- **A hand-picked signature publishes nothing for the field it forgot, and the empty state is what it
  forgets.** `stateSignature` joins one string per thing a UI redraws from, and the host block was
  two of its fields: `sampledAt` and `alerts`. `HostMonitor.tick` with sampling off writes **neither**
  — it keeps the last view and sets `enabled: false` — so switching sampling off in Settings published
  no frame at all, and every other tab kept drawing live dials and a green `quiet` chip for a panel
  that had stopped measuring. Measured on the real `PanelService`: sample, publish, `updateHost({
  enabled: false })`, tick, `notifyStateChange()` → frame count stayed at 2 and both frames still read
  `enabled: true`. Two earlier fixes had already added the one field that was missing (`ui`, then a
  destination's policy), which is the tell that the list is the defect and not its contents; the host
  view is now signed whole (`JSON.stringify`). And the reason the first test for this went **green**
  is worth keeping: the sample's own frame had not been published yet, so `sampledAt` was still a
  change banked in the signature and the switch rode out on it. A test for a transition has to publish
  the state before the transition, or it is watching the previous change arrive.
- **Startup is dominated by module load, not by work.** `src/app.ts` and the schemas it pulls in cost
  over a second to import, so `up` defers the daemon graph until it has decided to detach, and the
  daemon child inherits `process.execArgv` — under tsx it re-compiles that graph, under the built CLI
  it does not. A "slow" startup is the graph, not a loop.

- **An entry's server is not always the process the panel spawned.** A compose entry's containers
  outlive their wrapper — a reboot, a `docker compose up -d` from a shell, a panel crash — so a stop
  that signals only `entry.child`/`entry.pid` answers "stopped" over a stack that is still serving:
  measured `POST /api/servers/web/stop` returning `{"ok":true}` while the stack answered HTTP 200,
  with `stop-all` and `down` doing the same and exiting 0. Resolve what the entry *declares it runs*
  (`composeTarget`), stop that, and decide from a **fresh listing** — never from the signal or
  `docker stop`'s exit code, which is 0 for a container it could not end. A survivor is a `conflict`
  naming it (`refuseLingeringStack`, `stopComposeContainers`, `src/providers/docker.ts`). The same
  predicate (`isOwnStack`) decides whether a refusal may offer `warn`, because "your own stack,
  already up" and "a stranger holds this port" need opposite advice.
- **A throttle window belongs to a message that actually arrived.** Arming before the send is what
  collapses a flapping server, which is the point — but a send that failed told nobody anything, so it
  must give its window back (`releaseCooldown`) or the alert that would have reached a receiver coming
  back up is the one the outage took. Measured on the built panel: a crash alert recorded
  `fetch failed` against a down receiver, and the next two crashes inside the five-minute window were
  silenced, so bringing the receiver up changed nothing. Undo only the deadline *this* send armed — a
  concurrent dispatch may have set a later one. `notify()` is fire-and-forget, so nothing retries: the
  next event is the retry.

- **A WSL2 guest has no temperature the kernel can read, and the Windows fallback is a stub — but the
  hardware does have one.** Chased end to end on a GMKtec NucBox EVO-X1 (Ryzen AI 9 HX 370), because
  the host vitals tile read `n/a`:
  - inside the guest: **no** `/sys/class/thermal/thermal_zone*`, an **empty** `/sys/class/hwmon`, and
    `find /sys -name 'temp*_input'` returns **nothing** — so no bundled Linux binary can read what
    the kernel does not expose. `CONFIG_SENSORS_K10TEMP=m` and `x86_pkg_temp_thermal` exist and load,
    but bind no device (`No such device`): WSL2 exposes 3 synthetic PCI devices and the guest CPUID
    carries no thermal feature for them to attach to.
  - the guest *can* read MSRs (`/dev/cpu/0/msr` after `modprobe msr`; TSC and APIC_BASE return real
    values) — but `MSR 0xC00000A4` (AMD Tctl) reads **0**, because `k10temp` never bound.
  - the Windows side's only thermal class is `MSAcpi_ThermalZoneTemperature`, and on this box it is a
    **constant 2932** (20.0 °C) at idle *and* under twelve busy cores, as is the perfmon counter and
    `Win32_PerfRawData_Counters_ThermalZoneInformation`. Reporting it would be a fabricated number in
    the tile that exists to warn about heat — worse than `n/a`.
  - **LibreHardwareMonitor's library reads the real sensor**: `Core (Tctl/Tdie)` = **63.9 °C** idle,
    **75.25 °C** after four seconds of full load, settling to ~73.8 °C. So the reading is reachable —
    just not from anything built into Windows or WSL.
  A bundled reader is therefore possible but is a product decision, not a fix: LHM is **MPL-2.0**, the
  package is 6.4 MB, it only helps a Windows host with a WSL2 guest, and it needs a `powershell.exe`
  (5.1 works; the DLL wants `System.Memory` beside it) reached across `/mnt/c`. The honest default
  stays `n/a`; the docstring and `README.md` say "best-effort" and that is accurate.
- **`setup-temp`'s modifier flags were advertised as if they stood alone.** `--download` and
  `--no-download` only reach a download inside the `--wsl` branch, and the no-flag branch returns
  before a source is chosen, so `setup-temp --download` printed the state, wrote nothing and exited
  **0** — the shape a script reads as "installed", followed by a tile that still says `n/a`. `--clear`
  broke the opposite way: its help text and `docs/SERVERS.md` both promise it deletes the helper, and
  it wrote `tempCommand: ''` while `/mnt/c/ProgramData/home-hosted/cpu-temp.ps1` survived
  — measured on this guest, where the file outlived every clear. The API's own `DELETE` route *did*
  delete it, which is why the promise looked kept from the settings page and not from the CLI. Both
  are now decided once: `flagProblem` refuses a modifier with no base flag or beside `--clear`, and
  `removeWslTemperatureScript` is the one deleter both callers use.

## Metrics

- **Three different "CPU" numbers, and none of them is interchangeable.** `loadAvg` is a **count
  of runnable (and D-state) tasks**, so `1.00` is one core's worth and `0.06` on a 24-core box is
  ~4% busy; `os.cpus()` deltas give the **share of the whole machine** (0–100); a server's
  `cpuPercent` is summed over its **process tree**, so 400% is four cores and entirely normal. The
  global page drew the load count in a dial beside the memory percentage, so the host read `0.06`
  while the per-server figures read `400%` and the two looked like a contradiction. The dial is now
  CPU utilisation (`cpuUsedPercent`), load is a labelled number with its per-cpu value, and the
  per-server charts scale to `cpus × 100` rather than clipping at 100.
- **A reading and its own chart are one verdict, and a fourth copy is what drifts.** `ServerDetail`'s
  cpu chart was scaled to `cpus × 100`, and the **number directly above it** kept the fixed
  `toneClass(cpuPercent, 40, 80)`; the helper's comment on the chart said the bands scaled with the
  machine, so the drift sat inside a docstring that claimed otherwise. Measured on a 24-core host: a
  server at `1000%` — a sixth of the box — painted its number `--danger` while the sparkline beneath
  it stayed `--accent`, and the list row one click away agreed with the sparkline. Nothing failed,
  because the rule was correct in three places. The fix is `src/shared/cpu-scale.ts`
  (`cpuCapacity`/`cpuBand`), read by all four surfaces, and `test/shared/cpu-scale.test.ts` walks
  every UI source for a restated `Math.max(100, …)` and for a cpu value compared against a literal
  pair. Two cautions from doing it: an absent reading needs its **own band** (`unknown`), or the
  helper quietly answers `ok` for a stopped entry; and the per-core thresholds are the same numbers
  at one core, so a test asserting `40%` of one core is `ok` fails for the wrong reason — `40%` was
  always the warn edge.
- **A process tree's CPU cannot be differenced as two sums.** The tree is not a fixed set of pids:
  a wrapper respawns its worker, so "sum the cumulative seconds over whatever is in the tree now"
  is not comparable with the previous sum. Measured against a wrapper respawning a 1.5 s worker,
  **two samples in three were discarded** because the child's exit made the sum drop and the
  negative delta was thrown away — the gaps a user sees on a live server. The baseline is now the
  **whole process table**, and `treeCpuUsedSeconds` sums only pids present in the new scan
  (`test/providers/proc.test.ts` pins the arithmetic directly; a live scan cannot).
- **A number the UI shows must be comparable with the numbers beside it.** A percentage tile next
  to a count tile is a bug even when both are correct, because a person reads the shape, not the
  label.
- **A scrape is a reader with no page to qualify it, so an absent series is the only honest "no
  reading".** `HostMonitor` starts from `emptyHostView()`, which answers `sampledAt: null` and every
  value `0`; `/api/metrics` published those zeros, so a fresh panel — or one with host vitals
  switched off — served `hh_host_memory_used_percent 0` and `hh_host_load1_per_cpu 0.000`. A
  homelab alert rule (`memory > 90`) cannot tell that from a healthy idle box, and it stays silent
  for ever. The host gauges are now published only once `sampledAt !== null`, which is the rule the
  per-server ones already followed. The same round found the scrape had never published
  `cpuUsedPercent` at all, so the **only** host CPU figure a dashboard could reach was the load
  count — a different unit, which the UI section above had already fixed for the page.
- **The rule was only ever enforced where it was written, so the pages kept printing the frame.** The
  scrape was fixed and the UI was not: a never-sampled panel rendered memory `0.0%`, swap `0.0%`,
  `0.00` load and a green `quiet` chip in noc-console's vitals page, and `mem 0%` / `swap 0%` in the
  rail that is on every screen — the same fabricated zeros the route refused to publish, shown to
  the person instead of the dashboard. Two tiles were already gated (`cpuUsedPercent`,
  `tempCelsius`) and four were not, because "no reading" was a line in a route rather than a decision.
  It is `hostReadings` (`src/shared/host-readings.ts`) now, and the four host surfaces across both
  UIs read it. Two cautions: the frame's fields stay `number` on the wire, because an overridden
  older UI under `.hh/.ui` calls `.toFixed()` on them — the absence is decided where it is rendered,
  never by making the DTO nullable; and a **sampled** box honestly measuring `0%` must survive as
  `0`, so the predicate gates on `sampledAt`, not on the value being zero. A scan walks every `.vue`
  for `(host?.memoryUsedPercent ?? 0)` because the next surface is the one nobody declared.
- **A docstring that describes the fix is a claim, and the body can still hold the old number.** The
  per-cpu load bands were `2` and `1.4` in two noc-console surfaces. That is `hostSchema`'s
  **default**, so the copy is invisible on a fresh config and wrong on any other: with
  `host.loadPerCpu` at 4, `sampleHost` notifies at 4 and the tile painted `danger` from 2.5 —
  a verdict on a threshold nobody chose, for an alert that could not fire. The docstring above one
  of the two said "the bands now follow the configured alert threshold (default 2/cpu), which is the
  number the panel itself notifies on", which was true of the *intent* and false of the code; the
  default in the prose is what made a reader believe it. The frame carried no threshold at all, so
  neither surface could have followed one — when a comment claims a value comes from config, check
  that the value is reachable from where the code sits before trusting the sentence. The fix ships
  `loadAlertPerCpu` on the view, `loadBand` beside `hostReadings`, and `LOAD_ALERT_PER_CPU_DEFAULT`
  as the schema's default, so the number has one home. Three cautions: `0` disables the alert in
  `sampleHost`, so nothing can breach it and the band is `ok` — not a colour a reader has to
  interpret; an older panel sends no threshold, so it gets the default
  it alerted on rather than `undefined` propagating into a comparison; and a `loadRatio ?? 0` that
  sizes a **bar** is not this defect — it picks an empty bar, not a colour — so the scan matches
  comparisons only.
- **The fix that named the class still left one instance, and the reason is worth keeping.** After the
  load and the three percentages got predicates, the **disk** bar kept `band(percent, 75, 90)` in both
  noc-console surfaces, and the stock `Gauge`/`Meter` carried the same pair as *component defaults*
  (`warnAt: 75, dangerAt: 90` — since removed: `tone` is now required on both, so a call site cannot
  omit a verdict and the component cannot compute one). That is `hostSchema`'s default
  `diskUsedPercent: 90`, so — exactly as
  with the load — the copy is invisible on a fresh config and wrong on any other. Measured with the
  alert at **80**: `sampleHost` notifies at 82% and every surface painted that number `warn`, on the
  one reading where a late warning costs a full filesystem. Two things made it survive the round that
  fixed its neighbours. First, `host.diskUsedPercent` had **never been put on the frame**, so no
  surface *could* have followed it — the previous fix added three thresholds and did not audit the
  fourth reading for one. Second, the copies were not literals beside a component call; they were the
  component's own **defaults**, which read as "the component's business" rather than as a restated
  rule, and a scan for a comparison against a number cannot see a default declared in another file.
  So the band rides on **each disk** (`HostDiskReading.band`, `hostReadings`) rather than in one
  `diskBand` beside `memoryBand`: the reading is per path and a frame carries several, and one
  frame-level band would have answered for whichever path it happened to name. The general lesson is
  the audit, not the fourth patch — when a paragraph in `AGENTS.md` claims a *set* of readings
  follows a rule, enumerate the set against the frame and against every surface.
- **The band and the scale are two decisions, and a guard on one hid the other.** The temperature
  reading got a `tempBand` decided by the frame's `tempCelsiusAlert`, and the tests that pinned it
  mounted the real components and read the `stroke-*` class each dial drew. So every *colour* was
  right on both stock surfaces while the *needle* was not: `InstrumentCluster` scaled its dial by the
  frame's threshold, and `HostVitalsPanel` still had `(readings.tempCelsius / 85) * 100` inline in its
  template — `hostSchema`'s default. With the alert raised to 95, one frame at 60 °C drew arcs of
  `101.19` on the rail and `113.10` on the card. noc-console's rail had a third shape: it sized its
  bar by the °C value itself, `clamp(tempCelsius, 0, 100)`, which is a 0–100 °C scale and a share of
  nothing. Three lessons. A colour assertion cannot see a geometry bug, so a dial needs one test that
  reads the **arc** (`stroke-dasharray`) rather than the class. A percentage has a natural full scale
  of 100 and a temperature does not, which is why only this reading grew a scale of its own — the
  `percentageBand`/`tempBand` machinery was correct and simply does not answer "how full is the
  dial". And the inline-template copy is the hardest to grep for: it sat in a `:value=` expression,
  not in a `computed`, so a scan listing surface *helpers* would have found nothing. The successor is
  `tempDialPercent` (`src/shared/host-readings.ts`), read by all three surfaces, and its scan matches
  the arithmetic rather than the name.
- **A `_total` that can go down is not a counter.** `hh_server_restarts_total` was the retry budget
  spent on a server's *current* crash sequence, and a start someone asked for resets it to `0`
  (measured: `2` → `0` on a manual start), so `rate()` saw a counter reset every time an operator
  touched the entry; its HELP text had also claimed "since the control plane started", which was
  never true. The name *was* the lie, so it went: the series is `hh_server_restarts` now, and the
  HELP says a manual start resets it. The audit for the same defect found `hh_servers_total`, which
  is the configured-entry **count** — adding or removing an entry moves it down — so it is
  `hh_servers`. Nothing in `/api/metrics` is a counter: every value is a snapshot, which is why the
  scrape test enumerates the names and fails any `_total` or `# TYPE … counter`.
- **A compose stack is not a process tree, so a memory ceiling on one watched nothing.** `docker
  compose up` is a wrapper; the containers it starts are in another namespace, not among its
  descendants. Measured: a stack whose container burned 99% CPU / 20.7 MB reported `cpuPercent: 0,
  rssBytes: 68 MB` — the wrapper — so `resources.maxRssBytes` on such an entry could never fire for a
  leaking container: a memory guard that silently does nothing. The sampler now asks `docker stats`
  for the project's containers and sums them, attributed by compose's labels (`com.docker.compose.
  project`, else `…project.config_files`) rather than by the whole machine. Three limits are
  deliberate and stated in `src/providers/docker.ts`: a shell that runs docker is not detectable
  (`command` must be docker itself); `docker run` has no project to attribute by; and when docker
  cannot be asked the process-tree reading of the wrapper is kept, because no reading must never
  become `0` — a zero is what an idle stack looks like. `docker stats --no-stream` costs ~2 s of
  wall time per call (measured), so it is batched over all containers and cached for 10 s, the same
  discipline `SWAP_CACHE_MS` applies to the host's swap read.

## Config

- **Check the order, not just the presence, of a size limit.** `Content-Length` is a header a
  **chunked** request does not send, so a bound enforced after `parseBody()` is a memory limit, not a
  guard — both upload routes read the header *and* use `bodyLimit` from `hono/body-limit`, which counts
  chunks and aborts at the cap.
- **`cookieSecure: auto` depends on srvx, not on this repo.** `secureCookie` reads
  `new URL(c.req.url).protocol`, and behind a proxy that is `https:` only because srvx rewrites
  `url.protocol` from `x-forwarded-proto` when `trustProxy` is on
  (`srvx/dist/_chunks/_trust-proxy.mjs`) — so the session cookie's `Secure` flag on a proxied panel
  rests on a dependency's internals. Verified by reading it, not assumed; if a srvx upgrade changes
  that, the flag silently stops appearing and only a browser would notice.
- **A workspace's config is re-read whenever its files change on disk**, and the watch is on the
  *directory*: an editor's save is a temporary file renamed over the target, so the inode changes
  and the name does not. A two-second poll backs it up where `fs.watch` is undependable. The store
  compares the bytes it last read and the bytes it wrote, so the panel's own saves never reload.
  A revision it cannot read — **unparseable JSON included** — is reported in the state frame while
  the running config is kept; that path once fell back to an *empty* config, which would have
  stopped every server.

- **A header is a byte string, and a stub cannot make it one.** HTTP header names and values are
  visible ASCII / Latin-1, so `Title: 🔴 server down` throws inside `Headers` — and the test asserting
  that header passed only because a stub replaced `fetch`, so the fixture *was* the bug. Validate at
  the door (`headerProblem`/`parseHeaders`) so a save is refused with the line named instead of a
  `ByteString` engine message landing on a person's row, and treat a header name as case-insensitive:
  a configured `Content-Type:` must **replace** the transport default, never be spread beside it into
  `application/json, application/json` (`test/services/notifications.test.ts`).
- **A summary line that disagrees with the lines above it is a bug.** `migrate` printed "nothing to
  migrate" after lifting three files, because only the stamp-only path was counted — and that line
  exists so a person knows whether to run it again. Count every outcome a command can have.

## UI

- **A rendered fallback can live in the script, not the template.** The render scans read what a
  template *renders*, which made `?? 0` inside a `computed` invisible: `OverviewView` summed a
  workspace's live CPU with `total += liveReadings(server).cpuPercent ?? 0` and rendered
  `{{ liveCpu.toFixed(1) }}%`, so the template held only a local's name and the fabricated `0.0%`
  sat one file above it. Two things followed. The scan now reads the initializer of every local a
  rendered expression names, so a fallback anywhere on the chain is seen — and an **aggregate** got
  the same treatment as a reading: `sumReadings` answers `null` when any member has no sample,
  because a workspace total is a reading of the set and one entry without a sample makes the set
  unmeasured. That case is real on every start, since `proc.sample` has no CPU window on its first
  sample, so a workspace whose only server had just started claimed a measured `0.0%`. A total of
  zero entries is a genuine `0` — the surface beside it says nothing is running — and so is a
  measured `0`.
- **Watch the *session*, not the flags derived from it.** With authentication off, `authRequired` and
  `authenticated` are both `false` from first paint to last, so a watcher on those two never fires
  after the session lands — the stream never opens. Both UIs derive one `streamDecision(session)`
  value (`wait` | `connect` | `login`) and watch that; the test pins the value, not the flags.
- **A form that copies live state guards per block, never globally, and copies detached.** Host
  thresholds and the backups policy arrive from `/api/settings` *after* the SSE frame, so one "has
  anything changed?" gate leaves them on schema defaults forever; and a shallow copy leaves a nested
  group (`health.http`) aliased to live state, so an edit mutates the very config the guard compares
  against. Each block keeps its own baseline.
- **An absolutely positioned element inside a *static* scroll container resolves against the page,
  not the scroller** — an `sr-only` label in a table row gave the document a second, empty
  scrollbar. The shell's `main` carries `relative`; keep it there.
- **A dialog's footer has to be a flex sibling of a scrolling body**: the sheet is `flex flex-col`
  with `max-h-[88dvh]`, the body `min-h-0 flex-1 overflow-y-auto`. With the max-height on the body
  alone, a tall form pushed its own save button below the clipped edge — the dialog looked like it
  had no save button.
- **Vue does not notify a computed's subscribers when its recomputed value is `Object.is`-equal**,
  so anything mutated in place silently freezes every value derived from it. The log buffers hand
  out a **new array per batch**; the `version` counter exists only to make views re-read at all.
  A test that reads the array itself will not catch this.
- **A component you assume is thin may not be.** UI tests live in `uis/<name>/test/`: pure modules on
  node, and a component worth guarding mounts under `// @vitest-environment happy-dom` (see
  `number-field.test.ts`). `NumberField`'s setter assumed the string a text input reports, but Vue
  casts `<input type="number">` to a *number* first, so `raw.trim()` threw and **every value typed
  into a numeric field was silently discarded** — no pure-module test could see it. The suite resolves
  `@/…` from the UI that asks, so each UI's tests import its own components; a single pinned target
  once resolved a `noc-console` test's `@/lib/proxy` to *stock's* differing copy without a murmur.

- **A UI cannot translate a string the panel already formatted.** The panel composes some display
  text itself — a backup entry ("Global settings"), why a restore skipped a row ("not selected").
  Sending only that English leaves it English in every language, which is how it was reported. The
  fix is the `STATUS_META` pattern one level down: the panel sends a catalog key beside the text,
  and the UI resolves the key and falls back to the text. The key is optional, because a new UI
  meets an older panel; the text is required, because the reverse happens too.
- **`Intl` beats a catalog for numbers, dates and durations.** Word order, abbreviations and plurals
  come free and need no translator. Two traps: `numeric: 'auto'` turns an age into `yesterday`, which
  is not an age, so `always`; and `narrow` unit style falls back to Latin in Japanese (`1h 30m`
  rather than `1 時間 30 分`), so non-English uses `short`. English keeps `narrow` because `short`
  would change text that shipped as `12s ago`.
- **A plural rule is per language, not per message.** The i18n library's built-in rule indexes forms
  by count, which is an English shape: Russian's `21` and `5` then read the same form. `plural.ts`
  resolves the CLDR category through `Intl.PluralRules` instead.
- **A lifecycle refusal is not the `DetailedError` envelope.** The API answers two shapes and both
  are real: a thrown `DetailedError` is `{ message, code, detail }`, while `start`/`stop`/`restart`/
  `free-port` answer `{ ok: false, error }` with a 409 (`actionAnswer`/`statusForAction`). Both UIs'
  action helpers read only `message`, so "port 3000 is already in use (pid …)" showed as
  `request failed with 409` in the toast while the card beside it printed the sentence in full. The
  CLI read `error` first and had always been right. One reader (`failureMessage`) plus a source scan,
  because a unit test cannot see a call site nobody has written yet.
- **A lazily-loaded catalog must never block the mount.** It is a network fetch, and a rejection that
  skipped the mount is a blank page with no way back. English is bundled, so `main.ts` mounts in
  `finally` and the worst case is an English panel.
- **A row that scrolls with no signal is a clipped row, and a shrinkable flex child lies about its
  height.** The noc-console had an `860px` breakpoint that reflowed correctly and was still unusable
  at 390 px, for four reasons worth keeping apart. The nav and the status line both scrolled
  horizontally with nothing to say so — `overflow-x: auto` answers "can this be reached", not "does a
  person know to try"; the nav wraps now (a wrapped label is visible, a scrolled-past one is not) and
  the shortcut hint is gated on `hover: hover` rather than width, because a narrow desktop window
  still has a keyboard. A `.view__head` with `min-height: 38px` and no `flex: none` kept that 38 px
  while its wrapped lines painted over the table below it: **chrome is not content, so it does not
  shrink**. And a wide table scrolled away its two most important columns, so the identity and action
  cells are `position: sticky` with an opaque background — `background-attachment: local, scroll`
  draws the edge shadow only on the side that still has content, with no script.
- **A guard can read the comment instead of the rule.** Two scans written this round passed their own
  mutation because they searched the whole file: a `min-width: 22px` assertion matched nothing until
  comments were stripped, and a `button.nav__item` selector assertion matched the selector named in
  the explanatory comment above the rule. A source scan must match a parsed *selector list* or rule
  body, and the mutation is what proves it does.
- **A scan is only as good as its matcher and its corpus — and a green scan says neither.** The
  plain-object scan (`test/shared/ui-parity.test.ts`) reported exactly one holder while a copy sat
  *inside* it twice over. Its pattern was a module-level `const … /g` passed to `.test()`: a `/g`
  regex is **stateful**, because `.test()` advances `lastIndex` and the next call resumes from there.
  It matched `src/shared/shape.ts` at offset 1037, then skipped a copy planted at the top of the next
  file in walk order, which starts before that offset. And its walk accepted only `.ts`/`.tsx`, so a
  copy in a component's `<script setup>` was never read. Both stayed green on the real duplicate. Two
  rules follow: **build the pattern where it is used** (or drop `/g`; `matchAll` is the one that wants
  it), and **plant a copy in each shape the scan claims to read** — one assertion that names the only
  allowed holder cannot tell "there is one definition" from "the walk never looked".
- **A scan that forbids one *spelling* passes the moment that spelling is deleted — including the
  delete that should have failed it.** `test/shared/ui-readings.test.ts` asserted the literal
  `ring.cpu, server.resources?.cpuPercent` was absent from noc-console's sampler. The commit that
  routed the sampler through `liveReadings` rewrote the line to `live.cpuPercent ?? 0`, so the old
  pattern could never match again: a guard that still ran and could no longer fail. The defect it
  named survived the rewrite in the same expression, because `?? 0` coerces an absent reading into a
  measured-looking zero. Two rules follow. **Assert the shape, not the text it used to be written
  in**: read the pushes out of the source (`pushCapped(ring.(\w+), (.*))`) and require each value to
  be the predicate's own field with no fallback, which catches `?? 0`, `|| 0` and any future spelling.
  And **a guard that names a defect must be re-broken after every refactor of the code it guards** —
  a scan whose mutation no longer reaches it is worse than no scan, because it reports done.
- **A rule every surface already knows is still only enforced by a scan of the surfaces.** "A
  destructive action confirms in a popover" was in `AGENTS.md`, `ConfirmButton` existed in *both*
  UIs, and every settings section used it — except the one that deletes the uploaded UI, which
  renamed its own button (`Revert to stock` → `Confirm revert`) and fired `DELETE /api/settings/ui`
  on the second press, deleting a build with no archive of it. The twin surface in `noc-console`
  had always used the popover, so review read the diff as fine. A documented rule plus a shared
  component is not a guard: nothing read the components that *did not* use it. The scan now reads
  every `.vue` in both UIs for the shape (a label chosen by a `confirm*` flag, a handler that raises
  that flag and then calls the action), and its own narrowing is on record. **The first version
  matched a fixed list of flag spellings** (`confirming\w*|armed\w*`) and let a renamed
  `confirmArmed` through until the re-break named it — so match the word in any name, not the name
  you chose. **The second version then matched only the declaration form**: `function askRemove() {}`
  was read and `const askRemove = (): void => { confirming.value = true; emit('remove', …) }` was
  not, though Vue treats them as the same click handler, and `ref<boolean>(false)` was not a ref
  either. A comment claiming "a handler that raises the flag and acts" is a claim about *every*
  spelling an author may write. **And a flag name is not the rule.** Reading the *branch* instead —
  `if (!flag.value) { flag.value = true; …; return }` followed by the action on the next press — needs
  no name at all, and it catches the pre-`c83a9e6` armed revert under any rename. A detector that
  needs a `confirm` in the identifier is defeated by calling the ref `asking`, which is a rename, not
  a fix.

- **A source scan's matcher is a claim about every spelling, and its comment stripper is a claim
  about the corpus.** Four guards here audited as decoration in one sitting, each for its own reason:
  `test/shared/host-readings.test.ts` read only `{{ }}`, so a `?? 0` in a `:display` prop stayed green
  — a fabricated `0 °C` in the tile that exists to warn about heat; `test/shared/ui-readings.test.ts`
  read only `liveReadings(...)`/`live.` literally, so a reading destructured out
  (`const { responseMs } = liveReadings(server)`) or reached through a second `computed` was invisible,
  and `:title="`probe ${responseMs ?? 0} ms`"` stayed green; `test/shared/ui-parity.test.ts` claimed
  "no string here contains `//`", which the corpus already contradicted — `uis/stock/src/i18n/index.ts`
  holds `'../../i18n/generated/**/*.json'`, so its block pattern opened at that `/*` and closed at the
  end of the *next* comment, deleting the `createI18n(...)` call between them, and a real
  `structuredClone` planted there stayed green; `uis/stock/test/clipboard-source.test.ts` matched
  `navigator.clipboard` literally, so `navigator['clipboard']` and `const { clipboard } = navigator`
  both walked past it. Each was found the same way — **break the thing in the source and watch the
  file** — and each fix reads the *reach* rather than a spelling: `test/helpers/template-render.ts`
  collects every rendered expression (`{{ }}`, `:x`, `v-bind`, `v-text`, `v-html`) and leaves
  `:style`/`:class` out because a bar's width is not a number on screen;
  `test/helpers/strip-comments.ts` walks the source tracking code/string/template/regex, and reads a
  `.vue` as markup plus `<script>` blocks, because `placeholder="http://10.0.0.5:8080"` in a template
  made the line pattern truncate the rest of the line. A guard that reports a `:line` must keep the
  line count while blanking comments — both helpers replace comment characters with spaces for that
  reason. **The same audit found the helper's own users had not replaced every copy.** Seven scans
  still carried a local regex, and each was driven with a plant the round could not explain away:
  six went green on a real violation. The shape is always the same — the corpus supplies an
  *unclosed* opener (`'src/*.ts'`, or a `'/*'` in CSS `content`) that pairs with a later real
  comment, or a `//` in a URL that the line pattern reads as a comment — and the statements in
  between vanish. `test/shared/cpu-scale.test.ts`, `uis/stock/test/toast-copy.test.ts` and
  `uis/stock/test/commands-in-copy.test.ts` each stayed green with a planted per-core band, a
  planted English toast and a planted `pnpm run` under exactly that shape; `test/services/state.test.ts`
  and `test/helpers/paths.test.ts` stayed green on a planted orphan export whose file began with the
  glob; `test/shared/ui-tap-targets.test.ts` and `uis/noc-console/test/mobile-layout.test.ts` stayed
  green on a rule pinned under the tap floor and on a `display: none` in the wrong tier. A CSS scan
  needs a parser, not a stripper: `cssRules` returns each rule's selector list and the `@media`
  tiers it sits in, so `ruleIn(rulesIn('(width <= 860px)'), '.nav')` cannot be fed a comment or a
  quoted brace.

- **A browser API that needs a secure context is absent on the origin the docs promise.** The panel
  is documented as a plain-`http://` LAN page, and `navigator.clipboard` does not exist there: measured
  `undefined` from `http://192.168.1.201:6181` and `object` from `http://127.0.0.1:6181` on the same
  build, so all nine `CopyButton` sites threw into a `catch {}` and left the icon alone — a dead
  button holding the previous clipboard contents. Guard the *feature*, not the call: `copyText`
  (`uis/stock/src/lib/clipboard.ts`) uses the Clipboard API where it exists and `execCommand` inside
  the gesture where it does not, and returns a verdict so the button can say `common.copyFailed`.
- **A row of chrome must be measured at the narrow viewport with the tap floor counted.** `pointer:
  coarse` raises every icon control to 44 px, so a `shrink-0` cluster of four targets plus a 96 px
  labelled trigger is 326 px — 6 px wider than a 320 px phone, `header.scrollWidth` 326 against 320 —
  and the title (`flex-1`, the only child allowed to give way) collapsed to **0 px**. Both
  declarations are pinned by `uis/stock/test/topbar-width.test.ts` because no mount can measure a
  layout.
- **A page served only through a CDN is blank on the box this package is for.** `/openapi/ui` was
  `Scalar()` alone, whose entire body is a module import from `cdn.jsdelivr.net`; with every
  non-panel request aborted, `#app` held **0 children and 0 characters**, while the same page pulled
  30 off-origin requests and a 754 KB bundle when it could. `docs/UI_CREATION.md` point 5 already
  said an offline home server should not need a CDN. Render real content from `spec.json` first
  (`src/openapi-reference.ts`), then load the richer browser as optional enhancement inside a
  `try {} catch {}`. The rule generalises to any dependency that renders only via the network.
- **"That library cannot work offline" is a claim about its *integration*, and it needs a measurement
  before it becomes one about the library.** The paragraph above is what the Hono middleware does, and
  it is real — but a follow-up round nearly wrote it up as a Scalar limitation, which is false:
  Scalar's `dist/browser/standalone.js`, served from the panel, renders the whole reference with the
  network blocked (**998 characters, 0 errors, identical to online**; the only off-origin requests are
  two `fonts.scalar.com` woff2 files, non-blocking). So the honest statement is "4.9 MB to self-host,
  which is a bad trade for this panel", not "it only works online". Both readings justify the same
  code; only one of them survives being checked, and the wrong one would have deleted a dependency
  that a different design could have kept. When a dependency's docs offer a self-hosted variant
  (`cdn:` pointing at a local file, a `bundle` build, a vendored asset), download it and drive it
  offline before deciding the library is at fault.
- **An enhancement fetched at page load is pinned, and the pin is guarded.** `src/openapi-reference.ts`
  imports `@scalar/api-reference@<version>/esm.js` from jsDelivr; a floating `@scalar/api-reference`
  would let any upstream release restyle, break, or add a request to the panel's own page with no
  commit here — a supply-chain edge that the panel otherwise does not have. `test/api/panel.test.ts`
  asserts the served HTML names an exact `x.y.z` (broken deliberately → fails on the unpinned form),
  so the pin cannot be dropped back to `latest` without a red test.

## Data

- **A restore must never match an archived data path against another workspace's declaration.**
  `matchTarget` fell back from "this workspace declares this origin" to "some workspace declares this
  origin" and then to "this absolute path matches", so an archive naming a workspace the target lacked
  wrote that workspace's data over whichever directory another one declared. Two items also collapsed
  onto one id, so one workspace's data never restored at all. Those fallbacks exist for a re-labelled or
  re-ordered config; they are now filtered to the entry's own `workspace`, and an unknown one is
  reported instead of guessed at.
- **The workspace registry travels in the archive.** Without `.hh/workspaces.json` a restore onto a
  blank host could not create a workspace it does not have, so a multi-workspace archive silently
  restored only the one that already existed. It is captured unconditionally — a few ids and labels —
  and a created workspace is registered only *after* its leaves land, so it exists with content or not
  at all. The new paths come from `BackupSources.dataRoot`, not the module-level path helpers: those
  reflect `HHOSTED_HOME` at import time, not the panel that is running.
- **`reloadAll()` must itself start the autostart entries it revealed.** `store.load()` resets the
  byte baseline `ConfigWatch` compares against, so the poll that follows reports "no change" and the
  autostart pass in `handleConfigChange` never runs. A restored entry therefore waited for a panel
  restart, against the README's "autostart entries come up immediately".
- **An archive's configs need lifting, not just reading.** The three readability gates in
  `BackupService.restore` asked "can this release parse it?", and the parsers refuse an older
  `meta.schema` by design — so the schema an archive was written with decided whether its *config*
  restored at all. A real 0.7.21 archive applied to a blank 0.10.0 home reported "restored 4 items"
  and every one was a secret leaf: the global settings, the workspace's settings and its
  `servers.config.json` were each dropped as "not valid", which is a half-restored setup reading as a
  success ("a refused operation is a failure, never an empty success"). `liftArchived` runs the same
  chain `migrate` runs, on the archive's contents, and the **lifted** file is what gets written and
  stamped — the archive's own bytes would restore a file this release immediately refuses. The newer
  direction is still a refusal, decided from the manifest before any of this. The gap was structural:
  every restore test built its archive with `schema: CONFIG_SCHEMA`, so no test could see an older one.
- **A force restart must announce its outcome, not only its start.** The restart resets health to
  `unknown`, so the `unhealthy -> healthy` transition that sends `recovered` never happens and a
  successful recovery sent nothing — "came back fine" and "came back broken" read the same. `Entry`
  carries `pendingRestart`, set where the restart is decided and cleared both where the entry is first
  seen serving and where it gives up, so a stale flag cannot announce a recovery that never happened.

- **Generated directories are skipped by the `filter` handed to `fs.cpSync`**, matched on an exact path
  *segment* at any depth: `dist/` and `app/node_modules/` go, `distributed/` and `my_node_modules/`
  stay. Only paths an entry declares are filtered; a global `backups.includePaths` entry is captured as
  it stands. `.git` is deliberately **kept** — a package manager can reinstall `node_modules`, nobody
  can restore a commit that was never pushed.
- **Two guards sit on the backup path and only one of them runs.** `declaredData` marks a path
  `included: false` when it contains the archive directory, so the copy never starts; the check inside
  `copyInto` is a second line that route does not reach. Grep the caller before trusting the guard you
  found.
- **Compare a secret with `secretEqual`, never `!==`** — `!==` short-circuits at the first differing
  byte, so a caller who can time a response recovers the secret one byte at a time. The `/_hh` channel
  is the case that matters: it sits outside `/api`, so the run.json token is the only guard, against a
  local user who cannot read the 0600 file but can time a request. `src/helpers/secret-compare.ts` also
  carries the length check that keeps a truncated header from making `timingSafeEqual` throw a 500.
- **A credential must not follow a redirect off its origin.** `downloadToTemp` sends the GitHub token
  with `redirect: 'follow'`, and an asset URL can 302 to a CDN; it is safe only because undici drops
  `authorization` cross-origin — a runtime property, not this code's, so the test drives two real
  loopback servers (a stubbed `fetch` cannot answer it).
- **Server args are logged *before* `${VAR}` expansion**, so an expanded secret never reaches the log
  buffer, disk, SSE or Telegram.
- **A certificate is valid only *inside* its window.** `validatePair` checked `validTo` alone, so a pair
  whose `notBefore` was in the future was stored and made the panel restart onto HTTPS, where every
  browser refuses it. Both ends are checked in one `validityError()` that `status()` uses too;
  `keyMatches` stays separate, because a window problem must not read as a key mismatch.
  `-not_before`/`-not_after` need OpenSSL ≥ 3.2, so those tests sit behind `hasOpensslExplicitDates`
  (probed: macOS ships LibreSSL).
- **A removed server must take its per-id artifacts with it.** `sync()` left `<id>.log` and its
  rotations on disk, and re-adding an id served the *previous* server's lines — nothing distinguishes a
  stale file from a current one. `logFiles.clear()` and `HistoryStore.forget()` now both run in that
  branch (a config that fails to parse keeps the last trusted list, so a bad edit is not "all servers
  removed"). Check both stores when adding a third per-id artifact.
- **A dependency order must be topological, and the doc must not overstate it.** `dependenciesOf`
  pushed each dependency *before* recursing, so `startDependencies` could start a server with its
  dependency down; `orderByDependencies` was always right and the two now agree. "Stopped in reverse
  order" was true of `stopAll` only — stopping one does not cascade; `dependentsOf` names the dependents
  a stop leaves running.
- **Normalise a route path in one place, not two.** `ProxyService.pathKey` strips trailing slashes and
  refuses `/app` + `/app/` as a clash, while `matchFor` in `proxy-config.ts` built matchers from the raw
  value — so `/app/` produced `['/app/', '/app//*']` and Caddy, matching `path` exactly, never matched
  the `/app` the panel reported as covered.
- **A URL scheme you do not support is a mistake, not a hostname.** `parseUpstream` prefixed a bare
  string with `http://` after testing only `^https?://`, so `ftp://x.com` became `http://ftp://x.com`,
  which `new URL` parses as hostname **`ftp`** — reported `status: 'ok'` with the engine handed
  `ftp:80`. Reject any explicit non-http(s) scheme before prefixing; the same function validates at save
  time, so the refusal reaches the user.
- **Uptime is windowed, so clip each run to the window.** `Math.min(runtimeMs, windowMs)` only stopped a
  run *exceeding* the window, never looked at *when* it happened, so a 24h run that ended 12h before
  `now` reported **100% up**. Clip the start against the window's own start
  (`event.ts - Math.max(event.ts - runtimeMs, since)`). The test that should have caught it asserted
  `1` — a test can codify the bug.
- **`EPERM` from `process.kill(pid, 0)` means the process is ALIVE, not gone** — a port holder owned by
  another user is exactly that. One definition (`providers/port.ts`), re-exported by `helpers/daemon.ts`;
  a second copy that returned `false` is the first line of `nannyIsAlive`, so a live nanny reads as
  absent and `resumePersistent` starts a **second** copy. New liveness checks go through that one
  function.
- **A state file is not proof a process is ours.** `ProxyService.stop()` signalled whatever pid
  `.proxy/proxy.json` named, and `PROXY_ID` is the constant `proxy`, so a leftover record could name an
  unrelated live process. It now asks what the supervisor, `down` and the install guard ask —
  `nannyIsAlive` (fresh heartbeat, marker, or nanny argv) — and keeps the record when a pid outlives
  `SIGKILL`. Any path that reaches a pid from a file does the same; liveness alone is not identity.
- **Removing a workspace must not delete the state file a surviving process is found by.** `stopEntry`
  keeps a persistent entry's nanny state **on purpose** when its pid outlived SIGKILL, and that file
  lives at `workspaceStateDir(id)` — *inside* `workspaceDir(id)`, which `PanelService.remove()` deletes
  recursively. `remove()` now refuses while a stop reports `survived the stop`.
- **The nanny's `pending` slot is unreachable, and the ordering is what makes it so.** `runNanny`
  installs its SIGTERM/SIGINT traps and only then spawns, with nothing awaiting in between, and Node
  runs a signal handler only *between* synchronous runs. It is kept as the ordering made visible, and
  `test/services/nanny.test.ts` pins the ordering (traps before spawn, no `await` in the window) rather
  than the branch — insert an `await` there and `pending` becomes live.
- **`serve({ tls })` throws synchronously on a pair whose key does not match** — not a rejected
  `ready()`, so `listenWithRetry` cannot treat it as a bind failure and the panel does not boot
  (`ERR_OSSL_X509_KEY_VALUES_MISMATCH`). A pair also reaches disk by hand-copy or a restore, and
  `save()` cannot be atomic across two files, so `TlsStore.servable()` validates before handing anything
  to the server and falls back to http with a warning. `status()` reports the mismatch as an `error`
  too, or `keyMatches: false` with a null error reads as "enabled and fine".

- **A retention knob bounds the directory, not the number a loop renames to.** `keep` is how many
  rotations a person agreed to store, so three readers must agree with `readdir`: the list, the size
  and the tail. `rotate` only renames *up* to the ceiling, so lowering it left `.5`…`.10` on disk
  where nothing listed them, nothing read them and a `clear` did not remove them — a search answered
  "no matches" for a line that was there, and the page's "on disk" total named the newest file alone.
  Derive the set from the directory once (`ownedFiles`/`retained`, `src/services/log-files.ts`) and
  prune inside `rotate` (`test/services/log-files.test.ts`).
- **A file a route hands back is streamed, and the bound decides how much it matters.** `logs.maxBytes`
  allows **100 MB per rotation** and `keep` holds ten, so the log download is the largest thing this
  panel serves. `readFileSync` measured **+199 MB RSS** for one download and **+402 MB** for four at
  once, with `/healthz` going 4 ms → p95 859 ms / max 898 ms and headers only arriving after the whole
  read; the archive route with the same four downloads grew **+2 MB** and answered p50 17 ms.
  `createReadStream` + `stat` for the `Content-Length` a progress bar needs, in both routes. A
  comment that excuses one route by its schema ceiling is how the other stayed broken — a 100 MB
  ceiling *is* the size a person downloads a log at.
- **A generated config must say what it means for every branch, not only the one it names.** Caddy's
  automation policies are subjects: a name **no policy names** does not get "no automation", it gets
  Caddy's default — the public CA. Excluding local-only names from the ACME policy (right: Let's
  Encrypt answers `rejectedIdentifier` for `.lan`) therefore also required *naming them* in the
  internal one, and nobody did: measured `{"subjects":["hh-fallback.invalid"],"issuers":[{"module":
  "internal"}]}` for a `.lan` route, every HTTPS request failing `tlsv1 alert internal error` while
  the page said "signed by the engine's own CA", and the cleartext port 308'd into that dead
  handshake instead of serving the notice page. The second half is the same class: a state describing
  something that has not happened is a promise, so `certificateFor` decides `local` from the leaf in
  the store, not from the hostname's shape. Two tests pinned the wrong shape and now pin the right
  one (`test/services/proxy-config.test.ts`, `test/services/proxy.test.ts`).

## Schemas and types

- **`instanceof type.errors`, never `instanceof Error`,** for a schema result: ArkType's errors are
  not `Error`s, so `x instanceof Error` is false for a valid *and* an invalid payload. Six tests
  asserted `expect(schema(v) instanceof Error).toBe(false)` as a conformance check and could never
  have failed. Pass the real `type.errors` plus `JSON.stringify(x)` so a failure prints the payload.
- **ArkType: an optional property (`'x?'`) rejects an explicit `undefined`** — omit the key. Fields
  a UI must clear are `'type | null?'`.
- `ServerView.config.port` is normalized to `number | null`; the hand-narrowed types in
  `contracts.ts` are deliberate.
- **`onUndeclaredKey('ignore')` does not reach a nested group.** Giving a *response* schema an ignore
  variant has to be `onDeepUndeclaredKey('ignore')`: the outer call only tolerates unknowns at its own
  level, while the child still `.reject`s its own extras. `backupScheduleViewSchema` exists for this —
  `backupsViewSchema` carrying the config `backupScheduleSchema` rejected a frame whose
  `schedule.scope` a newer panel had added, blanking the backups page. Any response schema with a
  nested strict group needs the deep variant, and a test that puts an unknown key at *both* levels.
- **A list paired with the structure that reads it must be checked with a *mutation*, not a reading.**
  `parseGrouped` reports a key absent from `keys` as "unrecognized — this release ignores it" while the
  loop below still parses that group, so one missing entry yields a config that works and a warning
  saying it does not. Both are plain arrays, so nothing caught it: adding a group the list did not name
  gave 0 typecheck errors and 0 test failures. **Count the errors a removal produces, and note where
  they come from** — a guard made of test literals is not the same as one made of production code.

