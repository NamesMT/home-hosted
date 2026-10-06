# Gotchas — traps and their causes

**Goal:** the non-obvious failures this codebase has already paid for, so they are not repeated.
**Scope:** traps and the reasoning behind a non-obvious choice. Hard rules that must never be
broken are stated in `AGENTS.md` too — this file carries the *why*, and the ones that need it.

Most entries are a cause, not just a symptom. Where the symptom alone is enough to act on, it is a
line in `AGENTS.md` instead.

## Process and platform

- **`run.json` is the daemon's identity and `down`'s credential.** Keep `runtimeSchema` in sync with
  the `Runtime` written in `src/index.ts`. It lives at `.hh/run.json`.
- **A test or script that reads a file as text must not assume the line ending.** A Windows checkout
  has CRLF, so `indexOf('\n}\n')` found nothing, the slice ran past the function it meant to isolate and
  picked up the *next* one's contents — `global group 'defaults'` failing against the global keys list.
  Linux CI passed; only the platform gate caught it. Normalize (`replaceAll('\r\n', '\n')`) **and throw
  when the boundary is missing**, because silent bleed is the failure mode.
- **`ensureLayout()` runs before any command resolves a state path** (the CLI pre-pass) and is
  idempotent. It moves rather than copies, never overwrites an existing `.hh` file, and removes a
  legacy directory only when every entry in it actually moved — a refused move must not become a
  delete.
- **A basename is not an identity.** `sameWord` compares two spellings of the same file, and it fell
  back to `path.basename` on **both** sides — so `/tmp/evil/server.js` matched `/srv/web/server.js`,
  the exact guarantee the comment above it claimed to make. A false match here is not cosmetic:
  `matchesSpawn` decides whether a process is *this entry's*, so the panel would adopt a stranger on
  `follow`, or remove one on `reclaim`/`kill`. The fallback is needed while one spelling is bare (the
  config says `node`, the process table says `/usr/bin/node`); it must not apply when both name a
  directory.
- **Port preflight re-probes after 300 ms**: a just-closed listener can still complete a handshake.
- **The CLI's port preflight runs before its config guard**, so a busy default port turns config
  tests red for the wrong reason. Dev and test instances stay in the 6xxx range.
- `vite.server.config.ts` targets `node22` while `engines` requires >= 24 — deliberate margin.
- `pnpm test` watches; CI runs `vitest run`.
- **`pnpm run media` needs fonts *and* the X/NSS/Mesa libraries** for Playwright's Chromium. In a
  bare container point `FONTCONFIG_PATH` at a `fonts.conf` covering any TTF and `LD_LIBRARY_PATH` at
  a directory holding those libraries — without fonts, Skia panics instead of rendering, and the
  failure looks like a broken page rather than a missing package.

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
- **The per-second tick is not worth optimising — measured.** With 40 servers, `getState()` costs
  ~0.22 ms and `sampleMany()` over 40 pids ~15 ms; the state is published only when the signature
  changes and resources are sampled every 5 s. Measure elsewhere first.
- **Startup is dominated by module load, not by work — measured, so a future round does not
  re-derive it.** `src/app.ts` costs ~1.1 s to import, and `#src/shared/contracts` ~0.75 s of that,
  of which **arktype itself is ~0.43 s**. Nothing runs slowly; the graph is simply large.
  Two consequences worth knowing: `up` used to import the whole daemon before deciding to detach
  (~1 s wasted, now deferred — `up` 5.3 s → 2.0 s, and the suite 55 s → 31 s); and the daemon child
  inherits `process.execArgv`, so under tsx it re-compiles the graph while the **built** CLI does not.
  That last point is why `--version` is ~0.4 s built against ~2.0 s under tsx, yet `up` is ~1.8 s
  either way — the child dominates, not the parent.

## Config

- **An upload bound enforced after `parseBody()` is a memory limit, not a guard.** Both upload routes
  read `Content-Length` first — a header a **chunked** request does not send — and compare `file.size`
  only after the whole body is already in memory. `bodyLimit` from `hono/body-limit` counts chunks and
  aborts at the cap, which is the half the header check cannot do. **Check the order, not just the
  presence, of a size limit.**
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
- **`Workspace Settings → Server defaults` merge into the nested groups key by key.** A shallow
  `{ ...defaults, ...entry }` lets an entry that decides `restart.maxRetries` silently drop the
  workspace's `restart.baseDelayMs`, and the create/edit diff flow depends on inheriting exactly
  that.
- **The curated CLI dispatch reads only the flag forms** (`--help`/`-h`, `--version`/`-v`) after a
  command name, never a bare `help`/`version` — that is an option's value (`init --name help`).

## UI

- **The shell must watch the *session*, not only the flags derived from it.** With authentication
  off, `authRequired` and `authenticated` are both `false` from first paint to last, so a watcher on
  those two never ran after the session landed: the event stream never opened and the dashboard
  showed one stale snapshot forever. Both UIs derive one `streamDecision(session)` value
  (`wait` | `connect` | `login`) and watch that — which is what the test pins.
- **A form that copies live state must guard per block, never globally.** Host thresholds and the
  backups policy arrive from `/api/settings` *after* the SSE frame, so one "has anything changed?"
  gate leaves them showing schema defaults forever — the backups toggle reported itself as changed
  and flipped back on every reload. Compare each block against the snapshot it was filled from. The
  copy must be **detached**: a shallow one leaves a nested group (`health.http`) aliased to live
  state, so an edit mutated the very config the guard compared against.
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

## Data

