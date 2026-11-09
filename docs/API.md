# The API

Everything the panel does goes through one HTTP API, so anything you build — a custom UI, a TUI, a
desktop app, a script, an AI agent — can do it too. The stock UI is just one client of it.

- **Spec:** `GET /openapi/spec.json` (OpenAPI 3, no session needed), browsable at `/openapi/ui`.
  It is generated from the same schemas the server validates with, so it cannot drift.
- **Live data:** server-sent events on `GET /api/events`.
- **Base URL:** wherever the panel listens — `http://127.0.0.1:3999` by default.

## Authenticating

| Client | Credential |
| --- | --- |
| A browser UI served by the panel | the `hh_session` cookie from `POST /api/auth/login` |
| Anything else | `Authorization: Bearer <token>` from `home-hosted set-token --generate` |

```bash
home-hosted set-token --generate          # printed once; only its hash is stored
curl -H "Authorization: Bearer hh_…" http://127.0.0.1:3999/api/state
```

Or, signed in from anywhere: **Global settings → Authentication → Generate token**, which is
`POST /api/auth/token` (a session is required — a token cannot mint its successor) and returns the
token once; `DELETE /api/auth/token` revokes it. A `401` with `code: "AUTH_REQUIRED"` means "show
your login screen". The token never expires.

While no password is in force (authentication off, or on with none set yet), `/api` answers only
this machine — a loopback request with no forwarding header — or the token. Anything else, including
a request relayed by a proxy on the same host, is `401 AUTH_DISABLED_REMOTE` (auth off) or
`401 AUTH_UNARMED` (auth on, no password): set a password first. `POST /api/auth/logout` needs no
credential, so a browser whose session already expired can still clear its cookie.

> [!WARNING]
> **A token is full admin.** It can create and start a server entry, and an entry runs any command
> as the user running the panel. Treat it like that user's password. A few operations are still
> refused to a token (`403 SESSION_REQUIRED`) — clearing the password, switching authentication off,
> minting or revoking an API token, setting the *first* password (only this machine may), installing
> a custom UI, and restoring an archive that carries the panel's own credentials — so a script
> cannot do those *by accident*, but they are not a security boundary against someone holding the
> token.

### Hosts and origins

- **`Host` must name this panel.** An IP address, `localhost`, a single-label name (`homeserver`)
  or a local suffix (`.local`, `.lan`, `.home.arpa`, `.internal`, …) is always accepted. A public
  name is accepted only when a reverse-proxy route serves the panel on it, or it is listed in
  `control.allowedHosts` (`"*.example.com"` matches subdomains). Anything else is `421
  HOST_NOT_ALLOWED`. This is what stops a malicious web page from reaching the panel through DNS
  rebinding.
- **A cookie-authenticated write must be same-origin.** A non-GET request carrying a different
  `Origin` is `403 CROSS_ORIGIN`. A request authenticated with a **bearer token** is exempt — a
  browser never attaches one by itself, so it cannot be a forged request. That is what lets a
  desktop app, whose requests carry their own `Origin`, use the API.
- **No CORS headers are sent.** A web page on another origin cannot read the API; a desktop shell
  (Tauri, Electron) should call it from its native/main process with a token.

## Workspaces

Workspace-scoped routes take `?workspace=<id>`. Omitting it means the panel's default workspace; an
unknown id is `404 UNKNOWN_WORKSPACE`, never a fallback. **Query keys a route does not declare are
refused** (`400 INVALID_INPUT`, naming the key) — a typo like `?worspace=staging` must not act on
the default workspace. That includes cache-busters.

A server id is unique only inside its workspace: key anything you store by `(workspaceId, serverId)`.

## Errors

Every failure is one JSON envelope with a stable `code` to branch on:

```json
{ "message": "unknown server \"web\"", "code": "UNKNOWN_SERVER", "detail": {} }
```

