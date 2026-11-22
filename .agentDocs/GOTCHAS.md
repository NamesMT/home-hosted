# Gotchas — traps and their causes

**Goal:** the non-obvious failures this codebase has already paid for, so they are not repeated.
**Scope:** one line of trap and rule per entry. Rules already stated in `AGENTS.md` are not repeated
here. The story behind an entry lives in the commit that fixed it: `git log -S'<identifier>'`.

Format: `- **<trap>** — <rule>. (<file>; <test>)`

## Process and platform

- **A closed pipe reader is reported as a write `EPIPE`, and an unhandled stream error kills the CLI** (`status | head -1` exited 1 under `pipefail`) — `treatClosedReaderAsDone()` is installed once in `main()`, exits 0, and rethrows anything but `EPIPE`. (`src/cli/io.ts`; `test/cli/epipe.test.ts`)
- **`node_modules/.bin/tsx` is a `#!/bin/sh` shim Windows cannot start** — tests spawn `process.execPath --import=tsx` through the one launcher. (`test/support/run-cli.ts`; `test/cli/cli-launcher.test.ts`)
- **`node_modules/.bin` holds `foo`, `foo.cmd` and `foo.ps1`** — `resolveCommand` tries the extensioned shims first and never falls back to the bare POSIX script. (`src/providers/process.ts`)
- **A text read that slices on `'\n'` bleeds into the next block on a CRLF checkout** — normalize line endings and throw when a boundary is missing.
- **A Windows task needs elevation even for a logon trigger; `%APPDATA%\…\Startup` does not** — `--startup` is the only no-privilege autostart form on Windows; check what a mechanism buys before deleting it. (`src/cli/service.ts`)
- **A Windows editor writes a BOM or UTF-16, and a `'utf8'` read has already destroyed the bytes that tell them apart** — every hand-editable file goes through `readStateFile`. (`src/helpers/config-text.ts`)
- **A file capability makes a process non-dumpable**, so `lsof`/`fuser` see nothing — an empty holder list is not a free port. (`src/services/proxy.ts`)
- **A basename is not an identity, and an empty argv word is a word** — the basename fallback applies only while one side is bare; `/proc/<pid>/cmdline` keeps `''` arguments. (`processArgv`, `sameWord`; `test/providers/identity.test.ts`)
- **`spawn` reports a missing `cwd`, a missing program and a pasted command line as the same `ENOENT`** — `describeSpawnError` checks in that order. (`src/providers/nanny.ts`)
- **`run.json` is the daemon's identity and `down`'s credential** — keep `runtimeSchema` in step with the `Runtime` written in `src/index.ts`.
- **A Node child that calls `process.exit` loses its own unflushed pipe output** — a fixture whose output the test reads back sets `process.exitCode` and lets the process end instead. (`test/services/nanny.test.ts`)
- **The WSL temperature helper is machine-wide, and a test that writes it breaks every home on the machine** — reach it only through `HHOSTED_TEST_PROGRAMDATA`. (`test/support/test-home.ts`; `test/support/real-home-guard.ts`)
- **`pnpm run media` needs Playwright's Chromium, which `pnpm install` does not fetch** — run `pnpm exec playwright install chromium`. (`scripts/capture-media.mjs`)

## Supervision

