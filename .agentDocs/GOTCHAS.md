# Gotchas — traps and their causes

**Goal:** the non-obvious failures this codebase has already paid for, so they are not repeated.
**Scope:** one line of trap and rule per entry. Rules already stated in `AGENTS.md` are not repeated
here. The measured story behind an entry lives in the commit that fixed it:
`git log -S'<identifier>'` finds it.

Format: `- **<trap>** — <rule>. (<file>; <test>)`

## Process and platform

- **A closed pipe reader is reported as a write `EPIPE`, and an unhandled stream error kills the CLI**
  (`status | head -1` exited 1 under `pipefail`) — `treatClosedReaderAsDone()` is installed once in
  `main()`, exits 0, and rethrows anything but `EPIPE`. (`src/cli/io.ts`; `test/cli/epipe.test.ts`)
- **`node_modules/.bin/tsx` is a `#!/bin/sh` shim Windows cannot start, and the test reads empty
  streams** — tests spawn `process.execPath --import=tsx` through the one launcher.
  (`test/support/run-cli.ts`; `test/cli/cli-launcher.test.ts`)
- **`node_modules/.bin` holds `foo`, `foo.cmd` and `foo.ps1`** — `resolveCommand` tries the
  extensioned shims first and never falls back to the bare POSIX script. (`src/providers/process.ts`)
- **A text read that slices on `'\n'` bleeds into the next block on a CRLF checkout** — normalize line
  endings and throw when a boundary is missing.
- **A Windows editor writes a BOM or UTF-16, and a `'utf8'` read has already destroyed the bytes that
  tell them apart** — every hand-editable file, JSON or not (an `envFile` read as UTF-16 silently lost
  every key to a NUL), goes through `readStateFile`. (`src/helpers/config-text.ts`)
- **A file capability (`setcap cap_net_bind_service`) makes a process non-dumpable**, so `lsof`/`fuser`
  and `/proc/<pid>/environ` see nothing — an empty holder list is not a free port; identify the
  panel's own engine from records it wrote. (`src/services/proxy.ts`)
- **A basename is not an identity, and an empty argv word is a word** — the basename fallback applies
  only while one side is bare; `/proc/<pid>/cmdline` keeps `''` arguments, or every word after one
  shifts. (`processArgv`, `sameWord`; `test/providers/identity.test.ts`)
- **`spawn` reports a missing `cwd`, a missing program and a pasted command line as the same
  `ENOENT`** — `describeSpawnError` checks in that order, and suggests splitting only when the first
  word resolves. (`src/providers/nanny.ts`)
- **`run.json` is the daemon's identity and `down`'s credential** — keep `runtimeSchema` in step with
  the `Runtime` written in `src/index.ts`.
- `vite.server.config.ts` targets `node22` while `engines` requires >= 24 — deliberate margin.
- **`pnpm run media` needs Playwright's Chromium, which `pnpm install` does not fetch** — run
  `pnpm exec playwright install chromium`; a bare container also needs fonts (`FONTCONFIG_PATH`) and
  the X/NSS/Mesa libraries, or Skia panics. (`scripts/capture-media.mjs`)

## Supervision

- **The tick never awaits a stop or restart** — it held every entry's probes for a stop grace. Use `restartInBackground`; skip entries already `stopping`/`starting`. (`supervisor.ts`; `supervisor-tick.test.ts`)
- **Every helper child goes through `spawnManaged`** — a bare `spawn` misses `needsShell` (a `.cmd` throws EINVAL) and its own process group. (`supervisor/spawn.ts`)
- **`nannyStateSchema` rejects undeclared keys** — a new nanny-state field makes an older panel read the file as missing and spawn a twin. The child's birth bound is the state's `startedAt` (`nannyChildPid`).
- **"Crashed while away" is reported only from boot** (`resume({ reportAway })`, passed by `startAll`); a user's Start/Stop consumes the record silently.
- **Overlapping `start`/`stop` double-spawn or resurrect** — `start()` sets `starting` before its first
  await, and `stopping` is cleared on every exit path of `stopEntry()`. Tests call
  `supervisor.dispose()`. (`src/services/supervisor.ts`)
