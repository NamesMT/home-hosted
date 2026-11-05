# AGENTS.md

`home-hosted` is a Node 24 / TypeScript control panel for self-hosted servers. `up` starts a Hono/srvx
server (default `127.0.0.1:3999`) that supervises each workspace's `servers.config.json`, serves a
replaceable static UI, and exposes everything over `/api` (OpenAPI at `/openapi/spec.json`). The
product promise is **a robust core others build on**: the API, its SSE frames and its spec are the
contract, and the two UIs in `uis/` are ordinary clients of it. pnpm; user docs in `README.md` and
`docs/`.

## Layout

| Path | Owns |
| --- | --- |
| `src/cli.ts`, `src/cli/*` | the CLI; one lazy-loaded module per command. `--home`/`--project` are applied before any `#src` path module loads |
| `src/index.ts` | `runControlPlane()`: all wiring, startup guards, `run.json`, signals. Wiring lives here only |
| `src/app.ts` | the Hono root, one chained expression (that is what keeps `AppType` typed). Middleware order: host guard → `/_hh` + `/_acme` (own auth) → `/api/*` auth guard → routes |
| `src/api/*` | one route factory per URL group |
| `src/services/*` | stateful orchestration: `panel` (one `WorkspaceRuntime` per workspace), `supervisor`, `proxy`, `backups`, `ddns`, `notifications`, `auth`, … |
| `src/providers/*` | stateless leaves returning plain data: processes, ports, docker, host vitals, DDNS providers, archive, … |
| `src/config/*` | settings/workspace stores, parsing, patches, migrations, secrets |
| `src/middleware/*` | `host` (DNS-rebinding guard), `auth` (session/token, CSRF), `loopback` (what counts as "this machine") |
| `src/shared/*` | the only code both the server and the UIs import: `contracts.ts` (every ArkType schema), the API client, formatters, form logic. **No Vue, no `node:`** |
| `uis/<name>/` | Vite + Vue UIs: `stock` ships in the package, `noc-console` is a release asset |

Depth on module rationale: [`.agentDocs/ARCHITECTURE.md`](.agentDocs/ARCHITECTURE.md). Traps already
paid for, with causes: [`.agentDocs/GOTCHAS.md`](.agentDocs/GOTCHAS.md) — read the section for the
area you touch. Compatibility and migrations: [`.agentDocs/COMPATIBILITY.md`](.agentDocs/COMPATIBILITY.md).
Releasing: [`.agentDocs/RELEASING.md`](.agentDocs/RELEASING.md), with upgrade notes in
[`.agentDocs/UPGRADING.md`](.agentDocs/UPGRADING.md).

## Where things are — by task