- **The tick never awaits a stop or restart** — use `restartInBackground`; skip entries already `stopping`/`starting`. (`src/services/supervisor.ts`; `test/services/supervisor-tick.test.ts`)
- **Every helper child goes through `spawnManaged`** — a bare `spawn` misses `needsShell` (a `.cmd` throws EINVAL) and its own process group. (`src/services/supervisor/spawn.ts`)
- **`nannyStateSchema` rejects undeclared keys** — a new nanny-state field makes an older panel read the file as missing and spawn a twin.
- **Overlapping `start`/`stop` double-spawn or resurrect** — `start()` sets `starting` before its first await, and `stopping` is cleared on every exit path of `stopEntry()`. (`src/services/supervisor.ts`)
- **A sample written after an `await` re-checks the run token *and* pid** — capture both before the await and compare both after it, never the status alone. (`src/services/supervisor/health.ts`; `test/services/resource-sampling.test.ts`)
- **Only the nanny rotates `<id>.log` while its persistent run is alive** — the panel appends with `{ rotate: false }` for that window. (`src/services/log-files.ts`; `test/services/log-files.test.ts`)
- **A timer or `void`-ed promise without `.catch` is an unhandled rejection, which ends Node 24.**
- **An adopted process is not a `ChildProcess`** — nothing reports its exit; the tick polls liveness.
- **The argv identity fallback is what `reclaim` kills by** — compare image and arguments literally, and keep one resolver (`resolveSpawn()`). (`src/providers/identity.ts`)
- **`HHOSTED_SERVER_ID` carries no workspace** — "is this pid ours?" is a panel-wide question; refusals name `workspace/server`. (`src/services/panel.ts`)
- **A persistent entry has three lifetimes** — reattach needs liveness with start time, a fresh heartbeat and the marker or argv, never the heartbeat alone. (`src/services/nanny.ts`; `test/services/nanny.test.ts`)
- **Whether the nanny forwarded a stop follows the configured signal, not the terminator's label** — signal the child when the signal is outside `NANNY_TRAPPED_SIGNALS`. (`src/providers/nanny-sweep.ts`)
- **A hand-picked state signature publishes nothing for the field it forgot** — sign whole views; a transition test must publish the state before it. (`stateSignature`, `src/services/panel.ts`)
- **A host read on the frame path is paid per entry, per second** — cache it on its own clock, cache only a success (`windowsProgramData`, `lanAddress`), and expose a `forget*()` seam for tests.
- **Startup is dominated by module load** — a "slow" start is the import graph, not a loop.
- **A compose entry's containers outlive its wrapper** — a stop resolves `composeTarget` and decides from a fresh listing, never the signal or `docker stop`'s exit code. (`src/providers/docker.ts`)
- **A notification throttle window armed by a failed send silences the next alert** — the send gives back only the deadline it armed (`releaseCooldown`). (`src/services/notifications.ts`)
- **A WSL2 guest exposes no temperature, and Windows' `MSAcpi_ThermalZoneTemperature` can be a constant 20 °C** — `n/a` is the honest default. (`src/providers/wsl-temperature.ts`)

## Metrics

