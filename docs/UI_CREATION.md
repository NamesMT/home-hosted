# Building a UI for home-hosted

The panel's UI is **a static site, and it is replaceable**. The stock one ships in the package;
yours is a folder of files the control plane serves instead — same API, same authentication, no
server changes and no fork.

## Ask an AI to build it

The whole contract is this file, so a coding agent can do the work. Point it at this repo and be
specific about what you want:

> Help me build a UI for `home-hosted`: a nostalgic game theme. Servers as a party menu, health as
> HP bars, logs in a text-box pane, keyboard navigation, and a save-state corner for backups.
> Follow `docs/UI_CREATION.md`.

Then zip the build and install it (below). Useful constraints to include in the prompt: the API is
same-origin (relative `/api/...`), `401 { code: 'AUTH_REQUIRED' }` means "show the login screen",
live data should come from SSE, and assets must be self-hosted. Existing directions to borrow from
live in [`mockups/`](./mockups) — or ask for something else entirely; the server does not
care what your UI looks like.

## Install it

```text
$HHOSTED_HOME/.hh/.ui/        ← where your build lives
  index.html                  ← required, at the root
  assets/…
  ui.json                     ← optional, but see below
```

**Global settings → Interface** → pick a `.zip` → *Install UI* (refresh to see it). Or drop the files
into `$HHOSTED_HOME/.hh/.ui` yourself. The zip may hold the files at its root or inside one wrapper
directory (`zip -r ui.zip dist` works too).

Without the settings page, `home-hosted ui-switch` installs one from a GitHub release asset (its
default), from a local `.zip` (`--file ./ui.zip`), or from a URL (`--file https://…/ui.zip`).

### `ui.json`

Optional, and everything in it is optional — but it is what lets the panel tell you what is
installed, and what lets it offer you the next version:

```json
{
  "name": "my-panel",
  "version": "2.1.0",
  "repo": "you/my-panel",
  "tag": "v2.1.0",
  "asset": "my-panel.zip",
  "unix": 1790366625
}
```

| field | |
| --- | --- |
| `name`, `version` | what Global settings → Interface shows as installed |
| `repo` | `owner/name` the releases come from — the one field `ui-update` needs |
| `tag` | the release this build came from, so an update can tell newer from older |
| `asset` | the release asset name, when a release carries more than one UI |
| `unix` | when the build was made, in epoch seconds |

With those set, `home-hosted ui-update` lists the releases carrying your `asset` and installs the one
you pick; `--old` lists older ones. A version bump in your own repo is enough — nothing about the
panel is involved.

> **Official UIs** (`repo: NamesMT/home-hosted`) are paired with the panel instead: the panel knows
> its own release, so `home-hosted ui-update` installs the matching tag without asking, and
> upgrading the panel re-pairs the UI on the next `up`.

Nothing is built on the server side: whatever you upload is served as-is, so ship plain
HTML/JS/CSS or the output of your own Vite/Next/Astro build with relative asset paths.

**If it breaks:** `home-hosted ui-revert` puts the stock panel back (or *Revert to stock* in
Global settings). The CLI also prints a reminder at startup while a custom UI is active — a broken UI
must never lock you out of your own machine.

## Rules of the road

1. **Static only.** No server code, no filesystem, no environment variables. Everything comes from
   the API.
2. **Same origin, relative paths.** Call `/api/...`, never an absolute host: the panel may be
   reached over loopback, a LAN address, TLS or a proxy.
3. **`index.html` at the root** (or in a single wrapper directory). Unknown paths fall back to it,
   so client-side routing and deep links just work.
4. **Keep the login flow.** Without a session the API answers `401` with `{"code":"AUTH_REQUIRED"}` —
   show your login screen and `POST /api/auth/login`.
5. **Self-host your assets.** An offline home server should not need a CDN, and neither should its
   panel.
6. **Limits:** ≤ 20 000 entries, ≤ 512 MB uncompressed, no absolute paths, no `..`, no symlinks, no
   drive letters.
7. **Offline and plain-http friendly.** Assume a LAN over `http://`: no `Secure`-only cookies, no
   hard-coded port, no https-only APIs.
8. **Give each page its own path.** An SPA with canonical URLs is the best default: a path is what
   makes a page bookmarkable, shareable, and reachable with back/forward — and matching the stock
   paths keeps two UIs of the same panel feeling alike. Those are:

   | page | path |
   | --- | --- |
   | workspace: overview · servers · logs · settings | `/w/<workspace>` · `/w/<workspace>/servers` · `/w/<workspace>/logs` · `/w/<workspace>/settings` |
   | one server | `/w/<workspace>/servers/<id>` |
   | panel-wide: overview · settings | `/global/overview` · `/global/settings` |
   | reverse proxy | `/proxy` |

   Keep the workspace id in the URL (a link then opens the same workspace in a browser that never
   selected it), and rewrite bare or unknown paths onto the canonical one (`/` → Global Overview) so an
   old bookmark still lands somewhere sensible. **Not a hard rule** — a different direction may route
   however it fits; just keep deep links working.