- **A timer or `void`-ed promise without `.catch` is an unhandled rejection, which ends Node 24.**
- **An adopted process is not a `ChildProcess`** — nothing reports its exit (the tick polls liveness)
  and its output is not captured, except a persistent entry's, through its nanny's JSONL.
- **The argv identity fallback is what `reclaim` kills by** — compare image and arguments literally,
  two matching holders block, and keep one resolver (`resolveSpawn()`); a second one that expands
  args differently reopens stranger matches. (`src/providers/identity.ts`)
- **`HHOSTED_SERVER_ID` carries no workspace**, so a service copied into a second workspace is
  identical by marker and argv — "is this pid ours?" is a panel-wide question: the panel injects
  `siblingServers` and refusals name `workspace/server`. (`src/services/panel.ts`)
- **A persistent entry has three lifetimes** — the nanny exits with its child; a stop reaches the child
  by pid from the state file; the traps (`NANNY_TRAPPED_SIGNALS`) arm before the child exists, with no
  `await` before the spawn. Reattach needs liveness with start time, a fresh heartbeat and the
  marker or argv, never the heartbeat alone (it is written into the file, not by the pid).
  (`src/services/nanny.ts`; `test/services/nanny.test.ts`)
- **Whether the nanny forwarded a stop follows the configured signal, not the terminator's label**
  (`SIGKILL` always reads `force-killed`) — signal the child when the signal is outside
  `NANNY_TRAPPED_SIGNALS` or the stop escalated. (`src/providers/nanny-sweep.ts`)
- **A hand-picked state signature publishes nothing for the field it forgot** (sampling switched off
  changed only `enabled`) — sign whole views; a transition test must publish the state before it.
  (`stateSignature`, `src/services/panel.ts`)
- **A host read on the frame path is paid per entry, per second** — cache it on its own clock, cache
  only a success (`windowsProgramData`, `lanAddress`), and expose a `forget*()` seam for tests.
- **Startup is dominated by module load** — `up` defers the daemon graph until it has decided to
  detach; a "slow" start is the import graph, not a loop.
- **A compose entry's containers outlive its wrapper** — a stop resolves `composeTarget` and decides
  from a fresh listing, never the signal or `docker stop`'s exit code; a survivor is a `conflict`.
  (`src/providers/docker.ts`)
- **A notification throttle window armed by a failed send silences the next alert** — the send gives
  back only the deadline it armed (`releaseCooldown`). (`src/services/notifications.ts`)
- **A WSL2 guest exposes no temperature**, and Windows' `MSAcpi_ThermalZoneTemperature` can be a
  constant 20 °C — `n/a` is the honest default; the LibreHardwareMonitor helper is opt-in.
  (`src/providers/wsl-temperature.ts`)

## Metrics

- **Three CPU numbers are not interchangeable** — `loadAvg` is a task count, `cpuUsedPercent` a share
  of the machine, a server's `cpuPercent` a process-tree sum (400% is four cores).
- **A reading's absence, band, scale and aggregate each have one home** — see [`READINGS.md`](READINGS.md).
- **A guard asking "did we spawn it?" skips every adopted process** — liveness is
  `child !== null || (adopted && pid !== null)`, never how the entry became ours.
- **A refusal naming a pid does not name the row** — attribute the holder from the walk that decided
  it was ours (`processTreeOwners`), never a second scan. (`src/providers/proc.ts`)
- **A compose stack is not a process tree**, so the wrapper's reading watched nothing — sample the
  project's containers via one batched, 10 s-cached `docker stats`, attributed by compose labels; when
  docker cannot answer, keep the wrapper's reading, never `0`. (`src/providers/docker.ts`)

## Config

- **The save baseline moves only with the object a save patches** — advancing it on a read let the next save overwrite a hand edit with a typo. (`assertSaveable`; `test/config`)
- **A read-only caller loads a store with `{ write: false }`** — `load()` seeds missing files otherwise. New dirs under `.hh` go through `ensureStateDir()` (0700), never a bare `mkdirSync`.
- **`reloadAll()` must not call a bare `settings.load()`** — that skips the exposure guard a hand edit meets.
- **A chunked request sends no `Content-Length`** — bound uploads with `bodyLimit`, before the body is
  parsed.
- **`cookieSecure: auto` rests on srvx rewriting `url.protocol` from `x-forwarded-proto` when
  `trustProxy` is on** — recheck on a srvx upgrade; only a browser notices the flag vanishing.
  (`src/helpers/cookies.ts`)