- **A hand-written mirror of a schema drifts the moment the schema grows** — read the parity from source rather than re-implementing the schema. (`isFrameShape`, `src/shared/live-frames.ts`; `test/shared/live-frames.test.ts`)
- **A guard over a hand-written file list protects the files somebody remembered** — when a guard needs to cover "every X", discover the X.
- **`stateSignature` is `JSON.stringify(state)`, and it must stay that way** — a hand-written list of "the fields that matter" is wrong the moment a field is added.
- **A size limit that only reads `content-length` has a door: `Transfer-Encoding: chunked`** — bound the body before it is parsed. (`src/middleware/body-limit.ts`)
- **`hono/body-limit` cannot wrap an srvx request, and the unit suite cannot see it** — it re-wraps the body and the framework ignores the result.
- **A wall-clock budget cannot detect a per-frame file read** — assert on the call, not on elapsed time. (`test/services/frame-budget.test.ts`)
- **Three CPU numbers are not interchangeable** — `loadAvg` is a task count, `cpuUsedPercent` a share; a threshold against the wrong one fires on an idle box.
- **A reading's absence, band, scale and aggregate each have one home** — see [`READINGS.md`](READINGS.md).
- **A guard asking "did we spawn it?" skips every adopted process** — liveness is a question about the pid, not the spawn.
- **A refusal naming a pid does not name the row** — attribute the holder from the walk that decided it. (`src/providers/proc.ts`)
- **A compose stack is not a process tree** — the wrapper's reading watches nothing; sample the containers. (`src/providers/docker.ts`)
- **The docker cache answers only for the targets it asked about** — refresh inside the window for a stack the cache was not filled for. (`src/providers/docker.ts`; `test/providers/docker.test.ts`)
- **A cooldown is per destination and reason, not per state** — a state change swallowed by a running cooldown never sends. (`src/services/notifications.ts`; `test/services/notifications.test.ts`)
- **`defaults` in the notifications block is ignored by any destination that carries its own toggles** — read the destination's own block.
- **A `load` hook runs only once the entry is *answering*** — a server that never binds its port never loads its dump.
- **`GET /api/servers/:id` carries the hooks at `server.config.dump`, not `server.dump`** — the view nests them under `config`.
- **Restoring a backup rewrites `servers.config.json` from the archive** — a hook edited after the backup is lost.
- **A DDNS failure is retried forever unless the provider sets `permanent`** — most do not.
- **A spawn that never started reports differently from one that threw** — unify it before deciding an outcome.
- **An SSE stream looks dead under a 3-second probe, and that is not a bug** — a keep-alive interval longer than the probe reads as a stall. (`src/helpers/event-stream.ts`)
- **A request path and its SSE fan-out are cheap** — do not "optimise" them on suspicion. (`src/helpers/event-stream.ts`)
- **`/_hh/backups` is `POST`-only** — a `GET` there answers a *plan* with `200`, which reads as an applied backup.
- **`migrate` prints "moving N job(s)" before it has asked, and writes nothing until you consent** — the plan is not the write. (`src/services/backups.ts`)
- **`refused` in `/api/meta` is about credential *kind*, not scopes** — the scope refusal lives in the route. (`src/api/state.ts`)
- **`features` in `/api/meta` means "switched on", not "runnable"**, and `proxy` is not a settings-patch key.

## Config

- **The save baseline moves only with the object a save patches** — advancing it on a read let the next save overwrite a hand edit with a typo. (`assertSaveable`; `test/config`)
- **`reloadAll()` must not call a bare `settings.load()`** — that skips the exposure guard a hand edit meets.
- **`cookieSecure: auto` rests on srvx rewriting `url.protocol` from `x-forwarded-proto` when `trustProxy` is on** — only a browser notices the flag vanishing. (`src/helpers/cookies.ts`)
- **An editor's save is a rename over the target** — watch the directory, back it with a poll, and keep the running config when a revision does not parse. (`src/services/config-watch.ts`)
- **A header is a Latin-1 byte string and names are case-insensitive** — validate at save (`headerProblem`). (`test/services/notifications.test.ts`)
- **A store adopts a revision only once it parsed *and* passed the schema** — the pair (raw object, trusted bytes) moves together. (`src/config/settings.ts`; `test/config/global-settings.test.ts`)
- **An unstamped file is pending only the migration steps for its own kind** — the chain is filtered by `ConfigMigration.kinds`. (`src/config/migrations.ts`; `test/config/compat.test.ts`)
- **A query key the caller leaves out is not "no value"** — `requireWorkspace` resolves an omitted `?workspace=` to the panel's default, so resolve the default in the guard and check *that*. (`src/middleware/token-scope.ts`; `test/middleware/token-scopes.test.ts`)

## Proxy

- **An unroutable route is left out of the render, never thrown for** — only a save refuses a route it adds or changes (`routeProblems`). (`src/services/proxy.ts`; `test/services/proxy.test.ts`)
- **A manual certificate is loaded by path, so the rendered configuration cannot carry its content** — the certificate carries its content's fingerprint as a `tags` entry, which is what makes the render change. (`src/services/proxy.ts`; `test/services/proxy.test.ts`)
- **A host, a path and an upstream each have exactly one parser** — a second spelling of "same host" or "same prefix" is how a route shadowed another. (`src/shared/proxy-form.ts`; `test/services/proxy-config.test.ts`)
- **A Caddy name no automation policy names gets the public CA** — local-only names are named in the internal policy, and `local` is decided from the stored leaf. (`src/services/proxy-config.ts`; `test/services/proxy-config.test.ts`)

