# AGENTS.md

`home-hosted` is a Node 24 / TypeScript harness for self-hosted servers: `up` starts a Hono/srvx
panel (default `127.0.0.1:3999`) that supervises the entries in each workspace's
`servers.config.json` and serves a UI. User docs: `README.md` and `docs/` (SERVERS, NOTIFICATIONS,
DDNS, REVERSE_PROXY, UI_CREATION).

State lives only in `$HHOSTED_HOME/.hh` (default `~/.home-hosted/.hh`). Global files sit at its top
level: `settings.json` (listener, auth, TLS policy, host vitals, backups, reverse proxy),
`workspaces.json`, `.control-secrets.json` (0600: password hash, API token hash), `.tls/`,
`.backups/`, `.ui/`, `.logs/` (the panel console), `.proxy/` (the engine, its generated config and
nanny state), and `run.json` (the live daemon's pid/url/token, 0600). Every workspace owns
`.hh/<id>/`: `settings.json` (server defaults, log retention, notifications, DDNS),
`servers.config.json`, `.secrets.json` (0600: Telegram token, plus DDNS credentials sealed with
AES-256-GCM under `HHOSTED_DDNS_SECRET` — only DDNS is sealed, because it is the one thing replayed
to a third party), `.logs/` (per server, `<id>.log` plus `<id>.log.1` when it rotates), and
`.state/` (nanny state, its 0600 spawn spec until read, `ddns.json`). A pre-`.hh` instance is
relocated automatically by `ensureLayout()`. **The package ships no servers**: never commit a config,
a seed entry, or a path that names one.

## Deeper docs

Read on demand, not every session. `AGENTS.md` holds orientation and the hard rules; these hold the
reasoning and the traps.

| file | what it covers |
| --- | --- |
| [`.agentDocs/ARCHITECTURE.md`](.agentDocs/ARCHITECTURE.md) | what each module owns and why; UI versioning |
| [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md) | the traps this codebase already paid for, with causes |
| [`.agentDocs/COMPATIBILITY.md`](.agentDocs/COMPATIBILITY.md) | config and UI compatibility, migrations |
| [`docs/SERVERS.md`](docs/SERVERS.md) | entries, port conflicts, persistent entries (user-facing) |
| [`docs/UI_CREATION.md`](docs/UI_CREATION.md) | the contract for a new UI |

## Commands

```sh
pnpm run up|down|restart|status    # detached; `down` asks /_hh/shutdown, signals are the fallback
                                   # `restart <id>` restarts one server via /_hh, panel stays up
pnpm run start                     # up --foreground (systemd, docker, a foreground shell)
pnpm exec tsx src/cli.ts logs      # the panel's own console output (--lines, --follow, --json)
pnpm dev                           # tsx-watch panel :6000 + the stock UI's Vite :6001, state in .dev-state/
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
6100+ (`--port`/`--ui-port`, or `HHOSTED_DEV_PANEL_PORT`/`HHOSTED_DEV_UI_PORT`). Never assume 3999 is
free: an installed panel or another dev instance may hold it, and the CLI's port preflight runs
*before* its config guard, so a busy default port turns config tests red for the wrong reason.

## Releases

Dispatched from `.github/workflows/release.yml` with a version (`-f dry-run=true` to rehearse). It
verifies the version, lints/types/tests, builds the CLI and every UI zip, lets changelogen write the
changelog and bump `package.json`, commits and tags `v<version>`, creates the GitHub release with the
UI bundles attached, and publishes to npm through trusted publishing (OIDC, no token). npm only
offers a trusted publisher for a package that **already exists**, so a first-ever release has to be
published by hand.

```sh
gh workflow run release.yml -f version=0.6.3
```

Four workflows, and the split is deliberate:

| workflow | runs on | what it proves |
| --- | --- | --- |
| `quickcheck.yml` / `test.yml` | every push and PR | lint, types, the whole suite with coverage — Linux only |
| `cross-platform.yml` | the release gate, or by hand | the same suite on macOS and Windows |
| `release.yml` | dispatched with a version | the platform gate, then tag, publish, release assets |

The platform gate is not a per-push job on purpose: it is the expensive half, and it is what makes a
platform-specific break fail before shipping rather than on someone's machine. Every job carries a
`timeout-minutes`, so a wedged runner is reported instead of sitting out GitHub's 6-hour default.

**Read the skip count, not just the tick.** Linux has no skips; macOS and Windows report a handful
(Windows more), all from platform guards. What to watch is the *shape*: a new skip appearing, or a
clean pass where a guard should have fired. **A test that returns early instead of skipping reports a
pass**, hiding a platform that never ran the code — use `it.runIf`/`it.skipIf` with the condition
computed at **module load**.

**`npm publish` exiting 0 is the whole answer.** The registry can take up to ten minutes to show a
package it has accepted — npm's queue, not this run's. Do not poll it, and do not hold work waiting.

### Which version to dispatch

Below 1.0 the **minor is the breaking channel**: a fix or non-breaking feature is a **patch**, while a
minor means someone has to read the release notes and act. A `feat:` commit does not decide this —
ask what the user has to do about it. Never edit `package.json` by hand; changelogen bumps inside the
workflow. `scripts/check-release-version.mjs` refuses a patch while a breaking commit is pending.

## Rules that matter

These prevent defects if broken. They stay here rather than in `.agentDocs/` for that reason — a rule
nobody reads is worse than a long file.

- **Server-agnostic.** No blessed ids, no `dataDir`-style globals: a server gets only its own
  `command`/`args`/`env`/`dataEnvs`/`envFile`/`bootstrap`. A test fails if a core file learns one.
- **Paths.** `dataRoot` is state, under `dataRoot/.hh`; `projectDir` is the base for relative entry
  paths. `{id}{port}{host}{bind}{cwd}{projectDir}{dataRoot}{home}` and `${ENV}` expand in config;
  there is no package-relative state.
- **Secrets never enter the config.** Only policy goes in a config file; every secret is 0600.
- **Never expose beyond loopback without auth and a non-default password.** `checkExposure()` is the
  single rule, enforced at startup, on every settings write, and in the UI. `checkProxyExposure()` is
  the same bar for a proxy route pointing at the panel — **`tls` does not change that bar.**
- **The CLI drives a running panel through `/_hh`, never `/api`.** `down` and `start`/`stop` read
  run.json's token over loopback through one guard (`assertLocalCall`), so they need no session. A new
  local command must not open an unauthenticated `/api` route.
- **A server id is only unique inside its workspace.** Anything keyed by id alone — SSE, log buffers,
  series, route params — must key on `(workspaceId, serverId)`, or same-named servers mix frames.
- **A workspace is the ownership boundary.** Servers, secrets, logs and nanny state belong to exactly
  one; only listener, auth, TLS, host vitals, backups, UI and `run.json` are panel-wide. Reach a
  per-workspace service through `PanelService.requireWorkspace(id)`, never a module global.
- **UIs are external clients.** Nothing in `src/**` may know a UI's markup or files;
  `$HHOSTED_HOME/.hh/.ui` overrides the packaged UI at runtime.
- **A restore writes only where a config says** — archive allowlist, `origin` matching first, symlinks
  never recreated.
- **A port is only ever freed by re-listing its listeners.** `free-port` never trusts a pid quoted in
  a message, and refuses any listener in `supervisedPids()` instead of killing it.
- **Only `kill` ever touches a process the panel could not identify** — which is why it logs the pids
  it stopped. `follow` adopts this entry's own successor, `reclaim` replaces it. Ownership is the
  entry's whole **tree**, and the panel's own tree is excluded. Full matching rules:
  [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **A persistent entry is run by its own nanny** (`src/services/nanny.ts`), which owns the pipes and
  mirrors the exit — the only arrangement that outlives the panel *and* keeps logging. The nanny
  never restarts anything: retries and health stay the supervisor's. Three lifetimes are pinned (it
  exits with its child; a stop reaches the child by pid; its signal traps arm before the child
  exists) — see [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md).
- **The reverse proxy's engine is a process the panel owns, not a server entry.** Its config is
  applied through the engine's admin API (atomic, never hand-edited), it runs under the same nanny a
  `persistent: true` entry uses, and its admin endpoint stays panel-side.
- **Cross-platform is a hard requirement.** Linux/macOS/Windows: `/proc` vs `ps` vs Win32_Process,
  process groups vs `taskkill /T`, graceful fallbacks, no shell utilities assumed.
- **Writes are atomic** (`writeFileAtomic`) and validated before commit.

## Conventions

- **Server-agnostic core; UIs are clients.** `#src/*` inside `src/`; UIs use `@shared/*` (and
  `@server` for types only).
- **ArkType at every runtime boundary.** Routes use `validate('json'|'query'|'param', schema)` then
  `c.req.valid(...)`; ad-hoc payloads use `parseOrThrow`. Schemas reject undeclared keys.
- **Every failure is a `DetailedError`** (`@namesmt/utils`), mapped by `src/helpers/error.ts` into one
  envelope `{ message, code, detail }`. Never hand-roll `c.json({ error })`.
- **Document routes with `describeRoute` + `jsonBody(schema)`**; `jsonBody` needs a real schema.
- **Patch schemas carry no defaults**; nested groups merge key-by-key and an explicit `null` clears a
  key. `ddns`'s `accounts`/`domains` are **replaced** — a merge cannot express removing a hostname.
- **Two-sided bounds read inclusively** (`'1 <= number.integer <= 512'`). `test/shared/contracts.test.ts`
  pins every boundary and the patch/schema parity — update it with any schema change.
- **A new response *field* is optional (`'x?'`)** and read defensively: an upgrade writes a new UI
  while an old panel keeps serving, so a required field blanks the app.
- **A single on/off setting is a `ToggleSwitch`**; `CheckField` is only for picking items out of a set.
- **A destructive action one click away confirms in a popover**, never by arming the same button for a
  second press — an impatient double click fires an armed button. Safe choice first in tab order.
- **Conventional commits**; ESLint via `@antfu/eslint-config` owns formatting; sparse comments.

## Conciseness (applies everywhere)

**Prune verbose; keep correctness.** This covers code, comments, user docs and agent docs alike.

- Code: say it once, name it well; a comment only for non-obvious *intent*, never to restate the line.
- Docs: one idea per sentence, prefer a table or a line to a paragraph. Cut a sentence that would not
  change what a reader does.
- Delete history that `git log` already holds. Keep the *rule* that came out of it, not the story —
  a path list of where something used to live is archaeology, not guidance.
- Do not drop a caveat to save a line. Concise means no filler, not fewer facts.

## User-facing docs

`README.md` and the topical `docs/*.md` are for a person, not an agent:

- **Concise first read**, depth behind collapsible `<details>` spoilers, and **visuals for skimmers**
  — the media in `docs/media/` is regenerated by `pnpm run media`.
- **Docs ship with the change.** A user-visible change updates the docs that describe it in the *same
  commit*. A stale doc is a bug like stale code.
- **UIs move together.** `uis/stock` is not the only client: a change to it — or to a shared contract
  it reads — lands in every other UI under `uis/`, and each altered UI bumps its `ui.json` (see
  [`.agentDocs/ARCHITECTURE.md`](.agentDocs/ARCHITECTURE.md)).

## Where to extend

- **Route**: `src/api/<x>.ts` (chained factory) → mount in `src/app.ts` → schemas in
  `src/shared/contracts.ts` → `describeRoute` + `jsonBody`. A workspace-scoped route takes
  `?workspace=<id>` (`workspaceQuerySchema` + `requireWorkspace` in `src/helpers/workspace.ts`); an
  omitted id means the default workspace, never another one.
- **Server field**: `serverSchema` + its patch in contracts, merge keys in `config/patch.ts` when
  nested, the form in `uis/stock/src/components/settings/`, and the contract tests.
- **UI**: a new `uis/<name>/` with a `vite.config.ts` from the shared factory;
  `node scripts/build-uis.mjs <name> --zip`. The contract is `docs/UI_CREATION.md`.
- **Capability**: a stateless `src/providers/*` returning plain data; a DDNS provider is one file plus
  a registry line (`src/providers/ddns/index.ts`) — the settings form, credentials and validation
  follow from its metadata. See `docs/DDNS.md`.

## Publishing

`pnpm pack` runs `prepack` (a full build) and ships the `files` list in `package.json`: `bin/`,
`dist/`, `uis/stock/dist`, `README.md`, the five user-facing `docs/*.md`, `AGENTS.md` and `LICENSE`.
`.agentDocs/` is deliberately not published — it is for agents working in this repo, not for people
installing the package. The bin falls back to tsx so `pnpm link` works before a build;
`vue`/`vue-router` are devDependencies because the UIs are prebuilt.