`detail` is present only when there is structure to report (validation issues, conflicting routes).
A refused lifecycle action (`start`, `stop`, `restart`) also carries `ok: false` and `error` (the same
text as `message`) for older clients. Status codes: `400` bad input, `401` no credential, `403`
forbidden for this credential or origin, `404` unknown id, `409` the entry cannot do that now (or
`CONFIG_CHANGED_ON_DISK`: the config file was edited since the panel read it — it reloads, so retry),
`413` too large, `421` unknown host, `502` the reverse-proxy engine or its download failed.

## Endpoints

✅ takes `?workspace=<id>`; everything else is panel-wide. The spec has every route, body and response.

| Endpoint | What it is | |
| --- | --- | --- |
| `GET /api/state` | the whole snapshot: settings, every workspace and server, host vitals | |
| `GET /api/events` | the live feed (below) | ✅ optional |
| `GET`/`POST /api/workspaces`, `PATCH`/`DELETE /api/workspaces/:id` | the workspace registry | |
| `GET`/`POST /api/servers` | one workspace's entries | ✅ |
| `GET`/`PUT`/`PATCH`/`DELETE /api/servers/:id` | one entry. `PUT` is create-or-replace (201, then 200): the idempotent form for config management. It writes config only — restart to apply | ✅ |
| `POST /api/servers/:id/{start,stop,restart,free-port,clear-logs}` | lifecycle; `free-port` asks whatever holds the port to stop (a supervised holder is refused) | ✅ |
| `POST /api/servers/{start-all,stop-all}` | the whole workspace (`?withPersistent=true` includes persistent entries) | ✅ |
| `GET /api/servers/:id/logs`, `GET /api/servers/:id/stream` | buffered lines; one server's SSE (replays its last 200 lines first) | ✅ |
| `GET /api/logs`, `/api/logs/:id?tail=&search=`, `/api/logs/:id/download` | log files on disk | ✅ |
| `GET`/`PATCH /api/settings` | panel-wide settings: listener, auth, TLS, host vitals, backups, UI | |
| `GET`/`PATCH /api/settings/workspace` | server defaults, log retention, notifications | ✅ |
| `GET`/`PUT /api/ddns`, `PUT`/`DELETE /api/ddns/credentials/:id`, `POST /api/ddns/check` | dynamic DNS | ✅ |
| `PUT`/`DELETE /api/notifications/destinations/:id/token`, `POST …/{test,detect-chats}`, `POST /api/notifications/test-webhook` | notification credentials and test sends | ✅ |
| `GET`/`PATCH /api/proxy`, `POST /api/proxy/{engine,start,stop,apply,revert}`, `PUT`/`DELETE /api/proxy/certificates/:id` | the reverse proxy | |
| `GET`/`POST /api/backups`, `POST /api/backups/restore`, `GET /api/backups/:name/download` | archives; `GET` is the selection model, fetch it when a dialog opens. `POST /api/backups` creates at once; a restore only plans unless `?confirm=true` | |
| `POST`/`DELETE /api/settings/ui`, `POST`/`DELETE /api/settings/tls` | install a UI zip / a PEM pair | |
| `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`, `POST`/`DELETE /api/auth/password` | the session and the password | |
| `POST`/`DELETE /api/auth/token` | generate (session only, shown once) or revoke the API token | |
| `GET`/`POST`/`DELETE /api/host/temperature` | the WSL2 temperature bridge: whether a helper is installed, install one, remove it (`supported: false` off WSL — hide the control) | |
| `GET /api/metrics` | Prometheus text | |
| `GET /healthz` | **no credential**: `200`/`503` and uptime; per-server counts with a credential; to a caller on this machine, `home` — a fingerprint of the state directory, so the CLI can tell this home's panel from another one sharing the port | |

An entry body is **partial**: send only the fields the person chose, and the workspace's server
defaults fill the rest. Sending a default explicitly freezes it against later default changes.

## Live events

`GET /api/events` is a standard SSE stream. Browsers use `EventSource` (cookie auth); anything else
reads it with a streaming `fetch` and the bearer header.

| `event:` | `data:` |
| --- | --- |
| `hello` | `{ ts, state }` — always first: the complete snapshot |
| `state` | `{ ts, state }` — something changed |
| `server` | `{ ts, workspaceId, serverId, server }` — one entry |
| `log` | `{ ts, workspaceId, serverId, lines }` — new output |
| `ping` | the time, every 15 s |

