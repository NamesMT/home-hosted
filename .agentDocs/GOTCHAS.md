# Gotchas — traps and their causes

**Goal:** the non-obvious failures this codebase has already paid for, so they are not repeated.
**Scope:** traps and the reasoning behind a non-obvious choice. Hard rules that must never be
broken are stated in `AGENTS.md` too — this file carries the *why*, and the ones that need it.

Most entries are a cause, not just a symptom. Where the symptom alone is enough to act on, it is a
line in `AGENTS.md` instead.

## Process and platform

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
- **The per-second tick is not worth optimising.** `getState()` and the 40-pid `sampleMany()` are
  cheap next to anything else in the loop; the state is published only when its signature changes and
  resources are sampled every 5 s. Measure elsewhere first.
- **Startup is dominated by module load, not by work.** `src/app.ts` and the schemas it pulls in cost
  over a second to import, so `up` defers the daemon graph until it has decided to detach, and the
  daemon child inherits `process.execArgv` — under tsx it re-compiles that graph, under the built CLI
  it does not. A "slow" startup is the graph, not a loop.

## Metrics

- **Three different "CPU" numbers, and none of them is interchangeable.** `loadAvg` is a **count
  of runnable (and D-state) tasks**, so `1.00` is one core's worth and `0.06` on a 24-core box is
  ~4% busy; `os.cpus()` deltas give the **share of the whole machine** (0–100); a server's
  `cpuPercent` is summed over its **process tree**, so 400% is four cores and entirely normal. The
  global page drew the load count in a dial beside the memory percentage, so the host read `0.06`
  while the per-server figures read `400%` and the two looked like a contradiction. The dial is now
  CPU utilisation (`cpuUsedPercent`), load is a labelled number with its per-cpu value, and the
  per-server charts scale to `cpus × 100` rather than clipping at 100.
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
- **A `_total` that can go down is not a counter.** `hh_server_restarts_total` is the retry budget
  spent on a server's *current* crash sequence, and a start someone asked for resets it to `0`
  (measured: `2` → `0` on a manual start), so `rate()` sees a counter reset every time an operator
  touches the entry. Its HELP text claimed "since the control plane started", which was never true.
  Pinned by the label the README now gives: `hh_server_crashes_24h` is the monotonic one.

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

## UI

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
- **A lazily-loaded catalog must never block the mount.** It is a network fetch, and a rejection that
  skipped the mount is a blank page with no way back. English is bundled, so `main.ts` mounts in
  `finally` and the worst case is an English panel.

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