## The API

Both routes below are generated from the same ArkType schemas the server validates with, so they
cannot drift:

| approach | how |
| --- | --- |
| **OpenAPI** | `GET /openapi/spec.json` (no session needed); browse it at `/openapi/ui` |
| **Typed RPC** | inside this repo: `import type { AppType } from '@server/app'` + `hc<AppType>()`, as `uis/stock/src/lib/rpc.ts` does |
| **Generated types** | `pnpm dlx openapi-typescript http://127.0.0.1:3999/openapi/spec.json -o src/api.d.ts` |

`uis/stock/src/lib/api.ts` is the reference client: plain `fetch`, with ArkType validating the
responses at runtime. Either style is fine.

### Endpoints you will actually use

Workspace-scoped routes take `?workspace=<id>`. Omitting it means the panel's default workspace;
naming one that does not exist is a `404 UNKNOWN_WORKSPACE`, never a silent fallback.

| endpoint | what it gives you |
| --- | --- |
| `GET /api/state` | everything: global settings, every workspace with its servers and live status, host vitals |
| `GET` / `POST /api/workspaces`, `PATCH` / `DELETE /api/workspaces/:id` | the registry: list, create, rename, remove (removal stops and disposes that workspace's servers) |
| `GET /api/events` | **the live feed**: `hello` carries the full state, then `state`, `server`, `log` |
| `GET /api/servers/:id/stream` | one server's `server` + `log` frames |
| `POST /api/servers/:id/{start,stop,restart}`, `/api/servers/{start-all,stop-all}` | lifecycle (workspace-scoped) |
| `POST /api/servers/:id/free-port` | ask whatever holds that server's port to stop (`409` when nothing can be freed — a supervised listener is refused, never killed) |
| `GET` / `POST /api/servers`, `PATCH` / `DELETE /api/servers/:id` | the entries themselves, in one workspace |
| `GET /api/logs`, `/api/logs/:id?tail=&search=`, `/api/logs/:id/download?file=` | persisted logs, for one workspace |
| `GET` / `PATCH /api/settings` | the panel-wide settings (`control.label`, host thresholds, backups, UI) |
| `GET` / `PATCH /api/settings/workspace` | one workspace's settings: server defaults, log retention, notifications |
| `POST` / `DELETE /api/settings/ui` | install or revert a UI — what Global settings calls |
| `POST` / `DELETE /api/settings/tls` | upload or clear a PEM pair |
| `GET` / `PATCH /api/proxy`, `POST /api/proxy/{engine,start,stop,apply,revert}`, `PUT` / `DELETE /api/proxy/certificates/:id`, `POST /api/proxy/routes/:id/retry-certificate` | the panel-wide reverse proxy: engine, route table, its uploaded PEM pairs. Its live view also rides in the state frame as an optional `proxy` — read it defensively |
| `GET` / `POST /api/backups`, `/api/backups/restore`, `/api/backups/:name/download` | archives; entries are global (`global:settings`, `global:secrets`, `global:tls`) or per workspace, whose leaves are `workspace:<id>:settings`, `:servers`, `:secrets` plus `data:<path>`; a create/restore body `include` selects them |
| `POST` / `DELETE /api/notifications/token`, `/api/notifications/test`, `/detect-chats` | Telegram, per workspace |
| `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout` | the session |
| `GET /healthz` | liveness — **no session**, and `503` when an autostart server has crashed |
| `GET /api/metrics` | Prometheus text (needs a session) |

`GET /healthz` and `GET /openapi/*` are the only unauthenticated reads; the SPA shell itself is
public, so your app can load before a session exists.

A `ServerView` carries `workspaceId` — the same server id can exist in two workspaces, so key a list
by the pair, not by `serverId` alone. A `server` frame embeds that view; a `log` frame carries only
`serverId`, so match it against the workspace's servers.

Anything calling the API from outside a browser — a script, a test, an agent, a native shell — can
skip the login dance with an API token: `home-hosted set-token --generate` prints one once, and
`Authorization: Bearer <token>` authenticates every `/api` request with the same authority as a
signed-in session. The browser app you ship should still use the cookie.

Two settings worth reflecting: `control.label` is the panel's own name (the stock shell shows it),
and `GET /api/settings` includes `ui` — which UI is being served, and its metadata.

An entry body is partial by design: `POST /api/servers` and `PATCH /api/servers/:id` take only the
fields the person decided, and the workspace's **Server defaults** fill the rest. Sending a value the
person never chose freezes it against those defaults, so build the body as a diff: `diffFields` comes
from `src/shared/patch-diff.ts`, while comparing against the defaults (`inheritBaseline`) is each
UI's own job — see `uis/stock/src/components/server/addServerForm.ts`.

### Failures

Every failing request answers with one envelope:

```json
{ "message": "unknown server \"web\"", "code": "UNKNOWN_SERVER", "detail": { "…": "…" } }
```

`code` is stable and machine-readable (`AUTH_REQUIRED` drives the login redirect); `detail` carries
validation issues when there are any. Status codes are the usual ones: 400 bad input, 401 no
session, 403 bad token or origin, 404 unknown id, 409 conflict, 413 too large.

### SSE frames

| `event:` | `data:` |
| --- | --- |
| `hello` | `{ ts, state }` — the first frame, the complete snapshot |
| `state` | `{ ts, state }` — anything changed: a status, a resource sample, host vitals, a workspace |
| `server` | `{ ts, serverId, server }` — one entry, `server.workspaceId` says which workspace |
| `log` | `{ ts, serverId, lines }` — new output (dropped under backpressure, never state) |
| `ping` | the current time, every 15 s |

`GET /api/events` takes `?logs=0` to skip log frames and `?serverId=<id>` to follow one server — but
it matches on the id alone, so an id used in two workspaces mixes their frames. Use
`GET /api/servers/:id/stream?workspace=<id>` for one server: it validates the pair and replays the
current state first. The exact shapes are `sseMessageSchema` in `src/shared/contracts.ts` — the
server validates against it before writing, so that schema is also your best type source.

## Editing settings without fighting the stream

Two things the API will not tell you, and both are what people report as bugs:

- **A live frame must never overwrite a half-typed edit.** Every frame carries freshly built
  objects, so a watcher that copies state into a form on each change reverts whatever is being
  typed. The settings are also not one payload: host thresholds and the backups policy come from
  `GET /api/settings`, which lands *after* the first SSE frame — a single "has anything changed?"
  guard reads that late arrival as a pending edit, leaves those fields showing schema defaults
  forever, and offers to "revert" a change nobody made. Fill each block on its own, and only while
  that block is untouched since it was last filled (`uis/stock/src/components/settings/settingsForm.ts`).
- **A boolean setting is a switch, not a checkbox.** Keep checkboxes for picking items out of a set
  (a restore plan), where the control is the list entry. `uis/stock/src/components/ui/ToggleSwitch.vue`
  is the reference.
- **Decide to open the stream from the session, not from the auth flags.** With authentication off,
  `authRequired` and `authenticated` are both `false` from the first paint to the last, so a watcher
  on those two never re-runs when the session lands: no event stream is opened, the connection badge
  sits on "Connecting", and the dashboard shows one stale snapshot forever. Turn the two flags into a
  single decision (`wait` | `connect` | `login`) and watch that — see
  `uis/stock/src/composables/useSession.ts`.

A pending-edit summary pays for itself: show how many fields changed, and let the list be opened —
`describeChanges` and `countLeaves` in `src/shared/patch-diff.ts` turn a patch into those rows.

## Building one in this repo

The repo's own UIs are Vite apps: `uis/<name>/` holds `index.html`, `src/`, a `tsconfig.json`
(copied from a sibling) and a two-line `vite.config.ts` calling `createUiConfig` from
`uis/vite.shared.ts`, with `public/ui.json` naming it. Yours does not have to be Vite — only the
output matters.

```sh
node scripts/build-uis.mjs <name> --zip   # builds it, writes uis/dist/home-hosted-ui-<name>.zip
pnpm run build:uis                        # every UI, zipped; releases attach them as assets
```

Only `stock` ships inside the npm package; the rest are release assets you install from Global
settings.
`pnpm run quickcheck` type-checks every UI, and `pnpm test` picks up any `test/*.test.ts` you add.
`@/…` resolves from the UI that asks — each UI's own `src`, so a test can import its own components
and logic directly; use `@shared/…` for what the panel and the UIs genuinely share
(`src/shared/`), and never import runtime server code (`@server` is types only).

## A worked example

```bash
# 1. any static framework; the only requirement is a static output
npm create vite@latest my-panel -- --template vue-ts
cd my-panel && pnpm install
pnpm run build                      # → dist/

# 2. keep the API base relative, then zip the build
cd dist && zip -r ../my-panel.zip . && cd ..

# 3. Global settings → Interface → Install UI, then refresh
```

Your client needs the session cookie, which the browser sends automatically once you log in on that
origin (a non-browser client uses an API token instead, above). For local development `pnpm dev` runs
the panel on `6000` and a Vite dev server on `6001` with `/api` proxied — point your own dev server at
`http://127.0.0.1:6000` the same way. Both stay in the 6xxx range so a dev instance never collides
with an installed panel on the default 3999; override with `--port`/`--ui-port` or
`HHOSTED_DEV_PANEL_PORT`/`HHOSTED_DEV_UI_PORT`.

## Checklist

- [ ] `index.html` at the root of the zip, assets referenced relatively
- [ ] only `/api/...` calls, no absolute origins, no hard-coded port
- [ ] `401 { code: 'AUTH_REQUIRED' }` handled with a login screen
- [ ] live data from SSE — a panel that only polls feels broken
- [ ] deep links render (the server falls back to `index.html`) and each page has its own path
- [ ] assets self-hosted, no CDN
- [ ] works over plain http on a LAN
- [ ] `ui.json` with a name and version, so Global settings can tell you what is installed — plus `repo`/`tag`/`asset` if you want `ui-update` to follow your releases