A stream is authorised when it opens **and** re-checked on every ping and whenever credentials
change (sign-out, a password set, changed or cleared, the token rotated, auth settings saved): once
the caller would no longer be let in, the panel ends the stream, and the reconnect meets the usual
`401`. The re-check does not count as activity, so an open stream does not keep an idle session
alive.

`state.settingsError` is `{ message, path }` while the panel-wide `settings.json` cannot be applied
(the running settings are kept), `null` when it is fine, and absent on an older panel. A workspace's
own config problem is `configError` on that workspace.

Query: `?workspace=<id>` narrows `server`/`log` frames to one workspace, `&serverId=<id>` to one
server of it — of the **default** workspace when `workspace` is omitted, since ids repeat across
workspaces (an unknown workspace is `404`) — and `?logs=0` drops log frames. A slow client never makes the panel buffer without bound: queued
`state` and `server` frames are replaced by newer ones, and log frames are dropped once too many are
waiting — so treat every snapshot as complete, and logs as best-effort (the log routes have the
full history).

## Metrics

`GET /api/metrics` is Prometheus text behind the same credential as every `/api` route — scrape it
with a bearer token. Every series is a gauge; none ends in `_total`. A series with no reading is
**absent**, never `0`, so do not let a dashboard fill gaps with zero. `hh_host_cpu_used_percent`
(0–100) is the CPU figure to alert on; `hh_host_load1_per_cpu` is runnable tasks per core.
`hh_server_restarts` is the current crash streak (reset by a manual start), so compare it directly
rather than through `rate()`. `hh_server_uptime_ratio_24h` is the share of the last 24 hours a server
was up **measured over the time the panel observed it**, so a server added ten minutes ago and up
throughout reads `1`, not `0.0069`.

## Compatibility

- Fields are only ever **added** to responses and frames, and a new field is optional — read
  defensively, ignore what you do not know. Event names do not change.
- Request bodies are strict: an undeclared key is a `400`, so a typo is never silently ignored.
- `GET /api/state` → `version` is the panel's release.

## The TypeScript client

`home-hosted/client` ships in the package: a ~3 KB runtime over `hono/client`, typed from the
panel's own route table — every path, parameter, body and response — plus the event stream.

```ts
import { createClient, HomeHostedError } from 'home-hosted/client'

const hh = createClient({ baseUrl: 'http://127.0.0.1:3999', token: process.env.HH_TOKEN })

const { servers } = await hh.json(hh.api.servers.$get({ query: { workspace: 'default' } }))
await hh.json(hh.api.servers[':id'].restart.$post({ param: { id: 'web' }, query: {} }))

for await (const frame of hh.events({ workspace: 'default', logs: false })) {
  if (frame.type === 'server')
    console.log(frame.serverId, frame.server.status) // narrowed by `type`
}
```

`hh.json(...)` returns the body or throws a `HomeHostedError` (`status`, `code`, `detail`). `hh.api`
is the raw Hono client rooted at `/api`, for when you want the `Response`; `hh.rpc` is the same client
at the root (`hh.rpc.healthz.$get()`). Pass `fetch` to use your own (tests, custom TLS).
Types such as `AppState`, `ServerView` and `SseMessage` are exported too. The client and the panel
should come from the same release: the types describe the routes of the version they shipped with.

## Generating a client in another language

```bash
pnpm dlx openapi-typescript http://127.0.0.1:3999/openapi/spec.json -o src/home-hosted.d.ts
```

Any OpenAPI generator works: the document declares `bearerAuth`, gives every error a body and every
2xx a schema. Inside this repository, the UIs use the typed Hono client instead
(`hc<AppType>`, see `uis/stock/src/lib/rpc.ts`).

## For an AI agent

Give it the token, `/openapi/spec.json`, `home-hosted status --json` (where everything lives) and
[SERVERS.md](./SERVERS.md) (how an entry is declared). That is enough to run a home server without
guessing.