## UI

- **A control that explains a field goes after that field, through the layout** — `FormSection.slots` names an anchor field; a section-level slot renders only after the whole block. Assert position, and in **every** UI. (`uis/noc-console/test/server-form-fields.test.ts`)
- **With auth off, `authRequired` and `authenticated` never change** — watch `streamDecision(session)`, not the flags.
- **A form copying live state guards per block and copies detached** — a shallow copy aliases nested groups.
- **A guarded fill may write only the fields its own guard covers** — a snapshot that does not cover everything the block writes silently un-guards it. (`uis/stock/test/settings-tls-revert.test.ts`; `uis/stock/test/settings-pages.test.ts`)
- **An absolutely positioned element in a static scroller resolves against the page** — the shell's `main` keeps `relative`.
- **A dialog's footer is a flex sibling of the scrolling body**, or a tall form hides Save.
- **Vue skips a computed whose value is `Object.is`-equal** — hand out a new array per batch.
- **Vue casts `<input type="number">` to a number**, so a setter calling `.trim()` drops every value. (`uis/stock/test/number-field.test.ts`)
- **A UI cannot translate text the panel formatted** — the panel sends an optional catalog key beside the formatted value.
- **`Intl` beats a catalog for numbers, durations and relative times — but not for dates** — a date is a calendar, not a format. (`uis/stock/test/format-locale.test.ts`)
- **A plural rule is per language** — resolve the CLDR category through `Intl.PluralRules`. (`uis/stock/src/i18n/plural.ts`; `uis/stock/test/i18n-catalog.test.ts`)
- **A lifecycle refusal is `{ ok: false, error }`, not the `DetailedError` envelope** — every failed lifecycle call answers in that shape. (`src/shared/api-client.ts`)
- **A lazily loaded catalog must never block the mount** — `main.ts` mounts in `finally`; English is bundled.
- **Chrome is not content, so it does not shrink** — a header row gets `flex: none`.
- **A page title rendered as a `<span>` leaves the page with no heading and no landmark** — strip comments before scanning for a heading. (`uis/noc-console/test/mobile-layout.test.ts`)
- **`navigator.clipboard` does not exist on a plain-`http://` LAN origin** — copy through `copyText`. (`uis/stock/src/lib/clipboard.ts`)
- **`pointer: coarse` raises icon targets to 44 px** — check a header change at a phone width.
- **A countdown and an elapsed time are different formatters, and the types cannot tell them apart** — `relativeFrom` for a future instant, `formatDuration` for a span. (`src/shared/ui-format.ts`; `uis/stock/test/jobs-edit.test.ts`)
- **A formatter's unit ladder is half the format** — `relativeFrom` stopped at minutes, so a job due in two hours read "in 0m". (`src/shared/ui-format.ts`; `test/shared/ui-format.test.ts`)
- **A contrast token is validated on the surface it is used on, and there is more than one** — a status tone is painted on its own tint, which is a different surface from the page. (`uis/stock/test/contrast.test.ts`, `uis/noc-console/test/contrast.test.ts`)
- **`(s)` is an unfinished plural, not a neutral one** — `1 server(s)` in a header. (`uis/noc-console/test/plural-counts.test.ts`)
- **A page rendered only through a CDN is blank offline** — render from `spec.json` first. (`src/openapi-reference.ts`; `test/api/panel.test.ts`)
- **A download link names a file the panel lists, never one it assumes**. (`uis/stock/test/server-detail-download.test.ts`)
- **An outcome rendered at the end of a scrolling body is not an outcome** — put it beside the control. (`uis/noc-console/test/settings-save-feedback.test.ts`)
- **`minmax(<fixed px>, 1fr)` cannot shrink below its floor** — a grid track stays 280 px in a 320 px container. (`uis/noc-console/test/mobile-layout.test.ts`)
- **A template that reaches into the API namespace from markup does not mount with a mocked client** — pass the client in, never import it in the template.
- **A list hidden below a breakpoint takes its only way to choose with it** — assert the choice *works* below the breakpoint. (`uis/stock/test/logs-server-picker.test.ts`)
- **A scroll issued during `setup` measures a page that is still growing** — `happy-dom` lays out differently, so assert the end state. (`uis/stock/test/settings-pages.test.ts`)
- **A flex child of a scrolling column shrinks below its content** — a pane needs `min-h-0`. (`uis/noc-console/test/mobile-layout.test.ts`)
- **Pinning two columns can leave no window between them** — narrow-table rules must keep a middle track. (`uis/noc-console/test/mobile-layout.test.ts`)
- **`overflow-x: auto` with nothing else is an invisible scroll, so it reads as a clipped table** — every horizontal scroller carries `.scroll-hint-x`. (`uis/stock/src/styles.css`; `uis/stock/test/mobile-layout.test.ts`)
- **`flex-1` beside a default-flex sibling takes the row, and `truncate` does not save the label** — give the label a floor. (`uis/stock/test/mobile-layout.test.ts`)
- **A badge and a sub-line must not say the same thing** — a count in both places reads as two facts.
- **A shortcut hint describes the page, not the console** — a status bar hint that names a console shortcut is wrong on every other page. (`uis/noc-console/test/status-hint-keys.test.ts`)
- **A bare `<select>` in a header row has no accessible name** — label it. (`uis/noc-console/test/select-accessible-name.test.ts`)
- **`Intl.DateTimeFormat(undefined, …)` follows the browser, not the panel's language** — pass the locale. (`uis/stock/test/format-locale.test.ts`)