- **Generated directories are skipped by the `filter` handed to `fs.cpSync`**, matched on an exact
  path *segment* at any depth: `dist/` and `app/node_modules/` go, `distributed/` and
  `my_node_modules/` stay. Only the paths an entry declares are filtered — a global
  `backups.includePaths` entry is captured as it stands. `.git` is deliberately **kept**: a package
  manager can reinstall `node_modules`, nobody can restore a commit that was never pushed.
- **Backups are zips.** A password makes them WinZip AES-256/AE-2, and zero-byte entries stay
  unencrypted on purpose (p7zip 16.02 reports a CRC failure otherwise). `list()` is sync, so
  encryption flags are cached and refreshed in the background.
- **`trustProxy: true` makes the login lockout advisory.** It trusts `x-forwarded-*` from *any* peer,
  and srvx resolves the client address from the **leftmost** `x-forwarded-for` entry — a value the
  caller writes. Failures are keyed on that address, so a client rotating the header never accumulates
  them: measured, 30 wrong passwords from 30 forged addresses produced **zero** 429s against 27 from a
  fixed one. A startup warning fires for the dangerous combination (`trustProxy` on with a non-loopback
  bind). Not preventable in the app: once the header is trusted, srvx's real peer is `#remoteAddress`,
  private, so the lockout cannot be re-keyed on it. `trustProxy: "loopback"` is a middle option srvx
  supports but the schema does not expose yet; a remote proxy genuinely needs `true`.
- **Compare a secret with `secretEqual`, never `!==`.** `!==` short-circuits at the first differing
  byte, so a caller who can measure response time recovers the secret one byte at a time. The `/_hh`
  channel is the case that matters: it sits outside `/api`, so the run.json token is the *only* guard,
  and the documented threat is another local user — precisely someone who cannot read the 0600 file but
  can time a request. One helper (`src/helpers/secret-compare.ts`) also carries the length check that
  keeps a truncated header from making `timingSafeEqual` throw a 500.
- **Server args are logged *before* `${VAR}` expansion**, so an expanded secret never reaches the
  log buffer, disk, SSE or Telegram.
- **A certificate is valid only *inside* its window.** `validatePair` checked `validTo` alone, so a
  pair whose `notBefore` is in the future was accepted, stored, and made the panel restart onto HTTPS
  — where every browser refuses it, locking the user out with no way back but the filesystem. Both
  ends are now checked in one `validityError()`, which `status()` also uses: the UI names the real
  reason instead of reporting a positive `daysRemaining` and no error. `keyMatches` is a separate
  field on purpose — a window problem must not read as a key mismatch and send you to the wrong file.
  `-not_before`/`-not_after` need OpenSSL ≥ 3.2, so the tests probing that window are behind
  `hasOpensslExplicitDates` (probed, not version-compared: macOS ships LibreSSL).
- **`serve({ tls })` throws synchronously on a pair whose key does not match.** Not a rejected
  `ready()` — the throw happens while the context is built, before `listen()`'s `ready()`/`error` race
  exists, so `listenWithRetry` cannot treat it as a bind failure and `start()` has no fallback: the
  panel simply does not boot, reported as `ERR_OSSL_X509_KEY_VALUES_MISMATCH`. `save()` cannot be atomic
  across two files, and a pair also reaches disk by hand-copy or a restore, so `TlsStore.servable()`
  validates before handing anything to the server and falls back to http with a warning. `status()`
  reports the mismatch as an `error` too — a `keyMatches: false` with a null error read as "enabled and
  fine" while the panel served http.

## Schemas and types

- **`instanceof type.errors`, never `instanceof Error`,** for a schema result: ArkType's errors are
  not `Error`s, so `x instanceof Error` is false for a valid *and* an invalid payload. Six tests
  asserted `expect(schema(v) instanceof Error).toBe(false)` as a conformance check and could never
  have failed. Pass the real `type.errors` plus `JSON.stringify(x)` so a failure prints the payload.
- **ArkType: an optional property (`'x?'`) rejects an explicit `undefined`** — omit the key. Fields
  a UI must clear are `'type | null?'`.
- `ServerView.config.port` is normalized to `number | null`; the hand-narrowed types in
  `contracts.ts` are deliberate.
- **A list paired with the structure that reads it must be checked with a *mutation*, not a reading.**
  `parseGrouped` reports a key absent from `keys` as "unrecognized — this release ignores it" while the
  loop below still parses that group, so one missing entry yields a config that works and a warning
  saying it does not. Both are plain arrays, so nothing caught it: adding a group the list did not name
  gave 0 typecheck errors and 0 test failures. **Count the errors a removal produces, and note where
  they come from** — a guard made of test literals is not the same as one made of production code.

## How to test

`pnpm exec vitest run`; `pnpm run quickcheck` for lint and types. Two habits this repo has learned:

- **A test input must fail for the reason the test claims.** An input refused by an *earlier* check
  pins nothing about the rule you meant to test. Verify by weakening that rule and watching the test
  fail; if it still passes, the input was rejected earlier.
- **Instrument the branch a test claims to reach.** A temporary `console.error` inside it, then run
  that one test — if the probe never fires, the test is decoration. A passing test is not evidence
  it pinned anything.
- **A heuristic tuned for one input shape does not transfer to another.** `nearestWord`'s "half the
  shorter word" bound is right for long command names (`stats`→`status`, distance 1) and wrong for
  short option names, which share prefixes: `--no-open` scored 3 from `--no-yes` and passed a bound of
  3, so the hint named an unrelated flag. It needs a second, absolute bound. The tell is a threshold
  written as a *fraction* of the input: ask what happens when the input is short, or when two valid
  values share a prefix, an extension or a common word.