- **An editor's save is a rename over the target** — watch the directory, back it with a poll, and
  keep the running config (reported, not emptied) when a revision does not parse.
  (`src/services/config-watch.ts`)
- **A header is a Latin-1 byte string and names are case-insensitive** — validate at save
  (`headerProblem`), and a configured `Content-Type` replaces the default. A stubbed `fetch` hides it.
  (`test/services/notifications.test.ts`)

## UI

- **With auth off, `authRequired` and `authenticated` never change** — watch
  `streamDecision(session)`, not the flags.
- **A form copying live state guards per block and copies detached** — `/api/settings` lands after
  the first frame, and a shallow copy aliases nested groups.
- **An absolutely positioned element in a static scroller resolves against the page** — the shell's
  `main` keeps `relative`.
- **A dialog's footer is a flex sibling of the scrolling body**, or a tall form hides Save.
- **Vue skips a computed whose value is `Object.is`-equal** — hand out a new array per batch; a test
  reading the array cannot see it.
- **Vue casts `<input type="number">` to a number**, so a setter calling `.trim()` dropped every value
  — mount the component (`happy-dom`) for anything with a setter. (`uis/stock/test/number-field.test.ts`)
- **A UI cannot translate text the panel formatted** — the panel sends an optional catalog key beside
  the required text, and the UI falls back to the text.
- **`Intl` beats a catalog for numbers, dates and durations** — `numeric: 'always'`; non-English uses
  `short` unit style (`narrow` falls back to Latin in Japanese).
- **A plural rule is per language** — `plural.ts` resolves the CLDR category through `Intl.PluralRules`.
- **A lifecycle refusal is `{ ok: false, error }`, not the `DetailedError` envelope** — every failed
  response is read through `failureMessage`. (`src/shared/api-client.ts`)
- **A lazily loaded catalog must never block the mount** — `main.ts` mounts in `finally`; English is
  bundled.
- **Chrome is not content, so it does not shrink** — a header row gets `flex: none`; a horizontal
  scroll with no signal is a clipped row.
- **`navigator.clipboard` does not exist on a plain-`http://` LAN origin** — copy through `copyText`
  (`execCommand` fallback) and report the verdict. (`uis/stock/src/lib/clipboard.ts`)
- **`pointer: coarse` raises icon targets to 44 px** — check a header change in a real browser at
  320 px with a coarse pointer; a class test cannot measure layout.
- **A page rendered only through a CDN is blank offline** — render from `spec.json` first, enhance
  optionally, pin the enhancement to an exact version, and measure a library offline before blaming
  it. (`src/openapi-reference.ts`; `test/api/panel.test.ts`)
- **Source scans** — three rules:
  1. Read the construct (the call with its arguments, the tag to its own `>`, the depth-counted
     region), never one spelling, and prove the scan with a mutation planted in each shape it claims
     to read; re-break it after every refactor of what it guards.
  2. Strip comments only through `test/helpers/strip-comments.ts` (and CSS through `cssRules`) — a
     hand-rolled stripper eats code at the first `/*` in a string.
  3. A `/g` regex is stateful under `.test()` — build it where it is used; and walk `.vue` as well as
     `.ts`.

## Data

- **A `catch`/`finally` cleanup does not survive a kill** — a temp directory a crashed run can leave
  is named with the owner's pid, and swept when that pid is dead. (`sweepStaging`,
  `src/services/backups.ts`)
- **A restore matches an archived path only against its own workspace's declarations**, and an
  unknown workspace is reported, not guessed. (`matchTarget`)
- **The workspace registry travels in the archive**, a created workspace is registered after its
  leaves land, and restore paths come from `BackupSources.dataRoot`, not the import-time path helpers.
- **An archive's configs must be lifted, not just parsed** — `liftArchived` runs the `migrate` chain
  and the lifted file is written; build restore fixtures at an older schema too.
- **`reloadAll()` resets the watcher's baseline**, so it must start the autostart entries itself.
- **A force restart resets health to `unknown`** — `pendingRestart` is what announces the outcome.
- **The backup copy filter matches generated directories by exact path segment**; `.git` is kept.
- **A secret is compared with `secretEqual`, never `!==`.** (`src/helpers/secret-compare.ts`)
- **A token sent with `redirect: 'follow'` is safe only because undici drops `authorization`
  cross-origin** — test it with two real loopback servers. (`downloadToTemp`)
