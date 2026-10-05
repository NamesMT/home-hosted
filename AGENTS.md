# AGENTS.md

`home-hosted` is a Node 24 / TypeScript harness for self-hosted servers: `up` starts a Hono/srvx
panel (default `127.0.0.1:3999`) that supervises the entries in each workspace's
`servers.config.json` and serves a UI. User docs: `README.md`, `docs/SERVERS.md` (entries and port
conflicts), `docs/NOTIFICATIONS.md`, `docs/DDNS.md`, `docs/REVERSE_PROXY.md`; UI authors:
`docs/UI_CREATION.md`.

State lives only in `$HHOSTED_HOME/.hh` (default `~/.home-hosted/.hh`). Global files sit at its top
level: `settings.json` (listener, auth, TLS policy, host vitals, backups, reverse proxy),
`workspaces.json`, `.control-secrets.json` (0600: password hash, API token hash), `.tls/`,
`.backups/`, `.ui/`, `.logs/` (the panel console), `.proxy/` (the reverse-proxy engine, its generated
configuration and its nanny state), and `run.json` — the live daemon's pid/url/token, 0600. Every workspace owns
`.hh/<id>/`: `settings.json` (server defaults, log retention, notifications, DDNS), `servers.config.json`,
`.secrets.json` (0600: Telegram bot token, plus DDNS credentials sealed with AES-256-GCM under
`HHOSTED_DDNS_SECRET` — only DDNS is sealed, because it is the one thing replayed to a third party),
`.logs/` (per server, `<id>.log` plus `<id>.log.1` … when it rotates), and `.state/` (a persistent entry's nanny state plus its 0600 spawn
spec until the nanny reads it, plus `ddns.json`). A pre-`.hh` instance is relocated automatically by
`ensureLayout()` (`src/config/layout.ts`). The package ships **no servers**: never commit a config, a
seed entry, or a path that names one.

## Commands

```sh
pnpm run up|down|restart|status    # detached; `down` asks /_hh/shutdown, signals are the fallback
                                   # `restart <id>` restarts one server via /_hh, panel stays up
pnpm run start                     # up --foreground (systemd, docker, a foreground shell)
pnpm exec tsx src/cli.ts logs      # the panel's own console output (--lines, --follow, --json)
pnpm dev                           # tsx-watch panel :6000 + the stock UI's Vite :6001 (proxies /api), state in .dev-state/
pnpm dev --ui noc-console          # the same, for another UI; --port/--ui-port override
pnpm run build                     # dist/cli.js + the stock UI (uis/stock/dist)
pnpm run build:uis                 # every UI under uis/, zipped into uis/dist/ (release assets)
pnpm run quickcheck                # eslint + tsc + vue-tsc for every UI under uis/
pnpm exec vitest run               # `pnpm test` is vitest in watch mode
pnpm run check                     # quickcheck + vitest run --coverage
pnpm run set-password              # non-interactive through HHOSTED_PASSWORD
pnpm run set-token                 # --generate prints a new API token once
pnpm run migrate                   # bring the config up to this release's schema
pnpm exec tsx src/cli.ts init      # scaffold a project (interactive; --yes for defaults)
pnpm run media                     # regenerate docs/media (mockups, both served UIs, tour.gif)
```

The published bin is `home-hosted`, with an `hh` alias: both names run the same CLI.

**Dev servers and test instances stay in the 6xxx range** — panel 6000, UI 6001, test-spawned panels
6100+ (`pnpm dev` takes `--ui`/`--port`/`--ui-port`, or `HHOSTED_DEV_PANEL_PORT` /
`HHOSTED_DEV_UI_PORT`). Never assume 3999 is free: an installed panel or another dev instance may hold
it, and the CLI's port preflight runs *before* its config guard, so a busy default port turns config
tests red for the wrong reason.

Releases are dispatched from `.github/workflows/release.yml` with a version (and a `dry-run` switch
that stops before pushing). It verifies the version, lints/types/tests, builds the CLI plus the stock
UI and every UI zip, lets changelogen write the changelog, bump `package.json`, commit and tag
`v<version>`, creates the GitHub release with the UI bundles attached, and publishes to npm through
trusted publishing (OIDC, no token). npm only offers a trusted publisher for a package that already
exists, so the first release has to be published by hand.

Four workflows, and the split is deliberate:

