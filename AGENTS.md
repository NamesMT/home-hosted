# AGENTS.md

`home-hosted` is a Node 24 / TypeScript harness for self-hosted servers: `up` starts a Hono/srvx panel
(default `127.0.0.1:3999`) that supervises the entries in each workspace's `servers.config.json` and
serves a UI. Package manager: pnpm. User docs: `README.md` and `docs/`.

State lives only in `$HHOSTED_HOME/.hh` (default `~/.home-hosted/.hh`). Global files sit at its top
level: `settings.json` (listener, auth, TLS policy, host vitals, backups, reverse proxy),
`workspaces.json`, `.control-secrets.json` (0600: password hash, API token hash), `.tls/`, `.backups/`,
`.ui/`, `.logs/` (the panel console), `.proxy/` (the engine, its generated config and nanny state), and
`run.json` (the live daemon's pid/url/token, 0600). Every workspace owns `.hh/<id>/`: `settings.json`
(server defaults, log retention, notifications, DDNS), `servers.config.json`, `.secrets.json` (0600:
Telegram bot tokens, one per destination, plus DDNS credentials sealed with AES-256-GCM under
`HHOSTED_DDNS_SECRET` — only DDNS is sealed, because it is the one thing replayed to a third party), `.logs/` (per server, `<id>.log`
plus `<id>.log.1` when it rotates), and `.state/` (nanny state, its 0600 spawn spec until read,
`ddns.json`). A home still on the 0.6.x layout is **refused** by `ensureLayout()`, which names the file
and tells the person to install the latest 0.7.x; 0.8.0 does not relocate it. **The package ships no
servers**: never commit a config, a seed entry, or a path that names one.

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
pnpm run up|down|restart|status    # detached; `down` asks /_hh/shutdown and signals only a pid whose
                                   # identity it confirmed; `restart <id>` restarts one server, panel up
pnpm run start                     # up --foreground (systemd, docker, a foreground shell)
pnpm exec tsx src/cli.ts logs      # the panel's own console output (--lines, --follow, --json)
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
pnpm run set-password              # non-interactive through HHOSTED_PASSWORD
pnpm run set-token                 # --generate prints a new API token once
pnpm run migrate                   # bring the config up to this release's schema
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
- **A numeric option is a whole decimal integer, never a prefix parse** (`src/cli/up.ts`): `--port 1e3`
  and `--port 8000x` are refused, not read as 1 and 8000. A flag the command cannot honour is refused
  too — `restart --workspace <id>` with no server id exits 1 before anything is attempted, because the
  panel's own restart is not per-server and `down` then `up` would restart every server
  (`test/cli/server-action.test.ts`).
- **A bounded read stays bounded.** `logs --lines 1e3` falls back to the default and `0x10` is not the
  "whole log" sentinel (`src/cli/logs.ts`); `--lines N` reads a tail, never the whole file
  (`test/cli/logs.test.ts`).
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
- **A workspace is the ownership boundary.** Servers, secrets, logs and nanny state belong to exactly
  one; only listener, auth, TLS, host vitals, backups, UI and `run.json` are panel-wide. Reach a
  per-workspace service through `PanelService.requireWorkspace(id)`, never a module global.
- **A restore writes only where a config says** — archive allowlist, `origin` matching first, symlinks
  never recreated.
- **A port is only ever freed by re-listing its listeners.** `free-port` never trusts a pid quoted in a
  message, and refuses any listener in `supervisedPids()` instead of killing it.
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
- **Cross-platform is a hard requirement.** Linux/macOS/Windows: `/proc` vs `ps` vs Win32_Process,
  process groups vs `taskkill /T`, graceful fallbacks, no shell utilities assumed.
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

- Code: a comment only for non-obvious *intent*, never to restate the line, and never long. A block
  arguing for its own change is a commit message.
- Docs: one idea per sentence. Cut anything that would not change what a reader does.
- Delete history `git log` already holds — keep the *rule* that came out of it, not the story.
- **Never drop a caveat to save a line.** Concise means no filler, not fewer facts.

## User-facing docs

`README.md` and the topical `docs/*.md` are for a person, not an agent:

- **Concise first read**, depth behind collapsible `<details>` spoilers, and **visuals for skimmers** —
  the media in `docs/media/` is regenerated by `pnpm run media`.
- **Docs ship with the change.** A
  user-visible change updates the docs that describe it in the *same commit*. A stale doc is a bug like
  stale code.

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
