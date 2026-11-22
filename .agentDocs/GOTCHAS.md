# Gotchas — traps and their causes

**Goal:** the non-obvious failures this codebase has already paid for, so they are not repeated.
**Scope:** one line of trap and rule per entry. Rules already stated in `AGENTS.md` are not repeated
here; two that earned promotion to a Rule live there now (`{ write: false }` on a read-only store
load, under **State**, and the argument-of-`merge` strictness rule, under **API contract**). The
measured story behind an entry lives in the commit that fixed it: `git log -S'<identifier>'` finds it.

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
- **A user-level autostart entry needs no administrator on Linux and macOS, but every Windows task
  does** — `~/.config/systemd/user` + `systemctl --user` and `~/Library/LaunchAgents` + `launchctl` are
  per-account by design, while `schtasks /Create` needs elevation **even for a logon-triggered task
  running as the same person**. So Windows had no no-privilege form at all until `--startup`: a `.cmd`
  in `%APPDATA%\…\Startup`. Corollary that cost a rewrite elsewhere: the consumer plugin's
  `windows-run` (an `HKCU\…\Run` value) looks like pure footprint beside its scheduled task, and is
  not — it is the only thing that works unelevated, so removing it left `recommended: 'unsupported'`.
  Check what a mechanism buys before deleting it. (`src/cli/service.ts`)
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
- **A Node child that calls `process.exit` loses its own unflushed pipe output** — 64 KB of a 512 KB
  write reached the reader. A fixture whose output the test reads back sets `process.exitCode` and lets
  the process end instead, or the assertion races the pipe. (`test/services/nanny.test.ts`;
  `test/services/supervisor.test.ts`)
- **The WSL temperature helper is machine-wide, and a test that writes it breaks every home on the
  machine** — tests reach it only through `HHOSTED_TEST_PROGRAMDATA`, which `test-home.ts` points at a
  per-file temp directory. (`test/support/test-home.ts`; `test/support/real-home-guard.ts`)

## Supervision

- **The tick never awaits a stop or restart** — it held every entry's probes for a stop grace. Use `restartInBackground`; skip entries already `stopping`/`starting`. (`supervisor.ts`; `supervisor-tick.test.ts`)
- **Every helper child goes through `spawnManaged`** — a bare `spawn` misses `needsShell` (a `.cmd` throws EINVAL) and its own process group. (`supervisor/spawn.ts`)
- **`nannyStateSchema` rejects undeclared keys** — a new nanny-state field makes an older panel read the file as missing and spawn a twin. The child's birth bound is the state's `startedAt` (`nannyChildPid`).
- **"Crashed while away" is reported only from boot** (`resume({ reportAway })`, passed by `startAll`); a user's Start/Stop consumes the record silently.
- **Overlapping `start`/`stop` double-spawn or resurrect** — `start()` sets `starting` before its first
  await, and `stopping` is cleared on every exit path of `stopEntry()`. Tests call
  `supervisor.dispose()`. (`src/services/supervisor.ts`)
- **A sample or a reading written after an `await` re-checks the run token *and* pid** — a stop that
  lands mid-probe owns the entry by then, and a writing probe left the stopped entry publishing a
  container's CPU/RSS. Capture `runToken`/`pid` before the await and compare both after it, never the
  status alone. (`src/services/supervisor/health.ts`; `test/services/resource-sampling.test.ts`)