## Data

- **A `catch`/`finally` cleanup does not survive a kill** — a temp directory a crashed run can leave is named with the owner's pid, and swept when that pid is dead. (`sweepStaging`, `src/services/backups.ts`)
- **A restore matches an archived path only against its own workspace's declarations** — an unknown workspace is reported, not guessed. (`matchTarget`)
- **The workspace registry travels in the archive**, and restore paths come from `BackupSources.dataRoot`, not the import-time path helpers.
- **An archive's configs must be lifted, not just parsed** — `liftArchived` runs the `migrate` chain; build restore fixtures at an older schema too.
- **A new workspace config file is a new backup leaf, and a new backup leaf is a new scope id** — capture, restore plan, selection tree and scope ids must learn it together, and the failure is invisible. (`workspace:<id>:jobs`; `test/services/backups.test.ts`)
- **A leaf's capture and its restore are two separate edits, and either alone is silent** — watch each fail by reverting one at a time.
- **`reloadAll()` resets the watcher's baseline**, so it must start the autostart entries itself.
- **A force restart resets health to `unknown`** — `pendingRestart` is what announces the outcome.
- **The backup copy filter matches generated directories by exact path segment**; `.git` is kept.
- **A secret is compared with `secretEqual`, never `!==`.** (`src/helpers/secret-compare.ts`)
- **A token sent with `redirect: 'follow'` is safe only because undici drops `authorization` cross-origin** — test it with two real loopback servers. (`downloadToTemp`)
- **Server args are logged before `${VAR}` expansion**, so a secret never reaches logs, SSE or Telegram.
- **A certificate is valid only inside its window** — `validityError()` checks both ends.
- **A removed server takes every per-id artifact with it** — a fourth per-id store joins that branch, and `secretEnv` already is one. (`src/services/supervisor.ts`; `test/services/supervisor.test.ts`)
- **A route path is normalised once** — `pathKey` and the Caddy matcher read the same form.
- **`EPERM` from `process.kill(pid, 0)` means alive** — one definition (`src/providers/port.ts`).
- **A state file is not proof a process is ours** — check `nannyIsAlive` before signalling a pid read from a file.
- **Removing a workspace deletes its state dir**, which can hold the only record of a survivor — `remove()` refuses while a stop reports one.
- **`serve({ tls })` throws synchronously on a mismatched pair** — `TlsStore.servable()` validates before serving and falls back to http. (`src/services/tls.ts`)
- **A retention knob bounds the directory, and every writer lowers it** — derive the set from `readdir`, prune inside `rotate`, and call `pruneLogs` on every path that can lower `keep`. (`src/services/log-files.ts`; `test/services/log-files.test.ts`)
- **A served file is streamed** — a log download can be 100 MB per rotation. (`src/services/log-files.ts`)