| You need to… | Start at | Also touch |
| --- | --- | --- |
| add/change an API route | `src/api/<group>.ts` (chained factory) → mounted in `src/app.ts` | request/response schemas in `src/shared/contracts.ts`; `describeRoute` + `jsonBody`; a test in `test/api/` (`test/api/fixture.ts` builds a full app) |
| add a server field | `serverSchema` + its patch schema in `src/shared/contracts.ts` | merge keys in `src/config/patch.ts` if nested; the forms in `uis/stock/src/components/server/` **and** `uis/noc-console/src/lib/serverForm.ts`; `docs/SERVERS.md`; `test/shared/contracts.test.ts` |
| add a panel/workspace setting | the schema + patch in `contracts.ts`, the store in `src/config/settings.ts` or `store.ts` | the view in `src/services/state.ts`; `uis/stock/src/components/settings/settingsForm.ts` (+ its section `.vue`) and `uis/noc-console/src/views/*SettingsView.vue` |
| change process lifecycle | `src/services/supervisor.ts` (the state machine); one concern per module in `src/services/supervisor/` (`port-preflight`, `persistent`, `health`, `records`, `spawn`, `compose`, `view`) | `src/providers/process.ts`, `port.ts`, `proc.ts`, `identity.ts`; persistent entries in `src/services/nanny.ts` + `src/providers/nanny.ts`; tests in `test/services/supervisor.test.ts` (real child processes) |
| add a DDNS provider | one file in `src/providers/ddns/` + a line in its `index.ts` | the settings form and validation follow from the provider's metadata; `docs/DDNS.md` |
| add a notification channel | `src/services/notifications.ts`, `src/providers/telegram.ts` / `webhook.ts` | `docs/NOTIFICATIONS.md` |
| touch backups/restore | `src/services/backups.ts`, `src/providers/archive.ts`, `src/helpers/copy-tree.ts` | `src/cli/backup.ts` (CLI), `docs/BACKUPS.md` |
| touch the reverse proxy | `src/services/proxy.ts` (engine, routes, sync), `src/services/proxy-config.ts` (Caddy JSON) | `src/shared/proxy-form.ts` (both UIs' form), `docs/REVERSE_PROXY.md` |
| add a CLI command | `src/cli/<command>.ts`, registered lazily in `src/cli.ts` (`subCommands`, help text) | output helpers in `src/cli/io.ts` (`fail`, `refusal`, `invocation`); `docs/CLI.md` + the README CLI table |
| change the published client | `src/client.ts` (runtime, imports the server for types only) | `vite.client.config.ts` (bundle), `scripts/build-types.mjs` (declarations, `#src` rewritten); `test/api/client.test.ts`; `docs/API.md` |
| add a UI string | a row in `uis/stock/i18n/sheets/<key-prefix>.csv` with **all 9 language columns** | `pnpm run build:locales`; noc-console is English-only and inline |
| add a whole UI | `uis/<name>/` with a `vite.config.ts` from `uis/vite.shared.ts` and `public/ui.json` | `node scripts/build-uis.mjs <name> --zip`; contract in `docs/UI_CREATION.md` |

A provider that is a **directory** needs its own `package.json#imports` entry (`#src/*` maps files,
and Node refuses a directory import).

## State

Everything lives in `$HHOSTED_HOME/.hh` (default `~/.home-hosted/.hh`, mode `0700`). Panel-wide:
`settings.json`, `workspaces.json`, `.control-secrets.json` (0600), `.tls/`, `.backups/`, `.ui/`,
`.logs/`, `.proxy/`, `run.json` (0600). Per workspace, `.hh/<id>/`: `settings.json`,
`servers.config.json`, `.secrets.json` (0600), `.logs/`, `.state/` (nanny state, `<id>.run.json`,
`ddns.cache.json`). The package ships no servers:
never commit a config, seed entry or path naming one.

## Commands

```sh
pnpm dev                       # panel :6000 + stock UI dev server :6001, state in .dev-state/, password `dev`
pnpm dev --ui noc-console      # another UI; --home/--port/--ui-port override
pnpm run cli <command>         # any CLI command against .dev-state/ — never ~/.home-hosted
pnpm run quickcheck            # eslint + tsc + vue-tsc + doc links (no tests)
pnpm exec vitest run <files>   # targeted tests
pnpm run check                 # THE GATE: quickcheck + the full suite with coverage floors. Run before pushing
pnpm run build                 # dist/cli.js + the stock UI
pnpm run build:uis             # every UI, zipped into uis/dist/
pnpm run build:locales         # i18n/sheets/*.csv -> the git-ignored generated catalogs
```

- Dev and test instances stay in the **6xxx** range; never assume 3999 is free — the user may have a
  real panel there. Tests bind fixed ports, so two full suites on one machine collide.
- `pnpm-workspace.yaml`'s `allowBuilds` is load-bearing: dropping an entry makes `pnpm install` exit 1.
- Running the Caddy engine writes the host's trust store (a root CA per engine data dir). Use the
  stubs in tests; if you run it against a scratch home, remove the root it installed.

## Rules

These are the ones that prevent real defects. Break one only with a reason in the commit message.

**API contract**
- ArkType at every runtime boundary. Routes use `validate(...)` + `c.req.valid(...)`. **Request schemas
  reject undeclared keys** (including query strings); **response schemas never do**, and a new response
  field is optional (`'x?'`) — an upgraded UI may talk to an older panel and vice versa.
- Every failure is a `DetailedError`, rendered as `{ message, code, detail? }` by `src/helpers/error.ts`.
  Lifecycle refusals additionally carry `ok:false, error` for old clients. Never hand-roll an error body.
- Document every route (`describeRoute` + `jsonBody(schema)`). Per-route security and guard responses
  are added centrally in `finishSpec` (`src/openapi.ts`).
- Patch schemas carry no defaults; nested groups merge key by key and `null` clears a key. Lists in a
  patch are replaced whole, so a form sends a list only when *it* changed it.
- `test/shared/contracts.test.ts` pins schema boundaries and patch/schema parity — update it with any
  schema change.

**Security**
- Never expose beyond loopback without auth and a non-default password: `checkExposure()` and
  `checkProxyExposure()` are the one rule, at startup, on every settings write, and in the UI.
- "This machine" means `isLoopbackRequest()`: a loopback peer **without** forwarding headers. Never
  test the peer address alone — the panel's own proxy connects from 127.0.0.1.
- A public `Host` must be declared (`control.allowedHosts`) or be a panel proxy route (`createHostGuard`).
- An API token is full admin (it can run commands through entries). Do not document it as less.
- Secrets never enter a config file; secret files are 0600 and written with `writeFileAtomic`.
- A credential is scoped to its origin: a token is sent only to the host it belongs to, over https.
- A restore writes only where a config declares; symlinks are never recreated or followed out of a
  declared path; permission bits travel, setuid does not.

**Processes**
- Only free a port from a **fresh** lookup, never a pid quoted in a message, and refuse anything the
  panel supervises. Decide liveness with `runtimeLiveness`/`processLiveness` (pid + start time), never
  `isProcessAlive` alone — pids are recycled.
- Only the `kill` conflict policy may touch a process the panel cannot identify.
- An entry's async lifecycle (start, stop, probe, readiness) must re-check that the run it began is
  still current after every `await`; a stop that lands mid-start must win.
- `health`/`healthFailures`/`unhealthySince` change together (`setHealth`/`resetHealth`); readings
  that belong to a process go when it does (`endProcessReadings`).
- No per-frame syscalls: the state frame is built every second. Cache host/process reads on their own
  clock, and never call `execFileSync` from a request or frame path.
- Cross-platform is required (Linux, macOS, Windows). Use the shared helpers: `readStateFile` for any
  hand-editable file (BOM/UTF-16), `resolveCommand` for `node_modules/.bin`, `shellQuote` for text a
  person pastes, `invocation()` for a command hint (it carries `--home`).

**Ownership**
- A server id is unique only inside its workspace: key everything (SSE, buffers, routes) by
  `(workspaceId, serverId)`. Reach a workspace's services through `panel.requireWorkspace(id)`.
- A core file never names a particular server. UIs are external clients: nothing in `src/` knows
  their markup, and UIs import `@shared/*` (and `@server` for types only).
- `src/shared` has one declaration per member (`test/shared/ui-parity.test.ts`).

**Readings**
- A metric or reading with no sample is **absent**, never `0`, on the scrape and in every UI. No
  series ends in `_total`. A verdict uses the threshold the person configured, carried in the frame.
  Depth: [`.agentDocs/READINGS.md`](.agentDocs/READINGS.md).

**CLI**
- One refusal, one message, on stderr; `--json` prints one document on stdout or nothing.
- A numeric flag is a whole decimal integer; a flag the command cannot honour is refused.
- `fail()` exits — never interpolate it.
- The CLI talks to a running panel through `/_hh` (run.json token + loopback), never `/api`.

**UIs**
- UIs move together: a change to `uis/stock`, or to a shared contract it calls at runtime, lands in
  every UI, and each changed UI bumps `public/ui.json` (`scripts/stamp-uis.mjs` enforces it in the
  pre-commit hook; a `src/shared`-only change needs the bump by hand).
- Strings live in `uis/<name>/i18n/sheets/*.csv` (stock: 9 languages). Add a row for every new string
  in every column; never type copy into a template.
- A single on/off setting is a `ToggleSwitch`; a destructive action confirms in a `ConfirmButton`
  popover that names its cost.
- Durations a person edits are seconds when the schema floor is ≥ 1 s (`readSeconds`/`secondsToMsOr`).

## Before you say it is done

1. `pnpm exec tsc --noEmit` and `pnpm exec eslint <files>` are clean (`pnpm exec eslint --fix` fixes style).
2. The tests for the area pass, and a new behaviour has a test you saw **fail without the change**.
3. A schema change updated `test/shared/contracts.test.ts`; a UI change updated **both** UIs and
   bumped each one's `public/ui.json` (minor for a feature, patch for a fix).
4. A new string has all 9 columns; `pnpm run build:locales` ran.
5. User-visible behaviour is described in `README.md` / `docs/` in the same change, and
   `node scripts/check-doc-links.mjs` passes. A change someone must act on gets a section in
   `.agentDocs/UPGRADING.md`.
6. `pnpm run check` before pushing — it is what CI runs.

## How to work here

- **Check callers before changing anything**, and say so when the impact is unclear.
- **Fix the class, not the instance**: one helper, one guard. Stay inside the task otherwise.
- **Verify before claiming.** Break what a test guards and watch it fail; drive the real thing when a
  stub cannot answer. Never write an identifier, hash, path or version from memory.
- **Report risk with the change**, plus what you could not verify.
- **Docs ship with the change**: a user-visible change updates `README.md`/`docs/` in the same commit.
  User docs are for a person: short first read, depth in `<details>` or a topic doc.
- **Conventional commits.** changelogen derives the changelog; below 1.0 a **minor** is the breaking
  channel (someone must act), a fix is a patch. Never hand-edit the version in `package.json`.
- **Concise.** A comment explains non-obvious intent in a line or two; the argument for a change goes
  in the commit message, not the code.