- **Only the nanny rotates `<id>.log` while its persistent run is alive** — both the panel and the
  nanny appended and both rotated on size, so the second rename moved the first one's fresh file into
  `.1` and pushed real history out. The panel appends with `{ rotate: false }` for exactly that window.
  (`src/services/log-files.ts`; `test/services/log-files.test.ts`, "appends without rotating when told
  the rotation is not its own")
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

- **A hand-written mirror of a schema drifts the moment the schema grows.** `isFrameShape` in
  `src/shared/live-frames.ts` re-implements `sseMessageSchema` for the lenient path — the
  older-UI-against-newer-panel case, where the strict schema refuses a frame because one *field* holds a
  value this build does not know. It had cases for `hello`/`state`, `server` and `log`, and **none for
  `ping`**, so it answered `false` for a keep-alive. Latent while the strict schema accepts a ping, and
  live the moment any other field of that frame is unknown: every keep-alive is then dropped and logged
  as "ignored malformed SSE frame". A type-level exhaustiveness check cannot help — the function takes
  `unknown` and returns `boolean`, so nothing forces it to grow. The parity is read from source in
  `test/shared/live-frames.test.ts` instead, scoped to the SSE block (scanning the whole file matched
  `'start'`, a lifecycle status in an unrelated schema).
- **A guard over a hand-written file list protects the files somebody remembered.** The `windowsHide`
  scan named 13 sources; a new `src/providers/zz-probe.ts` spawning `powershell.exe` with no flag
  passed it, verified by adding exactly that file. It now reads every `.ts` under `src/`. This is the
  same shape as `SHIPPED`, `IN_REPO`, `SOURCES` and `stateSignature` before it — when a guard needs to
  cover "every X", discover the X.
- **The Windows console-window effect cannot be observed from WSL.** Tried: `MainWindowHandle` (0 both
  ways — console windows belong to `conhost`, not the child), `GetConsoleWindow()` in the child (0 both
  ways — no console in this context at all), and enumerating visible windows via `EnumWindows` (PowerShell
  script execution is refused with `UnauthorizedAccess` here). `conhost.exe` appears as a child either
  way; only its *visibility* differs, and visibility is what a headless context lacks. So `windowsHide`
  stays verified by source scan plus the documented `node:child_process` behaviour, and the guard being
  complete is what carries the weight — say so plainly rather than implying it was run on Windows.
- **`stateSignature` is `JSON.stringify(state)`, and it must stay that way.** A hand-written list of
  "the fields that matter" was wrong four times — `apiTokenSet`/`passwordSet`/`allowedHosts`, the host
  view's `enabled`, `backups`' policy, the proxy's `certificates`, and `ui.meta`'s `uploadedAt`/`files`/
  `tag`/`asset`/`unix`. Each fix widened the list and left the next field to be discovered the same
  way, by somebody noticing a stale page in a second tab. Signing the whole frame removes the list, so
  a new field is covered the day it is added. Cost: `JSON.stringify` of an eight-workspace,
  six-server frame is **0.009 ms** (8.6 kB), once per publish.
- **A hand-picked field list in `stateSignature` is a bug that waits for the right trigger.** The
  proxy was signed as `config.enabled`, status, engine and routes — which left out
  `config.certificates`, `certificates`, `dnsAccounts` and `engines`. With the engine **on**, storing a
  certificate calls `apply()`, the status moves, and the certificate rides along in the frame; with it
  **off**, nothing else moves and the upload publishes nothing, so a second tab keeps showing the old
  list. That asymmetry is why it survived: the first upload of a session looks fine. Sign the whole
  view — `JSON.stringify(state.proxy)` — as `control`, `host`, `backups` and each workspace now are.
- **A signature that signs a view must sign all of it — including the fields that look static.**
  `stateSignature` signed `backups.lastAutomaticAt` and `backups.scheduleError`, reasoning that "the
  archive list is a separate `GET /api/backups`". True of the *archives*, false of the *policy*:
  `enabled`, `keep`, `dir` and `schedule` live in that view and nowhere else, so a hand edit to
  `settings.json` reloaded the store — `panel.settings.backups.keep` became 9 — and then published
  **nothing**, because the signature was unchanged and `publishState` returns early. Every other tab
  kept drawing the old policy. `PATCH /api/settings` hides this, because that path usually moves
  something else in the same turn; a hand edit has no companion. Sign the whole view, as `control`,
  `host` and each workspace already are.
- **A size limit that only reads `content-length` has a door: `Transfer-Encoding: chunked`.** The
  guard's first version let an unsized body through, and that was exploitable, not theoretical — a
  hand-built chunked `POST` with a 3 MB `command` was accepted (`201`), written to
  `servers.config.json` (3 000 304 bytes), and the state frame became 3 005 852 bytes: the same DoS
  through the one door left open. **`transfer-encoding` is the discriminator** — srvx gives *every*
  request a body stream, so a bodyless `POST` and a chunked one are identical by that measure; only the
  chunked one carries the header. It is now refused `411 LENGTH_REQUIRED`.
- **`defaults` in the notifications block is ignored by any destination that carries its own toggles,
  and `useOwnSettings` defaults to `true`.** So a PATCH that sets `defaults.cooldownMs: 0` changes nothing
  for an existing destination: it keeps its own `cooldownMs` (schema default 120000) and throttles every
  crash to two minutes. The API then *reports* `defaults.cooldownMs: 0` beside a destination that is not
  using it, which reads as "the cooldown is off" when it is not.
  Set `useOwnSettings: false` on the destination to make it inherit — and the default is deliberate:
  before the block existed every target carried its own toggles, and reading one as "inherit" on upgrade
  would silently change what it delivers.

  Cost me several steps of thinking the delivery path was broken: the crash fired zero notifications
  while every reported field looked satisfied. Driving it with the destination set to inherit produced
  **3 of 3**. When a live behaviour contradicts the reported config, check whether a per-object override
  is shadowing the shared block before suspecting the code.

- **The release scripts were exercised without dispatching anything, and they hold.**
  `check-release-version.mjs` accepts `0.13.0 -> 0.16.0` and refuses a non-increase (`"0.13.0" is not
  greater than the current 0.13.0`), a downgrade and a non-version (`expected 1.2.3 or 1.2.3-rc.1`) — a
  check that accepts everything would be worthless, so the refusals were tested too.

  `release-notes.mjs` refuses to build a body when `CHANGELOG.md` has no `## v<version>` section, and its
  message names the real cause: it runs **after** changelogen in the workflow (line 145 against line 174),
  and changelogen writes that section. Since `CHANGELOG.md` has 57 sections and none for `0.16.0`, that
  refusal is the expected state before a dispatch, not a bug.

  Driven with a temporary section in place, the body came out **218 lines** and carried **all three**
  accumulated migrations — jobs leaving the server entry, the account model, and the exposure bar — which is
  the behaviour that matters: this branch has `package.json` at `0.13.0` while `UPGRADING.md` holds sections
  for `0.14.0`, `0.15.0` and `0.16.0`, so one dispatch ships three breaking changes and must print all three.
  `migrationsTo()` collects every section up to the version, compared numerically, and says in a comment
  that printing only the matching one *"is worse than printing nothing"*.

- **Every proxy write is refused before the engine binary exists — including a DNS-01-only change.**
  `apply`/`configure` call `installed()` (a `statSync` on `enginePath`) before anything else, so
  `PATCH /api/proxy` answers `400 ENGINE_MISSING` even for a settings change that needs no engine. That
  means the proxy config cannot be prepared ahead of installing it; the order is install, then configure.
  Not a defect — the page says **"No engine installed"** before a person tries to save — but it is the
  reason a scripted setup must install first.

- **The DNS-01 challenge endpoint refuses with `403 DNS01_DISABLED` before it asks for credentials.** That
  ordering is deliberate and commented: *"an absent lock must never read as 'no lock', because this endpoint
  writes records into somebody's zone."* So an unauthenticated caller on loopback learns whether DNS-01 is
  configured — a small disclosure, chosen over the alternative of reading "no credentials configured" as
  permission. `isLoopbackRequest` is checked first in the route, before any of this.

  Both flows need infrastructure this container does not have: driving the compose lifecycle needs a
  reachable docker daemon (`docker info` fails here) and a full ACME issuance needs a public name. Recorded
  so the next attempt does not rediscover that.

- **A legacy `.control-secrets.json` fixture must use **base64** for `salt` and `hash`, and the salt is
  decoded before use.** Two failed attempts to verify the credential migration were my fixture, not the
  code. `deriveKey` takes a `Buffer` salt (`hashPassword` does `salt.toString('base64')`), and the password
  is `normalize('NFKC')` before hashing. Writing the salt as a hex string, and hashing it as a string
  rather than decoding it, gives `verifyAccountSecret → false` with matching-looking
  `{N:16384, r:8, p:1}` parameters — which reads exactly like a broken migration.

  Built correctly, the documented migration holds: a real 0.13 password record signs in as account
  `default` with every scope (`200`), and `Authorization: Bearer <value-without-a-colon>` is refused
  (`401`), as `UPGRADING.md` says.

- **`refused` in `/api/meta` is about credential *kind*, not scopes — and the scope refusal lives in the
  403 instead.**
  A read-only session reports `refused: []` while being refused `403` on `POST /api/servers` and
  `PATCH /api/settings`. That reads as a bug and is not: `credentialRefusals(kind)` answers only "which
  moves would let a *token* replace the panel's owner", so a session is refused none of the seven, however
  narrow its scopes. `docs/API.md` says so, including the warning to read it as *"the moves that would take
  the panel over", never as reduced authority*.

  What a client actually needs is already there, and in a better place — the refusal itself:

      403 {"message":"this account has the read scope — POST /api/servers needs `config`",
           "code":"TOKEN_SCOPE","detail":{"needed":"config","held":["read"]}}

  Names the needed scope, the held scopes and the route. A `credential.scopes` field would not be more
  useful than this, and this one is specific to the attempt rather than the session.

- **The five open items this audit carried for months are all closed — do not re-verify them from the
  queue.** Each was checked this round rather than assumed:
  1. *"A fifth table ships a silent scroller."* Guarded twice. `uis/stock/test/mobile-layout.test.ts`
     scans every stock template and fails on any `overflow-x-auto` box lacking `scroll-hint-x`; verified by
     planting `uis/stock/src/views/ZzProbe.vue` with a bare scroller, which failed naming that file.
     `test/shared/ui-scroller-hint.test.ts` pins the other half for noc-console, where `.tblwrap` is the
     only scroller, plus an anti-vacuity check that a wrapper still exists. No shared directive is needed:
     the scan already makes the omission a test failure rather than a code-review question.
  2. *"No automated E2E."* `scripts/smoke.mjs` runs in CI on every push; it walks both UIs at two
     viewports, hit-tests, compares pixels, and (since this arc) **saves a settings form and reads it back**.
  3. *`pnpm: command not found` under a bare background job.* `resolvePnpm()` in `scripts/dev.mjs` finds
     pnpm beside `process.execPath`, and `childPath` puts that directory on every child's `PATH` — the
     grandchild problem, where pnpm's own scripts call a bare `node`. Verified with
     `env -i <abs-node> scripts/dev.mjs --help`, which prints the help and exits 0.
  4. *"Dev and built UIs are served from different places."* `docs/UI_CREATION.md` documents it, including
     the two settings that only matter in the dev server: `changeOrigin: false` (or the host guard answers
     `421`) and proxying `/healthz` and `/openapi`, not just `/api` (or those two reads get `index.html`).
  5. *"Release prep."* `check-release-version.mjs` and `release-notes.mjs` were exercised without
     dispatching; see the entry above.

- **`features` in `/api/meta` means "switched on", not "runnable", and `proxy` is not a settings-patch key.**
  Driven against a live panel: enabling the reverse proxy with no engine installed answers
  `400 ENGINE_MISSING` — a correct refusal — yet `features.proxy` then reads **true**, because the field is
  `settings.proxy.enabled` and the docblock says exactly that: *"`features` reports what is switched on"*.
  Reading it as "the proxy works" is wrong, and a client that gates UI on it should also check the engine.
  `ddns` is deliberately different: it is on when **any** workspace has it enabled, since the service is
  per workspace and any one of them starts a pass.

  `proxy` is **not** in `settingsPatchSchema` (that carries `control`, `host`, `backups` and the rest); it has
  its own `PATCH /api/proxy` and its own store slot. `panel.settings.proxy` reads `resolvedConfig.proxy`,
  so both agree — but a `PATCH /api/settings` carrying `proxy` is refused `proxy must be removed`, which
  reads oddly until you know the block lives elsewhere.

  Also checked while there: `errorCodes` serves **100** codes, unique, matching the catalogue exactly; and
  `GET /api/meta` derives its fields per request, so a settings save is visible on the next call.

- **The compose import carries no `environment`, deliberately — and that is not the same leak pm2 had.**
  `composeEntry` builds one entry, `docker compose -f <file> up`, and lets compose read the YAML itself; it
  never parses `environment`, so a `POSTGRES_PASSWORD` in a compose file stays where the person put it and
  the panel's config never sees it. The pm2 importer had the opposite shape — it *maps* `env` onto an entry
  — which is why that one leaked. Checked by driving both: a compose import with a password in it writes
  nothing but the file path, and the pm2 path now routes secrets to `secretEnv`.

- **A `load` hook runs only once the entry is _answering_, and a server that never binds its port
  therefore never loads.** Driven end to end: `dump` runs at backup time and its `{dumpDir}` is captured
  in the archive as `dumps/<workspace>/<id>/…` (verified by reading `db.sql` out of the zip), and restore
  refills that directory before `load`. But `runPendingLoad` waits on `portAccepts` first — so an entry
  declaring a `port` it never binds sits there until `hook.timeoutMs` (ten minutes by default) with
  nothing in the log. With a server that really listens on its port, the round-trip worked:
  `loaded.txt` held the dumped table.
  A portless entry waits `hook.waitMs` instead, which is the case the field exists for.

- **`GET /api/servers/:id` carries the hooks at `server.config.dump`, not `server.dump`.**
  Read `server.dump` and it is `undefined`, which looks like the view dropping it. `ServerView` is
  `Omit<…, 'config'> & { config: ServerConfig }`, so `dump`, `load`, `deploy` and every other entry field
  live one level down. Cost me a false "the view drops the hooks" conclusion before I printed the actual
  key list.

- **Restoring a backup rewrites `servers.config.json` from the archive**, so a hook edited after the backup
  is reverted by the restore. That is what a restore *is* — worth knowing before concluding a PATCH did
  not apply.

- **`down` refuses while a persistent entry runs, and that is the intended answer.**
  `home-hosted down` on a panel holding one exits with *"stop one with `home-hosted stop <id>`, or pass
  `--with-persistent`"* and leaves the panel up — so a script that treats `down` as unconditional will
  hang on it. `stop <id>` first, or pass the flag.

  Driven end to end: a `persistent: true` entry starts under a nanny (`__nanny --id keep --spec …`), and
  after `down` the **nanny and its child both keep running** — `keep.json` records `nannyPid` and
  `childPid`, and `pgrep -P <nanny>` finds the child. On the next `up` the panel **reports the nanny's pid**
  and starts no second copy. `supervisor-persistent.test.ts` already covers reattach, log replay,
  stop-all semantics and the orphan-spec sweep, so this is a documented behaviour rather than a gap.

  One caution when checking by hand: `pgrep -f setInterval` matches unrelated processes on a busy machine,
  and `pgrep -c` counts lines rather than confirming anything. `pgrep -P <nannyPid>` is the check that
  actually answers "is one server running".

- **The schema sweep continued past the five defects, and the rest of the surface holds.**
  After `expectStatus: 999` (this round's precedent), the neighbouring numeric and identifier schemas
  were swept the same way and are sound:

  - **server numerics** — `port` 0/70000/-1, `timeoutMs` 0/-5, `restart.maxRetries` -1, `restart.windowMs` 0
    are all refused, as are an empty `command` and an empty `id`;
  - **workspace ids** — the `/^[a-z0-9][a-z0-9_-]*$/` pattern refuses `../x`, `a/b`, `a b`, `""`, `a..b`,
    `-x`, `.hidden` and uppercase, so a workspace id can never name a path or a sibling;
  - **health intervals** — `intervalMs` and `timeoutMs` floors are enforced (`>= 500`, `>= 100`).

  `cwd: "../../etc"` **is** accepted, and that is correct rather than a gap: `resolveCwd` is
  `path.resolve(projectDir, cwd)`, and an entry's `command` is already arbitrary, so a `cwd` outside the
  project adds no capability the entry did not have.

- **The security predicates were brute-forced and hold — with the one exception already fixed.**
  After the `Host` userinfo bypass, every neighbouring predicate was probed the same way rather than
  assumed: `tokenScopesFor` classifies all nineteen risky method/path pairs correctly, and its
  completeness is already enforced — `token-scopes.test.ts` walks the published spec and fails if any
  `/api` route declares no scope, with four anti-vacuity assertions. `dialsPanel` recognises **every**
  loopback spelling including `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]` and the unbracketed
  `0:0:0:0:0:ffff:7f00:1` — its `isLoopbackAddress` was already right, which is what the `isLoopbackHost`
  fix brought the client's predicate up to. `hostnameOf`/`isAllowedHost` refuse twelve of thirteen
  hostile `Host` shapes; the thirteenth was the `@` form, now fixed.

  Two paths return `null` from `tokenScopesFor` (`PUT /api/auth/password`, `GET /api/health`,
  `GET /api/activity`) and **none of those routes exists** — only `DELETE /auth/password` is declared —
  so a `null` there is a speculative path, not an unchecked door. The spec walk is what would catch a
  real one.

- **`/openapi/spec.json` documents `/_hh` as well as `/api`, and it is accurate in both directions.**
  Measured on a built panel: 78 paths, 103 operations, of which 60 paths / 83 operations are `/api`.
  Driving every documented `/api` operation — substituting `{id}`/`{workspaceId}`/`{kind}` and sending
  an empty body — produced **zero** `404`s, so no path in the spec is a phantom. The reverse is covered
  by `test/api/spec-shape.test.ts`, which reads `src/app.ts`'s `.route(...)` mounts **independently of
  the spec** and fails in both directions, with `mounts.size > 5` so a broken scan cannot pass. That is
  the check to extend when adding a route, not a new one.

  `/_hh` appearing in the spec is deliberate — it is the CLI's channel and the doc says so — but a
  client author skimming `paths` will see it beside `/api` and may not notice it needs the `run.json`
  token rather than an account. It is not reachable with an account credential.

- **One macOS `config-watch` failure is an unowned `ECONNREFUSED 127.0.0.1:3000`, and the source is open.**
  `test/services/config-watch.test.ts > sees an external write` failed once on macOS with an
  `AggregateError` listing `connect ECONNREFUSED` to both `::1:3000` and `127.0.0.1:3000`. A re-run was
  green and the three runs before it were green. What is established, and worth not rediscovering:

  - `config-watch.test.ts` itself has no network code — only `fs`, `os`, `path` and `ConfigWatch`.
  - The stack shows the error surfacing **between** tests, not inside the failing one, so the test that
    reported it is probably not the test that caused it.
  - Nothing in `src/` opens a TCP connection to an upstream. `exposure.ts` resolves an upstream's
    hostname with `node:dns` `lookup`, which would not produce `ECONNREFUSED`.
  - `127.0.0.1:3000` appears only as a **fixture string** in `test/services/proxy.test.ts` (35 sites) and
    two UI component tests, none of which connects; `proxy.test.ts` never starts an engine.

  So the remaining candidates are a Node inspector/dev-server default or a stray listener on the macOS
  runner, not project code. Recorded as open rather than guessed at.

  **A second sighting, on Windows as well, added one thing and removed nothing.** Both platforms produced
  the identical `AggregateError` in the same run, which rules out "macOS runner quirk" but not much else.
  The two tests that actually *failed* that run were unrelated — two `panel.test.ts` message assertions
  pinned to a prefix `invocation()` had changed — so the `:3000` noise did not fail the job by itself; the
  job failed for a real reason and this printed alongside it. That is the most useful fact about it: **it
  is noise, not a failure**, and chasing it three times has cost more than it is worth until it is the
  only red line. `vitest run` is what CI invokes, the same as locally, and it does not reproduce here.

  **A fourth look ruled out the last project-side candidate.** `uis/stock/src/components/server/
  serverPresets.ts` really does default two presets (`node`, `gitea`) to port **3000**, which is the only
  place in the repo where that number is a *live* port rather than a fixture string — so it looked like the
  answer. It is not: the only test that imports presets (`uis/stock/test/server-presets.test.ts`) asserts
  the preset data and opens no socket, and it passes in isolation with no `ECONNREFUSED`. `test/support/ports.ts`
  also allocates test ports from **20000+**, deliberately below every OS's ephemeral floor, so nothing the
  suite starts can land on 3000.

  That leaves the conclusion unchanged and the candidate list shorter. **Do not look a fifth time** unless
  it becomes the only red line.

- **An SSE stream looks dead under a 3-second probe, and that is not a bug.**
  `PING_INTERVAL_MS` is 15 s (`src/helpers/event-stream.ts`), and a quiet panel publishes nothing in
  between, so a 3 s read captures exactly one frame (`hello`) and reads as "the stream is broken". I
  spent a pass on that before measuring over 20 s, where 4 frames arrived including a ping. Probe a
  stream for at least one full ping cycle, or you will diagnose the interval as a defect.

- **A workspace route is `/w/<id>/…`, not `/<id>/…` — and the wrong one silently shows a different page.**
  `/default/jobs` renders the **Servers** view (which then says "No servers anywhere yet"), so a browser
  check against it looks like a working page and reports nothing. The real table is in
  `uis/stock/src/router.ts`: `/w/:workspaceId/jobs`. The same file warns that a missing entry in
  `WORKSPACE_ROUTES` makes `/w/<id>/<unknown>` redirect to itself — an infinite navigation loop that
  locks the renderer — so a route typo here has two failure modes and neither is a 404.
  Cost me one wasted probe round: I read "no impossible row" as a rendering bug before checking the URL.

- **`migrate` prints "moving N job(s)" before it has asked, and writes nothing until you consent.**
  The line is unconditional — it is the *plan* — while `applyJobMove` sits behind
  `if (yes || HHOSTED_MIGRATE=allow)`. Run it non-interactively without either and you get
  `moving 1 job(s) … → jobs.config.json` and **no** `jobs.config.json`: the servers file is untouched
  and nothing is lost, but it reads exactly like a migration that ran and dropped the job. With
  `HHOSTED_MIGRATE=allow` the same command writes the file and prints `moved 1 job(s)`.
  I spent a while on this as a suspected data-loss bug before noticing `1 file(s) stamped` had not
  appeared either — the summary counts both halves, so a real run always says two things.

- **A DDNS failure is retried forever unless the provider sets `permanent`, and most do not.**
  `src/services/ddns.ts` reads `result.permanent` to end a record; a transient result is retried every
  interval. Of the 14 providers, only `cloudflare` and `duckdns` classified anything, and `noip`/`desec`
  inherit the `dyndns2` vocabulary — so a mistyped API token produced a failure line on the settings page
  indefinitely, with nothing saying the token was the problem. `wrote()` in
  `src/providers/ddns/types.ts` is where four REST providers end their write, so 401/403 are classified
  **once**, there: those two statuses mean "your credentials are wrong" for every one of these APIs,
  whereas 429/5xx are the provider's problem and 404 can mean a record not created yet — guessing at
  those would turn a temporary fault into a permanent one.

  **Still unclassified, knowingly**: `porkbun` (returns its own envelope, no status kept) and
  `namecheap-api` (its `request()` returns `string | null`, discarding the status before the caller can
  see it). Fixing either means changing what that helper returns, which is a larger change than the gap
  warrants right now; both need a real API key to test anyway. Recorded so the next person does not
  assume the classification is complete.
- **One Windows flake in `processTreeOwners` is unexplained, and my first explanation for it was wrong.**
  `proc.test.ts > processTreeOwners > includes a grandchild` failed once with
  `owners.has(process.pid)` unexpectedly `true` — the test's **own** process reported as a descendant of
  a tree it spawned. A re-run was green, and the three runs before it were green.

  I first wrote that a recycled pid explains it. **It does not, and the arithmetic is the reason**:
  `collectTree` only walks *down* from the root, so the test process can appear only if some row claims
  its parent is the spawned child. Recycling the *grandchild's* pid puts an unrelated process under the
  spawned child, not the test process under it. So the mechanism is still open.

  What has been checked, and ruled out: the walk only descends; `process.pid` as the *root* legitimately
  reports itself; 20 consecutive runs on Linux never reproduced it; and the Windows CSV parser handles
  both the `Get-CimInstance` and `wmic` column shapes correctly, including the `Node` column — so a
  shifted-column `ppid` is not it either, for these numeric-only columns.

  **Severity is lower than it first looked**, which is worth recording too: `processTreeOwners` feeds
  `port-preflight` only to *name* an owner in a refusal message (`heldByOurs`), and the kill paths take a
  live `ChildProcess` handle (`forceKillTree(child)`), never a pid from this map. So the worst case is a
  refusal naming the wrong server, not a process stopped in error. Left open rather than guessed at.
- **A spawn that never started reports differently from one that threw, unless you unify it.**
  `runBackupHook` wrapped the `catch` around `spawn(...)` as `could not start: <message>`, but its `error`
  listener reported `error.message` raw — and a missing binary arrives on the **`error` event**, not by
  throwing. So the same problem read two ways: `the dump hook for "hk" failed (spawn x ENOENT)` from one
  path and `(could not start: …)` from the other, and `hookFailure` puts that sentence straight in front
  of a person. The test asserting only `expect(result.error).toBeDefined()` could not see it. Both paths
  now produce the same sentence.
- **`hono/body-limit` is gone from this project, and the last copy was the one that mattered least.**
  The login route still had it after the upload routes were converted — a tighter 4 KB cap on the only
  unauthenticated endpoint. It *looked* safe because the panel-wide guard at `/api/*` refuses a chunked
  body with `411` before it runs, so the broken path was unreachable. Unreachable is not gone: it was the
  one remaining template for the next author to copy. All three now use `createBodyCeiling`, which counts
  the stream and takes its message and error code per route — `PAYLOAD_TOO_LARGE` for a login,
  `UPLOAD_TOO_LARGE` for an archive, because one code cannot describe both without reading wrong on one.
- **`hono/body-limit` cannot wrap an srvx request, and the unit suite cannot see it.** It re-wraps the
  request to re-read the stream — `c.req.raw = new Request(c.req.raw, init)` — and srvx's raw request
  carries a **relative** URL, so that constructor throws `Failed to parse URL from [object Request]`
  (`[cause]: Invalid URL`). Every **bodiless `POST`** then answers **500**: `start`, `stop`,
  `backup create`, the panel's core actions. The test fixture builds a plain `Request` with an absolute
  URL, where the same rewrap succeeds, so `makeFixture` was green throughout — measured against a built
  panel, not reasoned about. Teeing the body and draining one branch instead **hung** the request
  outright. The guard therefore reads the declared `content-length` only, and the residual gap (a
  hand-constructed chunked body) is written down rather than papered over.
- **An unbounded JSON body is a self-inflicted DoS, because the frame is every second.** A `POST
  /api/servers` carrying a 19 MB `command` was accepted and written to `servers.config.json`; the state
  frame then became **20 MB**, rebuilt every second and pushed over SSE to every open tab, and read back
  by `GET /api/settings` and the config editor. The caller is an authenticated admin, so the risk is a
  typo or a wrong paste rather than an intruder — and the panel is unusable from the moment it lands.
  `/api/*` now caps a JSON body at 1 MB (`src/middleware/body-limit.ts`), two orders of magnitude above
  a real request. **The two routes whose body is a file — `POST /api/backups/restore` and
  `POST /api/settings/ui` — are exempted by path**: a `use('/api/*')` middleware runs before their own
  `bodyLimit`, so without the exemption a 3 MB archive was refused by the 1 MB JSON ceiling.
- **The request path and the SSE fan-out are measurably cheap — don't "optimise" them on suspicion.**
  Measured on the built panel with nine workspaces and 54 servers: `GET /api/state` **mean 5.0 ms**
  (83 kB payload), `/api/servers` 2.4 ms, `/api/proxy` 2.2 ms, `/healthz` 3.2 ms; on an empty panel every
  route is ~2 ms. Eight concurrent SSE streams on the busy panel cost **3.6 CPU-ticks/s against 3.9
  idle** — nothing, because `serializeFrame` memoises per message in a `WeakMap` (`event-stream.ts`), so
  N subscribers sharing one frame serialise it once. Two things carry that: the WeakMap, and
  `narrowStateFor` running per connection rather than per frame. If a future change removes either, the
  fan-out becomes quadratic in open tabs — and no timing test here would notice, which is why the
  measurement is written down instead.
- **A wall-clock budget cannot detect a per-frame file read.** The obvious guard for "the state frame
  must not touch the disk" is to build N frames and assert they took less than some number of
  milliseconds. It does not work, and the measurement is worth keeping: 50 frames at eight workspaces
  x six servers took **0.77 ms each**, and after every frame was made to `readFileSync` a real config
  file it took **0.86 ms** — the same test, still green. The reads are page-cached, so the cost lands in
  syscalls and on a cold cache or a network mount, not in elapsed time. Scan the **function bodies**
  for the call instead (`test/services/frame-budget.test.ts`,
  `test/services/backup-frame-cost.test.ts`), which fails the moment the read appears. The same
  reasoning applies to any "this path must stay cheap" rule: assert what it *does*, not how long it
  seemed to take.
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
- **The docker cache answers only for the targets it asked about** — a cache filled for the entry due
  on one second stood in for a second entry due on another, so that entry never got a container
  reading and its memory ceiling could not fire. Ask about every live compose entry each tick, and
  treat a target the cached answer never covered as stale. (`src/providers/docker.ts`;
  `test/providers/docker.test.ts`, "refreshes inside the window for a stack the cached answer never
  asked about")
- **A cooldown is per destination and reason, not per state** — a state change swallowed by a running
  window is kept and sent when it ends, because a receiver left on the previous state reads a
  standing alert as a live one. (`src/services/notifications.ts`;
  `test/services/notifications.test.ts`, "sends the state the server is left in once the window ends")

## Config

- **The save baseline moves only with the object a save patches** — advancing it on a read let the next save overwrite a hand edit with a typo. (`assertSaveable`; `test/config`)
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
- **A store adopts a revision only once it parsed *and* passed the schema** — the pair (raw object,
  trusted bytes) moves together, so a save patches the object whose bytes it holds. Restamping the
  bytes of a file this release merely read is how an older panel rewrites a newer one; a revision with
  a schema problem is reported and never becomes the baseline. (`src/config/settings.ts`;
  `test/config/global-settings.test.ts`)
- **An unstamped file is pending only the migration steps for its own kind** — the chain is filtered
  by `ConfigMigration.kinds`, so a `servers.config.json` is not asked for a notification migration it
  never needed. (`src/config/migrations.ts`; `test/config/compat.test.ts`)
- **A query key the caller leaves out is not "no value"** — `requireWorkspace` resolves an omitted
  `?workspace=` to the panel's default, so a guard that reads only the key the client sent checks
  nothing on the requests that resolve to the one workspace it was meant to refuse. The workspace
  limit was advisory this way: a `staging`-limited account sent no key, fell through to `default`, and
  started that workspace's entry. Resolve the default in the guard and check *that*.
  (`src/middleware/token-scope.ts`; `test/middleware/token-scopes.test.ts`)

## Proxy

- **An unroutable route is left out of the render, never thrown for** — one broken or disabled route
  would otherwise take the whole table down, including routes to servers that are fine. Only a save
  refuses a route it adds or changes (`routeProblems`); a route that broke later is reported on its
  view. (`src/services/proxy.ts`; `test/services/proxy.test.ts`, "leaves an unroutable route out and
  keeps serving the rest")
- **A manual certificate is loaded by path, so the rendered configuration cannot carry its content** —
  a pair replaced in place rendered byte-identical JSON and the engine skipped the load. The
  certificate carries its content's fingerprint as a `tags` entry, which is what makes the render
  change. (`src/services/proxy.ts`; `test/services/proxy.test.ts`, "an uploaded pair replaced in
  place")
- **A host, a path and an upstream each have exactly one parser** — `routeHostKey`,
  `canonicalRoutePath` and `upstreamTarget` in `src/shared/proxy-form.ts`, shared by the clash check,
  the Caddy render and both UIs. A second spelling of "same host" or "same prefix" is how a route
  shadowed another. (`src/shared/proxy-form.ts`; `test/services/proxy-config.test.ts`)

## UI

- **A control that explains a field goes after that field, through the layout — not at the pane's end.**
  `FORM_LAYOUT` owns field order, so `FormSection.slots` names an anchor field and the renderer draws
  the entry point's markup immediately after it, inside the same grid. A section-level slot can only
  render after the whole block: the secret-values panel sat 1897 px below the names that declare it,
  which reads perfectly in a unit test that mounts the component alone. Assert position, and assert it
  in **every** UI — a scan pinned to one UI let the other drift. (`uis/noc-console/test/server-form-fields.test.ts`)
  The **jobs** sheet is the third place this rule binds: a job declares `secretEnv` exactly as a
  server does, so both UIs draw its value block under its names, and
  `test/shared/secret-env-layout.test.ts` scans the stock sheet too. A new sheet that grows a names
  field without a positional assertion is the next 1897 px.
- **A control that explains a field goes after that field, through the layout — not at the pane's end.**
  `FORM_LAYOUT` owns field order, so `FormSection.slots` names an anchor field and the renderer draws
  the entry point's markup immediately after it, inside the same grid. A section-level slot can only
  render after the whole block: the secret-values panel sat 1897 px below the names that declare it,
  which reads perfectly in a unit test that mounts the component alone. Assert position, and assert it
  in **every** UI — a scan pinned to one UI let the other drift. (`uis/noc-console/test/server-form-fields.test.ts`)
- **With auth off, `authRequired` and `authenticated` never change** — watch
  `streamDecision(session)`, not the flags.
- **A form copying live state guards per block and copies detached** — `/api/settings` lands after
  the first frame, and a shallow copy aliases nested groups.
- **A guarded fill may write only the fields its own guard covers.** The settings page guards
  Listener, Authentication and TLS separately because each has its own Reset, but all three share
  one `control` form object — so a fill that assigns a whole baseline writes the fields of the
  *other* groups too. `listenerBaseline()` carried `tlsEnabled` (the flag belongs to the `control`
  patch, not to the listener group), so every state frame reverted the HTTPS switch while it was
  being edited: the toggle flipped itself back about a second after being turned on. The fill and
  its guard are now one function, `syncControlPart()`, and each part's baseline carries exactly
  what that part's snapshot covers. The shape is the same as the webhook-list revert: a snapshot
  that does not cover everything the block writes silently un-guards it, and the reverse — a fill
  writing more than its snapshot covers — is the same bug from the other side.
  (`uis/stock/test/settings-tls-revert.test.ts`, plus the mounted case in
  `uis/stock/test/settings-pages.test.ts`; only the stock UI guards per part — the console guards
  the whole `control` block, so it cannot hit this.)
- **An absolutely positioned element in a static scroller resolves against the page** — the shell's
  `main` keeps `relative`.
- **A dialog's footer is a flex sibling of the scrolling body**, or a tall form hides Save.
- **Vue skips a computed whose value is `Object.is`-equal** — hand out a new array per batch; a test
  reading the array cannot see it.
- **Vue casts `<input type="number">` to a number**, so a setter calling `.trim()` dropped every value
  — mount the component (`happy-dom`) for anything with a setter. (`uis/stock/test/number-field.test.ts`)
- **A UI cannot translate text the panel formatted** — the panel sends an optional catalog key beside
  the required text, and the UI falls back to the text.
- **`Intl` beats a catalog for numbers, durations and relative times — but not for dates.** A **date**
  is ISO, `YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS`, from `formatDateIso`/`formatDateTimeIso` in
  `src/shared/ui-format.ts`, in the host's timezone, identical in both UIs and the CLI. Formatting one
  through `Intl` follows the *browser* (an English date on a Japanese panel) and spells the same moment
  three ways across the product — and `03/04/2026` is a different day in two of the nine languages
  shipped. Relative times stay `Intl` with `numeric: 'always'`; non-English uses `short` unit style
  (`narrow` falls back to Latin in Japanese). (`uis/stock/test/format-locale.test.ts` scans both UIs.)
- **A plural rule is per language** — `plural.ts` resolves the CLDR category through `Intl.PluralRules`.
- **A lifecycle refusal is `{ ok: false, error }`, not the `DetailedError` envelope** — every failed
  response is read through `failureMessage`. (`src/shared/api-client.ts`)
- **A lazily loaded catalog must never block the mount** — `main.ts` mounts in `finally`; English is
  bundled.
- **Chrome is not content, so it does not shrink** — a header row gets `flex: none`; a horizontal
  scroll with no signal is a clipped row.
- **A page title rendered as a `<span>` leaves the page with no heading and no landmark** —
  noc-console's eight routes each named themselves in `.view__title`, styled identically to a
  heading and marked up as a span, and the shell's content box was a plain `<div class="main">`.
  Measured in Chromium on the installed build: `main` **0** and `h1` **0** on every route
  (`/global/overview`, `/w/default/servers`, `/jobs`, `/logs`, `/settings`, `/global/settings`,
  `/proxy`, a server's config page) — the workspace settings page had one stray `h4` and the config
  page another, so the outline was one group title with no page title above it. "Skip to the main
  content" and the heading list are how a keyboard-first console is used, and both were empty. stock
  has both on every page. The shell's `.main` box becomes `<main>` (same class, same box — verified
  172,46 1108×828 at 1280 and 0,206 320×468 at 320, identical before and after) and the title
  becomes its `<h1>`, which needs the `span`-equivalent `margin: 0`, `line-height: inherit` restored
  because a `h1` arrives with its own. (`uis/noc-console/test/mobile-layout.test.ts`, "every page has
  a landmark and a heading"; strip comments before counting tags — the note explaining the fix names
  `<main>` and made the scan count two.)
- **`navigator.clipboard` does not exist on a plain-`http://` LAN origin** — copy through `copyText`
  (`execCommand` fallback) and report the verdict. (`uis/stock/src/lib/clipboard.ts`)
- **`pointer: coarse` raises icon targets to 44 px** — check a header change in a real browser at
  320 px with a coarse pointer; a class test cannot measure layout.
- **A countdown and an elapsed time are different formatters, and the types cannot tell them apart** —
  `relativeFrom` is forward-only (it clamps `Math.max(0, ts - now)` and returns the `now` word for
  anything under a second), so handing it a **past** timestamp renders `now` for every row. Both take
  `(ms, now) => string`, so a wrong choice type-checks; use `relativeFrom` for `nextRunAt` and
  `formatAgo` for `lastRunAt`/`lastCrashAt`/`sampledAt`. (`src/shared/ui-format.ts`;
  `uis/stock/test/jobs-edit.test.ts`, "puts the previous run in the past")
- **A formatter's unit ladder is half the format** — `relativeFrom` stopped at minutes, so a job due
  tomorrow read `in 694m` while the other UI said `in 12 hours`; two UIs, one API number, two
  answers. Keep the forward ladder as wide as `formatAgo`'s (s/m/h/d) and widen
  `DurationWords.ahead` with it — it was typed `'s' | 'm'`, the same assumption in the interface.
  (`src/shared/ui-format.ts`; `test/shared/ui-format.test.ts`)
- **A contrast token is validated on the surface it is used on, and there is more than one** — the
  light theme's `--faint` claimed `≥4.5:1 on --panel` (4.76) and measured **4.13 on `--page`**, where
  the same 11 px labels actually sit; noc-console's was **2.42–3.10**. Compute the ratio per surface
  and per theme block from the tokens themselves, and keep the quiet tones *ordered* —
  raising `--faint` to the AA floor alone left it 0.33 from `--dim`, collapsing a three-step
  hierarchy. (`uis/*/test/contrast.test.ts`)
- **A status tone is painted on its own tint, and that is a different surface from the page** — a
  notice box is `bg-warn-soft text-warn`, one element, so the text sits on a 10 % layer of *itself*
  over the page and the tint eats the margin a tone tuned to the page barely had. Measured live in
  Chromium across page/panel/panel-2/raise/hover, the worst case was light accent **4.17**, ok 3.99,
  warn 3.94, danger 3.92, info 4.36, and dark accent **3.83**, danger 4.44 — while every one of them
  cleared the plain surfaces, which is why the per-surface guards above passed. The failing text was
  each notice's own title (`No engine installed`, `A port below 1024 needs a privileged bind`): the
  one line in the box that has to be read. Fit each tone against its tint **and** the plain surfaces
  at once, in **both** themes (the dark accent and danger were under AA on plain surfaces too), and
  carry `--series-*` with the tone it draws. A tint's alpha cannot fix it: 0.035 was needed for
  accent alone, and ok/warn/danger could not reach 4.5 at any alpha. `--faint` on the *selection*
  tint is not the same case and is deliberately left alone — the row is the one you already chose,
  and raising `--faint` to clear it collapsed the tone onto `--muted` (5.94 vs 5.52).
  (`uis/stock/test/contrast.test.ts`, "every status tone clears 4.5:1 on its own tint")
- **`(s)` is an unfinished plural, not a neutral one** — `1 server(s)` in a header and
  `restored 1 item(s)` in a toast are the placeholder an author leaves; the same sentence is spelled
  right a dozen other times in the same file (`{{ n }} server{{ n === 1 ? '' : 's' }}`). A
  **parenthesised unit** (`timeout (s)`, `cooldown (s)`) is not a count and must be left alone.
  (`uis/noc-console/test/plural-counts.test.ts`)
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
- **A download link names a file the panel lists, never one it assumes** — `GET
  /api/logs/:id/download` answers `404 UNKNOWN_LOG_FILE` for a name that is not in the entry's file
  list, so a link built from a convention (`<id>.log`) is a control that always fails. Both UIs had
  one, each gated on a *different* wrong signal: stock's server detail page on
  `config.logBufferLines > 0` (the in-memory buffer) and noc-console's Logs page on `enabled` (the
  workspace's `logs.persist` setting). Measured at 1280 px: a visible 32×32 icon and a visible
  126×24 text link, both `404`, while `/api/logs` reported `files: []` for the same entry. Gate on
  the list; `src/shared/log-download.ts` is the shared rule.
  (`uis/stock/test/server-detail-download.test.ts`, `uis/noc-console/test/logs-download-link.test.ts`)
- **An outcome rendered at the end of a scrolling body is not an outcome** — both noc-console
  settings pages put "nothing changed" / "saved" in a note that was the last child of the scroll
  body, measured **1561 px** and **2269 px** below the Save button that produced it at 1280×900,
  with the note off-screen until the person scrolled to the bottom. The console already had a fixed
  toast (`flash()` in `composables/useUi.ts`, used by `ServerConfigView` for the same string) and
  the settings pages never called it. Report beside the control that acted; the inline note can stay
  as the record. (`uis/noc-console/test/settings-save-feedback.test.ts`)
- **`minmax(<fixed px>, 1fr)` cannot shrink below its floor** — so a grid track stays 280 px in a
  238 px container and its fields overflow the box instead of collapsing to one column.
  `.grid--wide` measured 280 px inside a 238 px add-server dialog at 320 px, with five health-HTTP
  fields reaching x=321 in a dialog ending at x=304 (17 px out, plus an unreported 18 px body
  scroll); it still overflowed at 360 px. Use `minmax(min(280px, 100%), 1fr)`, which keeps the
  preferred width where there is room and yields where there is not. Scoping matters: `.metrics`
  (118 px) and `.logpage` (180 px) keep fixed floors because their containers never shrink below
  them. (`uis/noc-console/test/mobile-layout.test.ts`)
- **A template that reaches into the API namespace from markup does not mount with a mocked client**
  — `:href="api.logDownloadUrl(...)"` reads a `__v_isRef` off the module namespace, so a
  `vi.mock('@/lib/api')` that spreads `importOriginal` still throws "No __v_isRef export is defined"
  and the render aborts before anything under test exists. Build the href in `<script setup>` and
  bind a plain value; the view then mounts against a fake client, which is what makes the *gate*
  testable rather than the helper.
- **A list hidden below a breakpoint takes its only way to choose with it** — stock's Logs page lists
  servers in `<aside class="… hidden … md:flex">`, and *that rail was the only control* that changed
  `selected`. Below `md` it is `display: none`, so the page showed whichever server came first and
  the header named it as though it had been chosen; with three servers the other two were
  unreachable, and the command palette's button is hidden below `sm` too. Measured at 767/390/320
  px: rail `width: 0`, and no visible control in the page names a server. Give the narrow layout its
  own picker (`md:hidden`, so the two are never both live) and hide the static heading it duplicates
  for the same span — the header otherwise prints the server name twice, 60 px apart, with one copy
  unusable. (`uis/stock/test/logs-server-picker.test.ts`; assert the choice *works* below the
  breakpoint, not just that a control exists.)
- **A scroll issued during `setup` measures a page that is still growing** — `?section=` was read
  before the late `/api/settings` filled the host and backups blocks, so one `scrollIntoView`
  placed the target against a document 1000 px shorter than the one that then existed: at
  1280×900 `/global/settings?section=tls` settled at target top **1072** instead of 72, and
  `/w/default/settings` was the same. A rail click was correct because it runs *after* the fill,
  which is exactly why this hides from manual testing — the broken routes are a reload of the URL
  the rail just produced, a bookmark, and the command palette's "Global setting: …". Re-place the
  target while the height keeps changing, and let go on the first `wheel`/`touchstart` so a late
  block cannot drag the viewport back. (`uis/stock/test/settings-pages.test.ts`, "a section deep
  link follows the page as it grows"; `happy-dom` lays nothing out, so assert the *order* of
  operations — the scroll is re-issued on growth and stops once it holds.)
- **A flex child of a scrolling column shrinks below its content, and a pane has no scrollbar to
  show it** — `.view` is `overflow: auto` **and** `flex-direction: column`, so every direct child
  is a flex item whose default `flex-shrink: 1` lets the browser squeeze it shorter than what it
  holds. `.pane` sets `min-height: 0` (needed inside the split, where each half *should* be
  sized) and no `overflow`, so the squeezed-off part is not scrollable: the next sibling simply
  paints over it. Measured in Chromium on noc's `/global/overview`: host vitals held **445 px of
  content in a 205 px box** at 320×568, putting 4 of its labels behind the workspace pane's
  header; at 320×700 the filesystems table went under instead — 9 labels (`path`, `total`,
  `free`, `used`, `usage` and every value) — 11 at 360×640, 1 at 390×700, and a short 1280×420
  desktop window shrank 28 px before anything was hidden yet. Scrolling `.view` to its
  `scrollHeight` never revealed them, which is what separates this from ordinary below-the-fold
  content and why "can I scroll to it" is the wrong test. `flex: none` on the page-level child
  (`.view > .pane`) is the fix; the base `.pane` must keep shrinking, or the servers split's
  halves and the page-length forms change with it. The header already carries the same rule
  (`.view__head`) — the content below it did not.
  (`uis/noc-console/test/mobile-layout.test.ts`, "does not let a page-level pane shrink below its
  own content"; a class-level scan of the sheet, because a mount has no layout engine.)
- **Pinning two columns can leave no window between them** — the narrow-table rule pins the
  identity (`left: 0`) and the actions (`right: 0`), which is right, but it says nothing about how
  wide the pinned cell may get. noc's jobs table sizes its identity to a three-line block whose
  longest line is the command, measured at **235 px of a 320 px viewport**; with an 82 px action
  column the free window between them was **3 px**, so SCHEDULE / NEXT / LAST were each readable
  3 px at a time at any scroll offset — and the "drag it and see" answer does not help, because
  the middle is *never* more visible. A `max-width` on that one cell plus `text-overflow:
  ellipsis` on its lines took the window to 95 px at 320, 133 at 390 and 164 at 430. Scope it to
  the table that needs it: the same cap on the servers table clipped a 145 px identity to
  `Python`, for a table whose identity is one short line. Also note the second half — as a bare
  child of `.view`, that 592 px table was what the *page* scrolled, which dragged the sticky
  `.view__head` to **x = -264** and took the title and `new job` off screen; a table belongs in
  `.tblwrap`, which already owns the edge shadows that say a middle column exists.
  (`uis/noc-console/test/mobile-layout.test.ts`, "scrolls the jobs table itself and caps its
  identity column on a phone")
- **`overflow-x: auto` with nothing else is an invisible scroll, so it reads as a clipped table** —
  a phone has no scrollbar, so a box 197 px wider than its 288 px frame looks like a table that
  simply ends. stock's jobs table is the case: at 320 px its action cell alone is **240 px of the
  288 px** scroller, so `Run now` sat **14 px past the right edge at rest**, and the schedule above
  it wrapped `0 3 * * *` into `0 3` / `* * *` — neither of which announces that a drag would
  reveal it. (Focusing the button does not help either: `focus()` left `scrollLeft` at 0.) Give
  the box an edge shadow that rides the scroll position — four background layers, `local` on the
  two content ones and `scroll` on the two box ones, which is what makes the shadow appear only
  on an edge that still has content behind it and vanish once the box fits. Keep the shadow
  colour a **theme token**: stock's light edge is a dark 13 % and its dark edge a pale 10 %, so a
  hardcoded colour is invisible in one of the two themes. (`uis/stock/src/styles.css`,
  `.scroll-hint-x`; `uis/stock/test/mobile-layout.test.ts`, "gives a horizontally scrolling box a
  visible edge hint", which also fails for any new `overflow-x-auto` box that omits the class.)
  **The two `local` layers are covers, and a cover must be the colour of the ground, not of a
  panel.** They exist to hide the shadow once the content is scrolled to its end; painted in
  `--panel` (white) over a table sitting straight on the page's grey they become a white band down
  the edge instead. On the Jobs table that band covered `disable` and `remove` — a table that fit
  its box exactly (`scrollWidth 798 === clientWidth 798`, every button hit-testable) still *looked*
  clipped, and it read as "more to the right" when there was nothing. Set `--scroll-cover`; it
  defaults to `--panel`, and `scroll-hint-page` names the page ground. The general rule: a
  decorative overlay is only invisible where its colour equals what it lies on.
- **`flex-1` beside a default-flex sibling takes the row, and `truncate` does not save the
  other** — `flex-1` is `flex-basis: 0`, so it yields before a sibling whose `flex` is
  `0 1 auto` and whose content is wide. stock's Global settings → Paths paired a label+hint block
  (default flex, 246 px of text) with a value block (`flex-1`): the label took the row and the
  path was squeezed to a **0 px** box — not ellipsized, *unrendered*, while its copy button stayed
  visible, so the page offered "copy" for a path it never showed. Measured in Chromium on
  `/global/settings?section=paths`: at 320 px Data root 0 px holding 252 px of text and Global
  settings 0 px of 350, three workspace rows the same; one row still 0 px at 390; every row fine
  from 640 px, which is what hid it. A row on a phone cannot hold a label, a hint and a path, so
  the pair **stacks** below `sm` (the value gets its own line) and only takes `flex-1` above it.
  The shape, not the component, is what the guard asserts.
  (`uis/stock/test/mobile-layout.test.ts`, "never squeezes a truncated value to a zero-width box
  beside its label")
- **A badge and a sub-line must not say the same thing.** The backup capture list gave each item a
  badge (`included` / `skipped`) and a line under its name whose *fallback* was that same word, so
  every ordinary row read "accounts / included" and then "included" again on the right. The line is
  for what the badge cannot say — where an item came from, why it is not captured, that generated
  directories are skipped — and nothing else; a row with nothing to add has no second line.
  `captureItemDetail()` in `uis/stock/src/lib/panel-text.ts`, tested by name so the duplication
  cannot come back.


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
- **A new workspace config file is a new backup leaf, and a new backup leaf is a new scope id.** A
  domain that gets its own file (`jobs.config.json` out of `servers.config.json`) silently leaves
  every archive unless the capture, the restore plan, the selection tree and the scope ids all learn
  it together — and the failure is invisible: the archive restores "4 items", the workspace looks
  complete, and the scheduled work never runs. `grep -c -i job src/services/backups.ts` answering `0`
  was the whole symptom. (`workspace:<id>:jobs`; `test/services/backups.test.ts`, "jobs travel")
- **A leaf's capture and its restore are two separate edits**, and either alone is silent: a file
  captured but not planned shows up in the archive and never on the target. Watch each fail by
  reverting one at a time.
- **`reloadAll()` resets the watcher's baseline**, so it must start the autostart entries itself.
- **A force restart resets health to `unknown`** — `pendingRestart` is what announces the outcome.
- **The backup copy filter matches generated directories by exact path segment**; `.git` is kept.
- **A secret is compared with `secretEqual`, never `!==`.** (`src/helpers/secret-compare.ts`)
- **A token sent with `redirect: 'follow'` is safe only because undici drops `authorization`
  cross-origin** — test it with two real loopback servers. (`downloadToTemp`)
- **Server args are logged before `${VAR}` expansion**, so a secret never reaches logs, SSE or Telegram.
- **A certificate is valid only inside its window** — `validityError()` checks both ends; OpenSSL
  < 3.2 (macOS LibreSSL) lacks the flags the tests use (`hasOpensslExplicitDates`).
- **A removed server takes every per-id artifact with it** (`logFiles.clear`, `HistoryStore.forget`,
  `forgetServerEnv`) — a fourth per-id store joins that branch, and `secretEnv` already is one: a
  removed then re-created id answered `secretEnvSet: ['STALE_KEY']` with the **old** value, and the
  next spawn handed it to the new child. Reclaimed in the branch, not at the DELETE route, so a
  hand-edited config gets it too. (`src/services/supervisor.ts`; `test/services/supervisor.test.ts`,
  "a removed server")
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
  every contract at import cost ~1.2 s per CLI command and test child. A **method called on the
  `lazy(…)` wrapper itself** at module level builds it on import and undoes the wrapper; `.default(…)`
  *inside* the thunk does not — it is a method on the real schema, which is where 45 of them live in
  `contracts.ts` and `lazy.test.ts` proves the import stays at delta 0. (`src/shared/lazy.ts`;
  `test/shared/lazy.test.ts`)
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
- **A key list paired with the parser that reads it drifts silently** (`parseGrouped`) — check such
  pairs with a mutation, not a reading.
- **A test for "which stream" keeps stdout and stderr apart** and asserts the other one is empty.
- **A pure-function test does not pin its call site** — the already-running `up` conflict check stayed
  green with its wiring deleted; one test runs the real `up` against a real `run.json`.
  `--no-autostart` stays accepted there. (`test/cli/server-action.test.ts`)
- **An early return before a hash is a timing oracle, and `||` short-circuits one into the answer** —
  "unknown id and wrong secret answer the same" was true of the body and false of the work: an unknown
  id returned before scrypt, and `account === null || !verify(…)` never ran the verify at all, so the
  login route answered in 1.2 ms against 36.9 ms. Spend the hash on the miss too, and reach it at the
  call site. (`src/config/secrets.ts`, `src/services/auth.ts`; `test/config/secrets.test.ts`)
- **A timing floor on the *unknown* case is not parity when the store holds two algorithms** — the miss
  was made to cost one scrypt, which matched a typed secret and not a generated one. `sha256` records
  verify in microseconds, so a wrong secret for a real generated account was ~2700× *cheaper* than an
  unknown id (0.011 ms vs 29.7 ms): the fast answer named the account, and it named the ids that
  `account create` mints by default. Spend the equalising cost on every **failed** answer, whichever
  algorithm the record uses, and keep success fast — it runs on every authenticated request. Test the
  ratio in both directions, against each stored shape. (`src/config/secrets.ts`;
  `test/config/secrets.test.ts`)
- **A failed credential costs a scrypt, so every path that accepts one needs a budget** — the login
  route was bounded per address *and* panel-wide; the bearer path (`requestIdentity`, read on every
  `/api` request) had neither. A miss there spends the same ~30 ms of synchronous scrypt, so an
  anonymous caller loops `<made-up-id>:<guess>` — no valid credential, no known id — and the event
  loop stalls: with 16 workers `/healthz` went 2.3 ms → 1.02 s sustained. Bound it **per address**,
  with the lockout a failed sign-in already uses. Not the panel-wide counter: that one refuses a
  correct credential once spent, so reusing it lets ~100 junk headers from one stranger stop every
  working script for ten minutes — a CPU DoS traded for an outage of the automation the panel exists
  to serve. (`src/services/auth.ts`, `src/middleware/auth.ts`; `test/services/auth.test.ts`)
- **`validate('json', …)` reads the body, so a handler's own credential check runs too late** — an
  unauthenticated caller on the local channel decided how much work the panel did before refusing it
  (2 MB → `400 INVALID_INPUT` naming the field, ~3 MB heap, instead of `403`). Put the credential check
  in middleware ahead of validation on any route that takes a body. (`src/api/control.ts`;
  `test/api/panel.test.ts`)
- **`workspaceScoped: false` on a route that reaches every workspace is not "nothing to narrow"** — an
  archive names no `?workspace=`, so a `staging`-limited `config` account took a backup carrying
  `default`'s `secrets.json`, restored one over `default`'s `servers.config.json`, and deleted the
  owner's archive. The declaration has a spelling for each answer: `false` (panel-wide, the limit does not
  apply), `'path'` (the subject is a workspace named in the URL), and `'all'` (it reaches every one,
  so a limit **refuses** it). Any new route that touches more than one workspace at once is `'all'`.
  (`src/middleware/token-scope.ts`; `test/middleware/token-scopes.test.ts`)
- **"There is no `?workspace=` to narrow" is about the query, not the data** — `GET /api/metrics` was
  declared panel-wide on that reasoning, and every sample carries a `workspace` **label**, so there
  was something to narrow: a `staging`-limited `read` account scraped `default`'s server ids, status,
  crashes, restarts, uptime, response time, RSS and CPU while `GET /api/servers?workspace=default`
  refused it `403`. A panel-wide route that labels its output per workspace must filter that output
  for a limit — the same rule `GET /api/events` follows for its frames, for the same reason (the
  cheaper panel-wide read is the way to watch a workspace you may not read).
  (`src/api/metrics.ts`, `src/api/events.ts`; `test/middleware/token-scopes.test.ts`)
- **A panel-wide route whose *answer* is per-workspace data is the cheap way around a limit** — the
  same sentence as the metrics scrape, and it had three more instances: `GET /api/state`,
  `GET /api/workspaces` and the live feed's `hello`/`state` frames each declare
  `workspaceScoped: false` (nothing to check a `?workspace=` against) and each answer
  `workspaces[].servers[]` — the very `ServerView` the polling route refuses. Measured, a
  `staging`-limited `read` account got `403` from `GET /api/servers?workspace=default` and read
  `[{"id":"secret-svc","command":"node --api-key=SUPERSECRET","pid":4242}]` (plus `configPath` and
  `logsDir`) out of both snapshots and the opening SSE frame. `GET /api/proxy` is the fourth: it
  flattens every workspace's DDNS accounts into a picker whose rows name their `workspace`. Narrow the
  **answer** with one helper (`workspaceLimit`/`limitAllows` in `src/helpers/workspace.ts`,
  `narrowStateFor` in `src/services/state.ts`); a snapshot frame is narrowed, never dropped, or the
  client loses its own. Sweep a new panel-wide route for a per-workspace field the way the two-route
  walk test does, or it joins this list.
  (`src/api/state.ts`, `src/api/workspaces/$.routes.ts`, `src/api/events.ts`, `src/api/proxy.ts`;
  `test/middleware/token-scopes.test.ts`, `test/api/stream-resume.test.ts`)
- **A lookup before the limit is an existence oracle over the workspace you may not read** — the
  live feed answered `404 UNKNOWN_SERVER` for an id that does not exist and `403 TOKEN_SCOPE` for one
  that does in a workspace the caller may not watch, so a `staging`-limited account could enumerate
  `default`'s entries one id at a time. Refuse first: the limit depends only on what was *asked for*,
  and the "does this id exist" diagnostic belongs to the callers that may read the answer.
  (`src/api/events.ts`; `test/api/stream-resume.test.ts`)
- **Narrowing what a route *reads* is half a limit when a write replaces the same list** — the
  proxy's route table is one list for the whole panel, and every row names the workspace whose entry
  it forwards to. `GET /api/proxy` narrowed its `dnsAccounts` picker and left `routes` whole, so a
  `staging`-limited `read` account read `default`'s route id, public hostname and target entry. The
  write was worse: a list is replaced whole, so a limited `admin`'s `PATCH` naming `default/<entry>`
  answered `200` and served that hostname, and one sending only its own row **deleted** every other
  workspace's. Narrow the answer, refuse a row outside the limit, and carry over the rows it may not
  touch. (`src/api/proxy.ts`, `src/services/state.ts`; `test/middleware/token-scopes.test.ts`)
- **A `read` route that spawns a process is a spawn amplifier** — `GET /api/host/temperature` runs
  `host.tempCommand` through a shell to report a number. Unbounded, the cheapest scope in the model
  became "spawn a process per request": 20 concurrent requests from a `read`-only account peaked at
  **40** processes (shell + child each), and a monitor credential is exactly what `read` is for. Cache
  the probe **and** share the in-flight promise — a cache alone lets twenty simultaneous requests all
  miss it and all spawn. (`src/api/wsl-temperature.ts`; `test/api/routes.test.ts`, "does not spawn a
  process per request")
- **A `shrink-0` action cluster starves the heading beside it** — a flex row is laid out at its
  items' **min-content** before anything shrinks, and `shrink-0` on the cluster says it keeps its
  full width, so the heading absorbs the whole deficit. `FieldGroup` drew a group heading beside
  its actions that way: measured in Chromium at 320 px, `Interface` (Reset name, Revert to stock,
  Install UI) rendered in a **5 px** box holding 51 px of the word and its description spilled to
  **304 px tall at 5 px wide**, one word per line; `Destinations` (222 px of actions) was 24 px.
  Every one of those groups was fine from 560 px up, which is why it hid. `PageHeader` had already
  been fixed this way; the rule is the pair — a heading beside a cluster that will not shrink also
  lets the row `flex-wrap` — and `uis/stock/test/mobile-layout.test.ts` now scans for it. A
  `Panel` header has the same shape; check it before adding actions to one.
- **A shortcut hint describes the page, not the console** — noc-console's status bar carried one
  hard-coded sentence (`j k move · s start · x stop · r restart · l logs · e edit · / filter ·
  ? keys`) on every route. Measured in Chromium by pressing each key on each route and diffing the
  DOM: five of eight routes answered **none** of them, and the logs page answered `/`, `v` and `R`
  — two of which the bar never named. A hint that teaches a key which does nothing is worse than a
  shorter hint. Views register through `useKeyHints`, beside the `useKeyHandler` that implements
  them; **the registry must be `shallowReactive`**, because a plain module array is invisible to
  Vue and the shell's computed then re-ran only on `route.fullPath` — which changes *before* the
  incoming view mounts and *after* the outgoing one unmounts, so the bar showed the previous
  page's keys (measured: Servers→Logs showed the servers keys, back showed the logs keys).
  (`uis/noc-console/test/status-hint-keys.test.ts`)
- **A bare `<select>` in a header row has no accessible name** — the health pane's mode dropdown
  was not inside a `label.field` like every sibling on the page, so a screen reader announced
  "combobox, tcp port" with no field name: measured in Chromium on a server's config route, 4
  visible selects, three named by a wrapping label and this one's computed name the empty string.
  Chromium falls back to `title`, which never shows on touch, so a *new* control gets an
  `aria-label` rather than another title. (`uis/noc-console/test/select-accessible-name.test.ts`)
- **A `flex-1` next to a fixed cluster never wraps — it shrinks the text to nothing** — the
  archive list put an archive's name block beside `Download` / `Restore` / `Delete` in a
  `flex-wrap` row. `flex-1` is `flex-basis: 0`, so the block asked for no width, the pair always
  fitted on one line, the wrap never engaged and the name absorbed the whole deficit. Measured in
  Chromium with two ordinary archives: at 320 px each name sat in a **34 px** box holding 238 px,
  so both painted the same `bac…` and the row could not tell you which archive you were about to
  restore or delete, while the `3 KiB · <date>` line spilled to **112 px tall at 34 px wide**.
  Fine from 560 px up. Give the block a **basis** (`basis-60`, just over the 238 px a name
  measures) so the row wraps instead of squeezing; a `truncate` cannot save a box that is too
  narrow to show the part that differs. (`uis/stock/test/mobile-layout.test.ts`)
- **`Intl.DateTimeFormat(undefined, …)` follows the browser, not the panel's language** — the
  stock UI's rule is that a timestamp comes from `formatDateTime`, which passes `activeLocaleTag()`,
  but the accounts table built its own formatter. Measured in Chromium with the UI set to 日本語 on
  `/global/settings`: that one column read `Nov 16, 2026, 12:57 AM` while every other timestamp on
  the same page read `2026年11月17日 04:48:03`. The helper is only half the fix — the call site had a
  copy — so `format-locale.test.ts` scans every `.ts`/`.vue` for a locale-blind construction
  (`new Intl.DateTimeFormat(undefined`, a bare `toLocaleString()`) as well as pinning the helper.
  (`uis/stock/test/format-locale.test.ts`)