- **Server args are logged before `${VAR}` expansion**, so a secret never reaches logs, SSE or Telegram.
- **A certificate is valid only inside its window** — `validityError()` checks both ends; OpenSSL
  < 3.2 (macOS LibreSSL) lacks the flags the tests use (`hasOpensslExplicitDates`).
- **A removed server takes every per-id artifact with it** (`logFiles.clear`, `HistoryStore.forget`) —
  a third per-id store joins that branch. (`test/services/supervisor.test.ts`, "a removed server")
- **A route path is normalised once** — `pathKey` and the Caddy matcher read the same form.
- **`EPERM` from `process.kill(pid, 0)` means alive** — one definition (`providers/port.ts`).
- **A state file is not proof a process is ours** — check `nannyIsAlive` before signalling a pid read
  from a file (`ProxyService.stop()`).
- **Removing a workspace deletes its state dir**, which can hold the only record of a survivor —
  `remove()` refuses while a stop reports one. (`PanelService.remove()`)
- **`serve({ tls })` throws synchronously on a mismatched pair** — `TlsStore.servable()` validates
  before serving and falls back to http. (`src/services/tls.ts`)
- **A retention knob bounds the directory, and every writer lowers it** — derive the set from
  `readdir` (`ownedFiles`/`retained`), prune inside `rotate`, and call `pruneLogs` on every path that
  can lower `keep` (`PanelService.pruneLogs`). (`src/services/log-files.ts`; `test/services/log-files.test.ts`)
- **A served file is streamed** (`createReadStream` + `stat`) — a log download can be 100 MB per
  rotation.
- **A Caddy name no automation policy names gets the public CA** — local-only names are named in the
  internal policy, and `local` is decided from the stored leaf, not the hostname.
  (`src/services/proxy-config.ts`; `test/services/proxy-config.test.ts`)

## Schemas and types

- **`jsonBody(x)` / `resolver()` builds `x`** — at module level it undoes lazy loading; use a getter (`ERROR_RESPONSES`). (`test/shared/lazy.test.ts` imports every route module)
- **A long-lived connection re-checks its credential without sliding the session** (`{ slide: false }`), or an open tab keeps an idle session alive. (`src/helpers/event-stream.ts`)
- **With `trustProxy: true`, srvx's `req.ip` is client-chosen** — never key a security limit on the address alone.
- **A module-level schema is `lazy(() => type(…))`, and nothing at module level calls one** — building
  every contract at import cost ~1.2 s per CLI command and test child. A schema method at module level
  or a `.default(…)` inside `lazy` silently undoes it. (`src/shared/lazy.ts`; `test/shared/lazy.test.ts`)
- **ArkType errors are not `Error`s** — assert `expect(x).not.toBeInstanceOf(type.errors)`; an
  `instanceof Error` check passes for valid and invalid input alike, and copies of it keep turning up
  in tests.
- **An optional property (`'x?'`) rejects an explicit `undefined`** — omit the key; a field a UI must
  clear is `'type | null?'`.
- `ServerView.config.port` is normalized to `number | null`; the hand-narrowed types in
  `contracts.ts` are deliberate.
- **`onUndeclaredKey('ignore')` does not reach a nested group** — a response schema with a nested
  strict group needs `onDeepUndeclaredKey('ignore')`, tested with an unknown key at both levels.
  (`backupScheduleViewSchema`)
- **`merge` keeps the argument's `onUndeclaredKey`** — `extra.merge(strict)` is strict and
  `strict.merge(extra)` is not, so a query schema puts the strict workspace schema last.
  (`workspaceQuerySchema`)
- **A key list paired with the parser that reads it drifts silently** (`parseGrouped`) — check such
  pairs with a mutation, not a reading.
- **A test for "which stream" keeps stdout and stderr apart** and asserts the other one is empty.
- **A pure-function test does not pin its call site** — the already-running `up` conflict check stayed
  green with its wiring deleted; one test runs the real `up` against a real `run.json`.
  `--no-autostart` stays accepted there. (`test/cli/server-action.test.ts`)
