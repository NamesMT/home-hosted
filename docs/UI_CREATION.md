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
$HHOSTED_HOME/.ui/            ← where your build lives
  index.html                  ← required, at the root
  assets/…
  ui.json                     ← optional: { "name": "my-panel", "version": "2.1.0" }
```

**Settings → Interface** → pick a `.zip` → *Install UI* (refresh to see it). Or drop the files into
`$HHOSTED_HOME/.ui` yourself. The zip may hold the files at its root or inside one wrapper directory
(`zip -r ui.zip dist` works too). `ui.json` is optional; it is what the settings page shows as
installed.

Without the settings page, `home-hosted ui-switch` installs one from a GitHub release asset (its
default), from a local `.zip` (`--file ./ui.zip`), or from a URL (`--file https://…/ui.zip`).

Nothing is built on the server side: whatever you upload is served as-is, so ship plain
HTML/JS/CSS or the output of your own Vite/Next/Astro build with relative asset paths.

**If it breaks:** `home-hosted ui-revert` puts the stock panel back (or *Revert to stock* in
Settings). The CLI also prints a reminder at startup while a custom UI is active — a broken UI must
never lock you out of your own machine.

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

| endpoint | what it gives you |
| --- | --- |
| `GET /api/state` | everything: panel settings, servers with live status, host vitals |
| `GET /api/events` | **the live feed**: `hello` carries the full state, then `state`, `server`, `log` |
| `GET /api/servers/:id/stream` | one server's `server` + `log` frames |
| `POST /api/servers/:id/{start,stop,restart}`, `/api/servers/{start-all,stop-all}` | lifecycle |
| `POST /api/servers/:id/free-port` | ask whatever holds that server's port to stop (`403`-safe: supervised listeners are refused) |
| `GET` / `POST /api/servers`, `PATCH` / `DELETE /api/servers/:id` | the entries themselves |
| `GET /api/logs`, `/api/logs/:id?tail=&search=`, `/api/logs/:id/download?file=` | persisted logs |
| `GET` / `PATCH /api/settings` | the panel's own config (`control.label`, host thresholds, backups, …) |
| `POST` / `DELETE /api/settings/ui` | install or revert a UI — what the settings page calls |
| `POST` / `DELETE /api/settings/tls` | upload or clear a PEM pair |
| `GET` / `POST /api/backups`, `/api/backups/restore`, `/api/backups/:name/download` | archives |
| `POST` / `DELETE /api/notifications/token`, `/api/notifications/test`, `/detect-chats` | Telegram |
| `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout` | the session |
| `GET /healthz` | liveness — **no session**, and `503` when an autostart server has crashed |
| `GET /api/metrics` | Prometheus text (needs a session) |

`GET /healthz` and `GET /openapi/*` are the only unauthenticated reads; the SPA shell itself is
public, so your app can load before a session exists.

Anything calling the API from outside a browser — a script, a test, an agent, a native shell — can
skip the login dance with an API token: `home-hosted set-token --generate` prints one once, and
`Authorization: Bearer <token>` authenticates every `/api` request with the same authority as a
signed-in session. The browser app you ship should still use the cookie.

Two settings worth reflecting: `control.label` is the panel's own name (the stock shell shows it),
and `GET /api/settings` includes `ui` — which UI is being served, and its metadata.

An entry body is partial by design: `POST /api/servers` and `PATCH /api/servers/:id` take only the
fields the person decided, and the panel's **Server defaults** fill the rest. Sending a value the
person never chose freezes it against those defaults, so build the body as a diff
(`inheritBaseline` and `diffFields` in `src/shared/patch-diff.ts`).

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
| `state` | `{ ts, state }` — anything changed: a status, a resource sample, host vitals |
| `server` | `{ ts, serverId, server }` — one entry, after an action or a probe |
| `log` | `{ ts, serverId, lines }` — new output (dropped under backpressure, never state) |
| `ping` | the current time, every 15 s |

Send `?logs=0` to skip log frames, or `?serverId=<id>` to follow one server. The exact shapes are
`sseMessageSchema` in `src/shared/contracts.ts` — the server validates against it before writing, so
that schema is also your best type source.

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

Only `stock` ships inside the npm package; the rest are release assets you install from Settings.
`pnpm run quickcheck` type-checks every UI, and `pnpm test` picks up any `test/*.test.ts` you add
(use relative imports — the `@` alias points at `stock`).

## A worked example

```bash
# 1. any static framework; the only requirement is a static output
npm create vite@latest my-panel -- --template vue-ts
cd my-panel && pnpm install
pnpm run build                      # → dist/

# 2. keep the API base relative, then zip the build
cd dist && zip -r ../my-panel.zip . && cd ..

# 3. Settings → Interface → Install UI, then refresh
```

Your client needs the session cookie, which the browser sends automatically once you log in on that
origin (a non-browser client uses an API token instead, above). For local development `pnpm dev` runs
the panel on 3999 and a Vite dev server on 3998 with `/api` proxied — point your own dev server at
`http://127.0.0.1:3999` the same way.

## Checklist

- [ ] `index.html` at the root of the zip, assets referenced relatively
- [ ] only `/api/...` calls, no absolute origins, no hard-coded port
- [ ] `401 { code: 'AUTH_REQUIRED' }` handled with a login screen
- [ ] live data from SSE — a panel that only polls feels broken
- [ ] deep links render (the server falls back to `index.html`)
- [ ] assets self-hosted, no CDN
- [ ] works over plain http on a LAN
- [ ] `ui.json` with a name and version, so Settings can tell you what is installed