| workflow | runs on | what it proves |
| --- | --- | --- |
| `quickcheck.yml` / `test.yml` | every push and PR | lint, types, the whole suite with coverage — Linux only |
| `cross-platform.yml` | the release gate, or by hand | the same suite on macOS and Windows |
| `release.yml` | dispatched with a version | the platform gate, then tag, publish, release assets |

The platform gate is not a per-push job on purpose: it is the expensive half, and it is what makes a
platform-specific break fail before shipping rather than on someone's machine. It also runs on a
`dry-run`, because that is exactly what a rehearsal needs to exercise. Every job carries a
`timeout-minutes`, so a wedged runner is reported instead of sitting out GitHub's 6-hour default.

**`npm publish` exiting 0 is the whole answer.** The registry can take up to ten minutes to show a
package it has already accepted — that is npm's queue, not this run's, and polling it once cost five
minutes of every release. Do not put that poll back, and do not hold other work waiting for a
release to become visible.

### Which version to dispatch

Below 1.0 the **minor is the breaking channel**: a fix or a non-breaking feature is a **patch**
(`0.6.2` → `0.6.3`), while a minor (`0.6.3` → `0.7.0`) means someone has to read the release notes and
act. A `feat:` commit does not decide this — ask what the user has to do about it.

Never edit `package.json` by hand; changelogen bumps, commits and tags inside the workflow:

```sh
gh workflow run release.yml -f version=0.6.3          # -f dry-run=true to rehearse
```

`scripts/check-release-version.mjs` refuses a patch while a breaking commit is pending, and warns on
a minor without one.

## Architecture (and why)

- `src/cli.ts` — the CLI's thin root. Two things happen before [citty](https://github.com/unjs/citty)
  is asked anything: `--home`/`--project` are peeled off and applied (`src/cli/args.ts`), and the
  curated dispatch — `help`/`version`, `unknown command`, and the `-p 4000` shorthand for `up` — is
  decided, because `#src/helpers/paths.ts` resolves at import time. Its static imports stay node
  builtins, citty and the two path-free local modules (`src/cli/args.ts`, `src/helpers/runtime.ts`);
  every command is a lazy
  `() => import('#src/cli/<command>')` in citty's `subCommands`, so a command module *may* use static
  `#src` imports (that is the whole point of the pre-pass). The hidden `__nanny` is dispatched by an
  early branch, not `subCommands`, so it stays out of the curated help and the unknown-command
  message — the panel spawns it, nobody types it. citty's `runMain` is deliberately not
  used: it prints its own usage and `console.error`s before `process.exit(1)`, replacing `fail()`'s
  one error shape; the root calls `runCommand` and catches. `src/cli/<command>.ts` is one command per
  file — citty owns dispatch and argument parsing, with `--no-autostart`/`--no-install` declared as
  boolean negations rather than literal arg names. The curated `--help` prose stays in `src/cli.ts`
  because citty cannot generate it. `up` re-spawns itself detached as `up --foreground …`, with the
  argv built from the *parsed* flags (`buildDaemonArgv`) plus this file's own URL as the entry, so it
  works under tsx and from `dist/cli.js` alike. `src/cli/io.ts` is the one place the readline prompts
  and colours live; commands take `prompt`/`style` through that seam (`src/cli/ui-switch.ts` keeps
  `UiSwitchIo`).
- `src/index.ts` — `runControlPlane()`: wiring, startup guards (exposure, free port, live run.json),
  `run.json`, signals. Wiring belongs here and nowhere else.