## Schemas and types

- **`jsonBody(x)` / `resolver()` builds `x`** — at module level it undoes lazy loading; use a getter (`ERROR_RESPONSES`). (`src/openapi.ts`)
- **A long-lived connection re-checks its credential without sliding the session** (`{ slide: false }`), or an open tab keeps a revoked session alive.
- **With `trustProxy: true`, srvx's `req.ip` is client-chosen** — never key a security limit on the address alone.
- **A module-level schema is `lazy(() => type(…))`, and nothing at module level calls one** — building a schema at import materialises every `lazy()` it reaches. (`src/shared/lazy.ts`; `test/shared/lazy.test.ts`)
- **ArkType errors are not `Error`s** — assert `expect(x).not.toBeInstanceOf(type.errors)`. (`test/shared/contracts.test.ts`)
- **An optional property (`'x?'`) rejects an explicit `undefined`** — omit the key.
- **`onUndeclaredKey('ignore')` does not reach a nested group** — declare it on the nested group too.
- **A key list paired with the parser that reads it drifts silently** (`parseGrouped`).
- **A test for "which stream" keeps stdout and stderr apart** and asserts the other one is empty.
- **A pure-function test does not pin its call site** — the already-running `up` conflict check stayed broken while its function was green. (`test/cli/server-action.test.ts`)
- **An early return before a hash is a timing oracle, and `||` short-circuits one into the answer**. (`src/config/secrets.ts`, `src/services/auth.ts`; `test/config/secrets.test.ts`)
- **A timing floor on the *unknown* case is not parity when the store holds two algorithms**. (`src/config/secrets.ts`; `test/config/secrets.test.ts`)
- **A failed credential costs a scrypt, so every path that accepts one needs a budget**. (`src/services/auth.ts`, `src/middleware/auth.ts`; `test/services/auth.test.ts`)
- **`validate('json', …)` reads the body, so a handler's own credential check runs too late**. (`src/api/control.ts`; `test/api/panel.test.ts`)
- **`workspaceScoped: false` on a route that reaches every workspace is not "nothing to narrow"**. (`src/middleware/token-scope.ts`; `test/middleware/token-scopes.test.ts`)
- **"There is no `?workspace=` to narrow" is about the query, not the data** — `GET /api/metrics` was panel-wide with per-workspace numbers. (`src/api/metrics.ts`, `src/api/events.ts`)
- **A panel-wide route whose *answer* is per-workspace data is the cheap way around a limit**. (`src/api/state.ts`, `src/api/workspaces/$.routes.ts`, `src/api/events.ts`)
- **A lookup before the limit is an existence oracle over the workspace you may not read**. (`src/api/events.ts`; `test/api/stream-resume.test.ts`)
- **Narrowing what a route *reads* is half a limit when a write replaces the same list**. (`src/api/proxy.ts`, `src/services/state.ts`)
- **A `read` route that spawns a process is a spawn amplifier** — `GET /api/host/temperature` runs a helper per request. (`src/api/wsl-temperature.ts`; `test/api/routes.test.ts`)
- **A legacy `.control-secrets.json` fixture must use base64 for `salt` and `hash`**, and the salt is per-file.