- `src/app.ts` — the Hono root, chained routes only. `/_hh` is mounted *before* the `/api/*` auth
  guard on purpose (a local `down` uses run.json's token, not a session). `AppType` is the route type
  that `hc<AppType>` clients and the OpenAPI document derive from.
- `src/api/**` — one file per URL group (`$.routes.ts` = several routes), mirroring the path.
- `src/shared/contracts.ts` — every ArkType schema (config, API and SSE DTOs), shared with the UIs;
  the OpenAPI spec is generated from it, never hand-written.
- `src/config/` — split by scope. `settings.ts` (`GlobalSettingsStore`: `.hh/settings.json` — listener,
  auth, TLS policy, host vitals, backups) and `store.ts` (`WorkspaceStore`: a workspace's
  `settings.json` + `servers.config.json`, validate/merge/atomic commit, reporting
  `configError`/`configWarnings` instead of throwing on a bad file). `workspaces.ts` is the registry
  (`workspaces.json`), `layout.ts` the one-time relocation of a pre-workspace `$HHOSTED_HOME`.
  `schema.ts` holds the three on-disk shapes plus the `meta` stamp, `parse.ts` the tolerant readers
  (`parseGlobalSettings`/`parseWorkspaceSettings`/`parseServersFile`: unknown keys are reported and
  kept, everything else blocking), `patch.ts` the merge helpers, `migrations.ts` the schema constant
  and ordered step registry, and `secrets.ts`/`seed.ts` the two secret scopes and the seeds.
- `src/providers/` — stateless leaves: `process` (spawn, `terminate`, `terminatePid` for a process we
  adopted), `port` (probe, holder lookup, `terminatePids`), `proc` (the sampler, plus
  `processCarriesServerId` for the environment marker and `processTreePids` for tree ownership),
  `identity` (which port holder is this entry's own successor: marker first, then resolved image +
  argv), `nanny` (a persistent entry's spec/state files and the liveness rules for one),
  `log-tail` (an offset reader that survives rotation and truncation), `ddns/` (one `DdnsProvider` per
  registrar over one HTTP call each, plus `ip` and `zone` helpers), `proxy/` (the reverse-proxy
  engines this build can drive: where the binary comes from and how to start it — the route model
  stays the panel's), health-check, host, telegram, archive.
- `src/services/` — stateful orchestration: `panel` (one `WorkspaceRuntime` per workspace, workspace
  CRUD, and the single aggregate state frame — every per-workspace service hangs off it), supervisor,
  control-server, config-watch, state, auth + exposure, dependencies, history, log-buffer/log-files,
  notifications, host-monitor, ddns, proxy, backups, tls, ui, plus `init` (the scaffold behind
  `home-hosted init`: a manifest, a `.gitignore`, and the prompts stay in the CLI), `nanny` (the
  process a persistent entry runs under) and `log-relay` (the tailer that feeds its lines to the
  supervisor). It names no server — the scaffold must stay as neutral as the supervisor.
- `src/middleware/auth.ts` — the `/api/*` guard, and `requestIdentity()`, the one place a request's
  credentials are read: the `hh_session` cookie or `Authorization: Bearer <api token>`. A token is
  a first-class credential (same authority as a signed-in browser) and is verified from the secrets
  file on every request, so `set-token` needs no restart.
- `src/helpers/` — paths (`dataRoot` vs `projectDir`), daemon (run.json + a loopback probe that
  bypasses `fetch`, so TLS with a self-signed pair still answers), error, validator, atomic,
  template, env-file, openapi, factory.
- `uis/<name>/` — each UI is a Vite app (Vue 3 + Tailwind v4) built through `uis/vite.shared.ts`;
  `stock` is the one shipped inside the package. Aliases: `@` → that UI's `src`, `@shared` →
  `src/shared`, `@server` → `src` (**types only** — never import runtime server code into a UI).
  Its `public/ui.json` is the UI's identity: `name` and `version` (what Global Settings → Interface shows),
  `repo`/`tag`/`asset` (which release carries it, for `ui-update`) and `unix` (when it was built).
  `UiService` carries those fields into the installed `$HHOSTED_HOME/.ui/ui.json` unchanged and adds
  `uploadedAt`/`files` of its own.
- **Bumping a UI ships a new asset, so its `ui.json` is part of the change — and it is bumped once,
  when the commit is made, not on every edit.** A commit that alters what a UI *ships*
  (`uis/<name>/src`, `public`, its build inputs — not `test/`, which is not in the asset) raises that
  `ui.json`'s `version`: patch for a fix, minor for a feature, and **major only for a rewrite or a
  restyle**. The number is what tells a person how big the change is — `ui-update` prints it and holds
  it against the release it is offering. `unix` is that commit's own epoch, never a leftover from
  whenever the file was edited: `scripts/stamp-uis.mjs` runs from the pre-commit hook, stamps it, and
  refuses a commit that changed a shipped UI without raising its version. `tag` is what pairs an
  official UI with its panel, and it is **stamped by `build-uis.mjs`**, not trusted from the source
  file: a UI zip is built before its release is cut, so the committed value is always a release behind
  the asset it ends up inside. The release workflow passes `HHOSTED_UI_TAG`; anywhere else the build
  stamps `v<package.json version>`. Do not hand-edit `tag` to chase a release — a stale one makes
  `ui-update` re-install the same UI on every boot.
- `bin/home-hosted.mjs` — the published bin: `dist/cli.js`, or `src/cli.ts` through tsx when the
  build is missing (a linked checkout).
- `scripts/` — `build-uis.mjs` (build one UI, optionally zip it), `typecheck-uis.mjs`,
  `capture-media.mjs` (the README's media), `check-release-version.mjs` and `release-notes.mjs`
  (used by the release workflow), `dev.mjs` (`pnpm dev`).
- `docs/` — the topic docs (`SERVERS.md`, `NOTIFICATIONS.md`, `DDNS.md`, `REVERSE_PROXY.md`,
  `UI_CREATION.md`),
  `mockups/*.html` (hand-written UI examples in four directions) and `media/*`: their screenshots plus
  the README's `tour.gif`, all regenerated by `pnpm run media`. Only the five `.md` files are
  published; the media is a build artifact.

## Conventions

- `#src/*` imports inside `src/`; UIs use `@shared/*`.
- A single on/off setting is a `ToggleSwitch`; `CheckField` is only for picking items out of a set
  (the restore plan). A checkbox in a `FieldGroup` grid reads as misaligned next to the inputs.
- A create body carries only what differs from what the entry would inherit — the schema's defaults
  with `Workspace Settings → Server defaults` on top (each UI's own `inheritBaseline` plus the shared
  `diffFields` in `src/shared/patch-diff.ts`). A value written into `servers.config.json` stops
  following those defaults, so anything the person did not decide stays out; the editor applies the
  same rule to an edit.
- ArkType at every runtime boundary: routes use `validate('json'|'query'|'param', schema)` then
  `c.req.valid(...)`; ad-hoc payloads use `parseOrThrow`. Schemas reject undeclared keys.
- Every failure is a `DetailedError` (`@namesmt/utils`), mapped by `src/helpers/error.ts` into one
  envelope `{ message, code, detail }`. Never hand-roll `c.json({ error })`.
- Document routes with `describeRoute` + `jsonBody(schema)`; `jsonBody` needs a real schema.
- Patch schemas carry no defaults; nested groups (`restart`/`health`/`stop`/`auth`/`tls`/`telegram`/
  `http`) merge key-by-key, and an explicit `null` clears a key. `ddns` is the exception: its
  `accounts`/`domains` lists are **replaced** (a merge cannot express removing a hostname), and only
  `ipv4`/`ipv6` merge.
- Two-sided bounds read inclusively (`'1 <= number.integer <= 512'`). `test/shared/contracts.test.ts`
  pins every boundary and the patch/schema parity — update it with any schema change.
- A new field in a **response** DTO is optional (`'x?'`) and its clients read it defensively. An
  upgrade writes a new `uis/stock/dist` to disk while the old panel process is still serving, so a
  new UI meets an older payload for a while — a required field there rejects the whole frame and
  blanks the app. Request bodies and config keep their strict, defaulted shape.
- Conventional commits; ESLint via `@antfu/eslint-config`; sparse comments.
- UI tests live in `uis/<name>/test/`: pure modules on node, and a component that is worth
  guarding mounts under `// @vitest-environment happy-dom` (see `number-field.test.ts`). Reach for
  that rather than trusting a component to be thin: `NumberField`'s setter assumed the string a text
  input reports, but Vue casts `<input type="number">` to a *number* first, so `raw.trim()` threw and
  every value typed into a numeric field was silently discarded — no pure-module test could see it.
  The suite resolves `@/…` from the UI that asks, so each UI's own tests can import its own
  components; a single pinned target made every UI but that one untestable, and resolved a
  `noc-console` test's `@/lib/proxy` to *stock's* differing copy without a murmur.
- A destructive action that is one click away confirms in a **popover** (`KillPortButton.vue`),
  never by arming the same button for a second press: an impatient double click on an arming
  button fires it. Keep the safe choice first in the popover's tab order.
- **Docs ship with the change.** A user-visible change updates the docs that describe it
  (`README.md`, `docs/*.md`) in the same commit — do not forget them; a stale doc is a bug like
  stale code.
- **UIs move together.** `uis/stock` is not the only client: a change to it — or to a shared
  contract it reads — lands in every other UI under `uis/`, and each altered UI bumps its
  `ui.json` per the rule above.

## Compatibility

Two surfaces outlive the release that wrote them: **configs absolutely, UIs within reason.** Breaking
either is a last resort, and never an accidental one.

- **A config written by an older release has to load in a newer one.** That direction is the priority:
  add fields with defaults, never repurpose or remove one, and treat every existing key as permanent.
- **Both directions matter, and both are now handled.** An unrecognized key is read, reported and
  left on disk instead of failing anything: it is the normal way a config from a newer release looks
  here. Anything that is not merely unrecognized — a wrong value, a duplicate id, an unreadable file —
  stops the panel instead of being papered over with defaults.
- **The UI moves in minor steps.** Routes, response fields and SSE frames are additive: keep the old
  one and add the new one. A new response field is optional (`'x?'`) and read defensively, because an
  upgrade writes a new `uis/stock/dist` while the old panel process keeps serving — and a
  user-uploaded UI may be older than the panel it talks to.
- **Breaking is allowed; silent is not.** When nothing compatible can be done, say so in the final
  answer *and* in the commit message with a `BREAKING CHANGE:` footer, naming the exact migration the
  user must run.
- **A config records what wrote it.** Every write stamps a top-level `meta`
  (`{ writtenBy, schema }`): the release that wrote the file and the config shape it wrote. An
  unstamped file reads as the current schema, so nothing that existed before needed changing.
- **Nobody runs a config this release cannot read.** `up` refuses to start — exit 1, the exact
  problem printed — when the file is unparseable, has an invalid value or a duplicate id, carries a
  newer `meta.schema`, or has a registered migration pending. A panel that is *already* running keeps
  the config it has and only reports the error, so a bad edit never disturbs supervision.
- **Unknown keys are dropped from the resolved config, kept on disk, and listed in a startup
  warning.** Dropping one is the normal way a newer config looks here, so it must never fail the
  group it sits in (that used to reset `control` — port, bind, auth policy — to schema defaults).
  A *write* to a group validates the same tolerant way (`parseTolerant` via the store), so a key this
  release does not know never blocks a save — removing a key from a schema must not brick the page
  that writes it.
- **Migrations ship inside the package** (`src/config/migrations.ts`), are ordered, idempotent and
  described in one line each. `home-hosted migrate` prints the plan, keeps a `.bak` beside each file it
  rewrites, refuses to write a config it cannot read, and needs consent: `--yes`, `HHOSTED_MIGRATE=allow`,
  or a person at a terminal. The layout relocation is not a schema change: it runs automatically from
  the CLI pre-pass (`ensureLayout()`), so an upgrade never starts against a half-moved directory. Starting a fetch of migration
  code from GitHub was considered and rejected: the panel supervises processes, so remote code is an
  RCE surface, and a migration would age against a newer store API anyway.

## Rules that matter

- **Server-agnostic.** No blessed ids, no `dataDir`-style globals: a server gets only its own
  `command`/`args`/`env`/`dataEnvs`/`envFile`/`bootstrap`. A test fails if a core file learns one.
- **Paths.** `dataRoot` is state, and the state itself lives under `dataRoot/.hh` (global files plus
  one directory per workspace); `projectDir` is the base for relative entry paths. `{id}{port}`
  `{host}{bind}{cwd}{projectDir}{dataRoot}{home}` and `${ENV}` expand in config; there is no
  package-relative state.
- **Secrets never enter the config.** Global `.hh/.control-secrets.json` holds the password hash and
  API token hash, each workspace's `.secrets.json` holds its Telegram token and DDNS credentials, and
  the TLS pair sits in `.hh/.tls/`; every one is 0600 and the config holds only policy.
- **A port holder that is this entry's own successor is not a stranger.** A program that restarts
  itself leaves a detached process behind; with `follow` the panel adopts it as-is (pid, liveness,
  health, resources, stop — but not its output); with `reclaim` it stops that successor and starts a
  fully supervised child instead; with `kill` it stops whatever holds the port without asking whose it
  is. All three beat blocking forever on a port that is already serving, and only `kill` ever touches a
  process the panel could not identify — which is why it logs the pids it stopped.
  Ownership is read from `HHOSTED_SERVER_ID` in the environment (`/proc` on Linux, `ps -E` on macOS),
  falling back to the entry's own resolved image **plus its expanded argv** where that is unavailable
  or unmatched — the fallback is what gives `follow`/`reclaim` any reach on Windows, which exposes no
  per-process environment. That fallback is strict on purpose, because `reclaim` kills what it
  identifies: arguments are compared **literally** (never by basename — `/srv/a/server.js` must not
  match `/tmp/b/server.js`), an argument can never be satisfied by a word that is not in the argv, and
  two matching holders mean the panel refuses to guess and blocks. It still cannot see through a
  Windows `.cmd` shim (the holder is `node.exe`, whose argv never mentions the shim) or a macOS
  argument containing a space (`ps` joins argv without quoting); those cases block, and `kill` is the
  answer for them. `src/providers/identity.ts` owns the matching, and the argv it is given comes from
  the supervisor's single `resolveSpawn()`, the same one the spawn itself used — keep it to one
  resolver, because a second one that expands or filters args differently re-opens these cases.
  Ownership covers the entry's whole **tree**, not the pid it recorded (`processTreePids`): a nanny
  puts the real server one generation down, and so does any wrapper entry. The panel's own tree is
  deliberately excluded — "ours" has to mean a process a server owns.
- **A persistent entry is run by its own nanny, not by the panel.** `persistent: true` makes the panel
  spawn the hidden `__nanny` (`src/services/nanny.ts`), which owns the child's pipes, writes its JSONL
  and mirrors its exit — the only arrangement that outlives the panel *and* keeps logging. The panel
  skips such an entry in `stopAll()`/`dispose()` (`down` reports what it left running), reattaches on
  boot through `.state/<id>.json` before any port preflight (`nannyIsAlive` = live pid **and** a fresh
  heartbeat, the `HHOSTED_SERVER_ID` marker or the argv), tails that file for live logs, and reads
  `lastExit` once so a crash nobody watched is reported. The spawn spec is consumed by the read and
  swept at boot — it carries expanded env. Three lifetimes are pinned: the nanny **exits with its child**
  (an inherited pipe would keep it alive, and the panel would report a healthy entry whose server is a
  detached stranger), a stop reaches the child by pid from the state file, because `SIGKILL` and
  `killGroup: false` cannot be forwarded — which is why a self-restarting program belongs on `reclaim` —
  and its `SIGTERM`/`SIGINT` traps are armed *before* the child exists and before that state file
  appears, so a stop that beats the spawn can never orphan a child nobody has a record of.
  The nanny never restarts anything: retries and health stay the supervisor's. `logs.persist: false`
  keeps that file out of the Logs page but never stops it being written — it is the transport.
- **A port is only ever freed by re-listing its listeners.** `POST /api/servers/:id/free-port` never
  trusts a pid quoted in a message, and refuses any listener in `supervisedPids()` (the panel plus
  every entry's child) instead of killing it — a port held by a sibling is a config mistake.
- **Never expose beyond loopback without auth and a non-default password.** `checkExposure()` is the
  single rule, enforced at startup, on every settings write, and in the UI.
- **The CLI drives a running panel through `/_hh`, never `/api`.** `down` and `start`/`stop` read
  run.json's token and speak over loopback through one guard (`assertLocalCall`), so they need no
  session, password or API token — and a new local command must not open an unauthenticated `/api` route.
- **A server id is only unique inside its workspace.** Anything keyed by id alone — SSE
  (`EventHub` scopes on `serverKey(workspaceId, serverId)`), log buffers, series, route params — must key
  on the pair, or two workspaces' same-named servers mix frames.
- **A workspace is the ownership boundary.** Servers, secrets, logs and nanny state belong to exactly
  one workspace; only listener, auth, TLS, host vitals, backups, UI and `run.json` are panel-wide.
  A per-workspace service is reached through `PanelService.requireWorkspace(id)`, never a module global.
- **UIs are external clients.** Nothing in `src/**` may know a UI's markup or files;
  `$HHOSTED_HOME/.hh/.ui` overrides the packaged UI at runtime.
- **A restore writes only where a config says** — archive allowlist, `origin` matching first,
  symlinks never recreated.
- **The reverse proxy's engine is a process the panel owns, not a server entry.** Its generated
  configuration is applied through the engine's admin API (atomic, never hand-edited), the engine runs
  under the same nanny a `persistent: true` entry uses so a panel restart does not drop the socket,
  and its admin endpoint stays panel-side — a unix socket in a `0700` directory, loopback plus the
  engine's origin check on Windows. A route that points at the panel is exposure and obeys
  `checkProxyExposure()`, the same bar as a non-loopback bind.
- **Cross-platform.** Linux/macOS/Windows: `/proc` vs `ps` vs Win32_Process, process groups vs
  `taskkill /T`, graceful fallbacks, no shell utilities assumed.
- **Writes are atomic** (`writeFileAtomic`) and validated before commit.

## Gotchas

- `run.json` is the daemon's identity and `down`'s credential; keep `runtimeSchema` in sync with the
  `Runtime` written in `src/index.ts`. It now lives at `.hh/run.json`.
- **`ensureLayout()` runs before any command resolves a state path** (the CLI pre-pass) and is
  idempotent. It moves rather than copies, never overwrites an existing `.hh` file, and removes a
  legacy directory only when every entry in it actually moved — a refused move must not become a
  delete.
- Moving the listener (host/port/TLS) kills the connection answering that request, so
  `PATCH /api/settings`, the TLS routes and `/_hh/shutdown` defer with `afterResponse()`.
- `Supervisor.start()` sets `starting` synchronously before its first await, and `stop()` sets
  `stopping` first: overlapping calls would double-spawn or resurrect a stopped process. Tests must
  call `supervisor.dispose()`. `stopping` is cleared on **every** exit path of `stopEntry()`: the
  early return for an entry with no child used to leave it set, and since `start()` refuses while it
  is true, one Stop on an already-stopped server made that entry unstartable until a daemon restart.
- Timers and `void`-ed promises in the supervisor carry a `.catch`: a throw in the tick or in a retry
  is an unhandled rejection, and Node 24 ends the process on one.
- **`Workspace Settings → Server defaults` merge into the nested groups key by key** (`mergeDefaults`
  in `src/config/schema.ts`, used by the servers parser and `validateServer`). A shallow
  `{ ...defaults, ...entry }` lets an entry that decides `restart.maxRetries` silently drop the
  workspace's `restart.baseDelayMs` — and the create/edit diff flow depends on inheriting exactly that.
- The curated CLI dispatch reads only the **flag** forms (`--help`/`-h`, `--version`/`-v`) after a
  command name, never a bare `help`/`version`: that is an option's value (`init --name help`).
- Port preflight re-probes after 300 ms — a just-closed listener can still complete a handshake.
- **A workspace's config is re-read whenever its files change on disk** (`src/services/config-watch.ts`
  → `WorkspaceStore.reloadFromDisk()`, wired per workspace in `src/services/panel.ts`). The watch is on the *directory*, because
  an editor's save is a temporary file renamed over the target — the inode changes, the name does not
  — and a two-second poll backs it up where `fs.watch` is undependable (network mounts). The store
  compares the bytes it last read and the bytes it wrote, so the panel's own saves never reload
  anything, and a revision it cannot read (unparseable JSON included — that path used to fall back to
  an *empty* config until a watcher made it reachable, which would have stopped every server) is
  reported in the state frame while the running config is kept. A changed definition takes effect on
  that entry's next start; only an added `autostart` entry is started, and `--no-autostart` still
  means the panel starts nothing on its own.
- **The shell must watch the *session*, not only the flags it derives.** With authentication off,
  `authRequired` and `authenticated` are both `false` from the first paint to the last, so a watcher
  on those two never ran after the session landed: the panel never opened its event stream, the
  connection badge sat on "Connecting", and the dashboard showed one stale snapshot forever. Both
  UIs turn it into a single `streamDecision(session)` value (`wait` | `connect` | `login`) and watch
  that, which is also what the test pins.
- **A form that copies live state must guard per block, never globally.** The host thresholds and the
  backups policy arrive from `/api/settings` *after* the SSE frame, so a single "has anything
  changed?" gate leaves them showing schema defaults forever — the backups toggle reported itself as
  changed and flipped back to `true` on every reload. `uis/stock` compares each block against the
  snapshot it was last filled from (`blockSnapshot`/`isBlockEdited`, `syncFromLive`) and reads the
  file-only blocks on their own. The copy has to be **detached**, too: a shallow one leaves a nested
  group (`health.http`) aliased to live state, so an edit to "Healthy below status" mutated the very
  config the guard compared against and the next frame reset the whole editor (`cloneHealth`).
- **An absolutely positioned element inside a *static* scroll container resolves against the
  page, not the scroller** — an `sr-only` label in a table row was enough to give the document a
  second, empty scrollbar. The shell's `main` carries `relative` for that reason; keep it there.
- **A dialog's footer has to be a flex sibling of a scrolling body** (`uis/stock/src/components/ui/Modal.vue`):
  the sheet is `flex flex-col` with `max-h-[88dvh]`, the body `min-h-0 flex-1 overflow-y-auto`. When
  only the body carried a max-height, a tall form pushed its own save button below the clipped
  edge — the add-server dialog looked like it had no save button at all.
- Vue does not notify a computed's subscribers when its recomputed value is `Object.is`-equal to the
  old one, so anything mutated in place silently freezes every value derived from it. The log buffers
  (`uis/stock/src/composables/useControlPlane.ts`) therefore hand out a **new array per batch**, and
  the `version` counter only exists to make the views re-read at all. Getting this wrong is what kept
  the live output view empty until a remount — a test that reads the array itself will not catch it.
- An adopted process is not a `ChildProcess`, so nothing reports its exit: the tick polls liveness and
  hands the entry back to the normal `afterExit` path. Its output is not captured either — it was
  redirected by whoever spawned it. The exception is a persistent entry, whose output the panel
  *does* capture: its nanny writes the JSONL, and `log-relay` tails it into the same buffer and SSE
  frames a pipe would feed.
- `stop.killPortHolders` frees a port only from a *listener* that is not our own process tree. Broad
  `lsof -ti:<port>` sweeps and pid-as-text parses have killed supervisors in the field; don't add one.
  `free-port` reuses the same lookup and adds the supervisor's own pid set on top.
- `ServerView.config.port` is normalized to `number | null`; the hand-narrowed types in
  `contracts.ts` are deliberate.
- ArkType: an optional property (`'x?'`) rejects an explicit `undefined` (omit the key). Fields a UI
  must clear are `'type | null?'`.
- **`instanceof type.errors`, never `instanceof Error`,** for a schema result: ArkType's errors are
  not `Error`s, so `x instanceof Error` is false for a valid *and* an invalid payload. Six tests
  asserted `expect(schema(v) instanceof Error).toBe(false)` as a conformance check and could never
  have failed; pass the real `type.errors` plus `JSON.stringify(x)` so a failure prints the payload.
- Server args are logged *before* `${VAR}` expansion, so an expanded secret never reaches the log
  buffer, disk, SSE or Telegram.
- Backups are zips; a password makes them WinZip AES-256/AE-2, and zero-byte entries stay
  unencrypted on purpose (p7zip 16.02 reports a CRC failure otherwise). `list()` is sync, so
  encryption flags are cached and refreshed in the background.
- Generated directories are skipped by the `filter` handed to `fs.cpSync`, matched on an exact path
  segment at any depth (`src/shared/generated.ts`): `dist/` and `app/node_modules/` go, while
  `distributed/` and `my-node_modules/` stay. Only the paths an entry declares are filtered — a
  global `backups.includePaths` entry is captured as it stands.
- `vite.server.config.ts` targets `node22` while `engines` requires >= 24 — deliberate margin, leave it.
- `pnpm test` watches; CI runs `vitest run`.
- `pnpm run media` drives Chromium through Playwright, which needs fonts *and* the X/NSS/Mesa
  libraries. In a bare container point `FONTCONFIG_PATH` at a `fonts.conf` covering any TTF and
  `LD_LIBRARY_PATH` at a directory holding those libraries — without fonts, Skia panics instead of
  rendering, and the failure looks like a broken page rather than a missing package.

## Where to extend

- **Route**: `src/api/<x>.ts` (chained factory) → mount in `src/app.ts` → schemas in
  `src/shared/contracts.ts` → `describeRoute` + `jsonBody`. A workspace-scoped route takes
  `?workspace=<id>` (`workspaceQuerySchema` + `requireWorkspace` in `src/helpers/workspace.ts`); an
  omitted id means the default workspace, never another one.
- **Server field**: `serverSchema` + its patch in contracts, merge keys in `config/patch.ts` when
  nested, the form in `uis/stock/src/components/settings/`, and the contract tests.
- **UI**: a new `uis/<name>/` with a `vite.config.ts` from the shared factory;
  `node scripts/build-uis.mjs <name> --zip`. The contract is `docs/UI_CREATION.md`. A change to one
  UI (`stock`, `noc-console`) is carried to the others in the same commit.
- **Capability**: a stateless `src/providers/*` returning plain data; a DDNS provider is one file plus
  a registry line (`src/providers/ddns/index.ts`), and the settings form, credentials and validation
  follow from its metadata — see `docs/DDNS.md`.

## Publishing

`pnpm pack` runs `prepack` (a full build) and ships `bin/`, `dist/`, `uis/stock/dist`, `README.md`, `docs/DDNS.md`,
`docs/SERVERS.md`, `docs/NOTIFICATIONS.md`, `docs/REVERSE_PROXY.md`, `docs/UI_CREATION.md`, `AGENTS.md` and `LICENSE`. The bin falls back to tsx so `pnpm link` works before a
build; `vue`/`vue-router` are devDependencies because the UIs are prebuilt.
