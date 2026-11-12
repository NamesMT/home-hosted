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

Query **values** are typed, and a value outside its declared shape is a `400 INVALID_INPUT` rather
than a silently different question:

- A flag accepts `0`, `1`, `true` or `false` — and nothing else. `?logs=0` and `?logs=false` both drop
  log frames; `stop-all?withPersistent=1` means true; `yes`, `on` and `TRUE` are refused. The value a
  route reads is a boolean, so `false` can never be mistaken for "present".
- A count is a whole decimal integer inside the route's range — `/api/logs/:id?tail=` is 50–5000,
  `/api/servers/:id/logs?limit=` is 1–100000. `tail=3` is **refused**, not raised to 50; `tail=abc`,
  `tail=1.5` and `limit=-1` are refused, not defaulted. Asking for no value at all still gets the
  route's default.

## Errors

Every failure is one JSON envelope with a stable `code` to branch on:

```json
{ "message": "unknown server \"web\"", "code": "UNKNOWN_SERVER", "detail": {} }
```

`detail` is present only when there is structure to report (validation issues, conflicting routes).
A refused lifecycle action (`start`, `stop`, `restart`) also carries `ok: false` and `error` (the same
text as `message`) for older clients, and its `code` names **which** refusal it was — so a client
branches on the code instead of matching English:

| `code` | what it means | what to do |
| --- | --- | --- |
| `UNKNOWN_SERVER` | no entry has that id (also the 404 for it) | fix the id |
| `SERVER_DISABLED` | the entry is switched off (`enabled: false`) | switch it on |
| `SERVER_BUSY` | a stop, or the same action, is already in flight | retry in a moment |
| `PORT_IN_USE` | the entry's port is held (by a stranger, a container, or a process this platform cannot attribute) | free the port, or change it |
| `DEPENDENCY_FAILED` | something in `dependsOn` could not be started | start that entry |
| `ACTION_FAILED` | a refusal none of the above describes | read `error` |

A dependency that is **up but unhealthy** does not refuse the dependent: the panel logs `starting
anyway` and starts it, because that dependency is running and may recover.

Status codes: `400` bad input, `401` no credential, `403`
forbidden for this credential or origin, `404` unknown id, `409` the entry cannot do that now (or
`CONFIG_CHANGED_ON_DISK`: the config file was edited since the panel read it — it reloads, so retry),
`413` too large, `421` unknown host, `502` the reverse-proxy engine or its download failed.
A body that is not valid JSON is `400 INVALID_INPUT`, like any other rejected input. A path under
`/api`, `/_hh` or `/openapi` that matches no route — or any non-`GET` request that matches none — is
`404 NOT_FOUND` in the same envelope, never the UI's `index.html`.

### Every code

`src/shared/error-codes.ts` is the one catalogue, and a test walks every literal `code:` in `src/` and
fails on one that is not in it — so this table and the code cannot drift, in either direction. Use it
to decide without a lookup: the left column is what a client branches on, the number is the status it
arrives with.

| `code` | status | meaning |
| --- | --- | --- |
| `INVALID_INPUT` | 400 | the body, query or path did not validate; `detail` lists the fields |
| `ID_MISMATCH` | 400 | a `PUT` body's `id` does not match the path id |
| `NOT_FOUND` | 404 | no route matches this method and path |
| `PAYLOAD_TOO_LARGE` | 413 | the sign-in body was larger than the panel accepts |
| `INTERNAL_ERROR` | 500 | a failure with no more specific code; the panel logged it |
| `DETAILED_ERROR` | 500 | a `DetailedError` thrown without a code — a bug in the panel |
| `AUTH_REQUIRED` | 401 | no valid session or token; show the login screen |
| `AUTH_UNARMED` | 401 | authentication is on but no password is set, and the caller is not this machine |
| `AUTH_DISABLED_REMOTE` | 401 | authentication is off and the caller is not this machine (a proxy counts) |
| `LOGIN_FAILED` | 401 | a sign-in failed: wrong password (401), no password set (409), or too many attempts (429) |
| `SESSION_REQUIRED` | 403 | this operation needs a signed-in session, not an API token |
| `CURRENT_PASSWORD_REQUIRED` | 400 | changing an existing password needs `currentPassword` |
| `CURRENT_PASSWORD_WRONG` | 401 | `currentPassword` was incorrect |
| `PASSWORD_TOO_SHORT` | 400 | a password below the 12-character bar while the panel is exposed |
| `EXPOSED_WITHOUT_PASSWORD` | 400 | this would expose the panel with authentication off or no password |
| `EXPOSURE_BLOCKED` | 400 | the listener change would expose the panel without auth and a long-enough password |
| `PROXY_EXPOSURE_BLOCKED` | 400 | a proxy route to the panel would expose it without auth and a long-enough password |
| `CROSS_ORIGIN` | 403 | a cookie-authenticated write from another origin |
| `HOST_NOT_ALLOWED` | 421 | the `Host` header names a host this panel does not answer to |
| `INVALID_TOKEN` | 403 | the local `/_hh` token does not match `run.json` |
| `NOT_LOOPBACK` | 403 | this local-only operation was called from another machine |
| `INVALID_SETTINGS` | 400 | the settings patch was rejected by the store |
| `CONFIG_CHANGED_ON_DISK` | 409 | the config file was edited since the panel read it; it reloads, so retry |
| `UNKNOWN_WORKSPACE` | 404 | `?workspace=` names no workspace this panel has |
| `SERVER_EXISTS` | 409 | a server with this id already exists in the workspace |
| `UNKNOWN_SERVER` | 404 | no server has that id in the workspace |
| `SERVER_DISABLED` | 409 | the entry is switched off (`enabled: false`) |
| `SERVER_BUSY` | 409 | a stop, or the same action, is already in flight |
| `PORT_IN_USE` | 409 | the entry's port is held and could not be freed |
| `DEPENDENCY_FAILED` | 409 | an entry in `dependsOn` could not be started |
| `ACTION_FAILED` | 409 | a lifecycle refusal none of the more specific codes describes |
| `UNKNOWN_ORPHAN` | 404 | no orphaned process is running under that id |
| `ORPHAN_SURVIVED` | 409 | an orphaned process ignored the stop |
| `UNKNOWN_LOG_FILE` | 404 | that file is not one of this entry's log rotations |
| `INVALID_PROXY` | 400 | the proxy configuration failed validation; `detail` lists the problems |
| `PROXY_DISABLED` | 400 | the reverse proxy is switched off |
| `PROXY_ROUTE_UNKNOWN` | 404 | no proxy route has that id |
| `PROXY_CERT_NOT_MANAGED` | 400 | that host is not one a CA issues for, so there is no certificate to retry |
| `PROXY_CERT_RETRY_LAST_ROUTE` | 409 | that is the only route on its name; the certificate could not be dropped for a retry |
| `PROXY_TLS_IN_USE` | 400 | that certificate is still used by a route |
| `PROXY_PORT_IN_USE` | 409 | a proxy port is held by something else; `detail.holders` names them |
| `PROXY_CONFIG_REJECTED` | 400 | the engine refused the generated configuration |
| `PROXY_NO_PREVIOUS` | 400 | there is no earlier engine configuration to revert to |
| `PROXY_NO_ADMIN_PORT` | 500 | no free loopback port was found for the engine admin endpoint |
| `INVALID_CERTIFICATE` | 400 | an uploaded PEM pair was rejected |
| `UNKNOWN_ENGINE` | 500 | the configured proxy engine name is not one this panel implements |
| `ENGINE_MISSING` | 400 | the proxy engine is not installed yet |
| `ENGINE_NOT_RUNNING` | 400 | the proxy engine is not running |
| `ENGINE_NOT_READY` | 502 | the engine started but never answered on its admin endpoint |
| `ENGINE_UNREACHABLE` | 502 | the engine admin endpoint did not answer |
| `ENGINE_ALREADY_RUNNING` | 409 | an engine is running whose admin endpoint the panel does not know |
| `ENGINE_BUSY` | 409 | the engine is running, so it cannot be replaced |
| `ENGINE_INTEGRITY` | 409 | the installed engine binary is not the one the panel downloaded |
| `ENGINE_MODULE_NOT_INSTALLED` | 400 | the engine module is not available in this install |
| `ENGINE_DOWNLOAD_FAILED` | 502 | the engine download or its verification failed |
| `ENGINE_DOWNLOAD_UNTRUSTED` | 502 | the engine download did not come from where it should |
| `INVALID_ENGINE_VERSION` | 400 | that is not a version of this engine |
| `UNSUPPORTED_PLATFORM` | 400 | the engine has no build for this platform/architecture |
| `BACKUP_FAILED` | 400 | the archive could not be written |
| `BACKUP_NOT_FOUND` | 404 | no archive has that name |
| `MISSING_ARCHIVE` | 400 | a restore needs a backup name or an uploaded file |
| `MISSING_FILE` | 400 | the multipart body carried no `file` field |
| `MISSING_NAME` | 400 | a restore needs `name` (or `from`) |
| `NAME_AND_FROM` | 400 | a restore takes `name` or `from`, not both |
| `FROM_NOT_ABSOLUTE` | 400 | `from` must be an absolute path |
| `RESTORE_FAILED` | 400 | the restore plan could not be applied; `detail` names the items |
| `RESTORE_IN_PROGRESS` | 409 | a restore is already running |
| `INVALID_UI` | 400 | the uploaded UI zip was rejected |
| `UPLOAD_TOO_LARGE` | 413 | the upload is larger than the limit |
| `CONFIG_COPY_CONFLICT` | 400 | a directory could not be copied over a non-directory (this used to leak the Node code `ERR_FS_CP_DIR_TO_NON_DIR`) |
| `TELEGRAM_TOKEN_REJECTED` | 400 | Telegram did not accept the bot token |
| `TELEGRAM_LIST_FAILED` | 400 | listing chats from Telegram failed |
| `WEBHOOK_SEND_FAILED` | 400 | the test webhook could not be delivered |
| `INVALID_DDNS` | 400 | the DDNS configuration failed validation; `detail` lists the problems |
| `INVALID_DDNS_CREDENTIALS` | 400 | the DDNS account credentials were rejected by their provider |
| `UNKNOWN_DDNS_PROVIDER` | 400 | no DDNS provider has that id |
| `NOT_WSL` | 400 | the temperature bridge is WSL2-only |
| `WINDOWS_DRIVE_MISSING` | 400 | the Windows drive is not mounted where the helper must be written |
| `SCRIPT_WRITE_FAILED` | 400 | the temperature helper could not be written |
| `LIBRARY_INSTALL_FAILED` | 400 | LibreHardwareMonitor could not be installed |

## Endpoints

✅ takes `?workspace=<id>`; everything else is panel-wide. The spec documents every `/api`, `/_hh`
and `/healthz` operation with its body and responses — the two documents that describe it
(`/openapi/spec.json` and `/openapi/ui`) are served but not listed in it.

| Endpoint | What it is | |
| --- | --- | --- |
| `GET /api/state` | the whole snapshot: settings, every workspace and server, host vitals | |
| `GET /api/events` | the live feed (below) | ✅ optional |
| `GET`/`POST /api/workspaces`, `PATCH`/`DELETE /api/workspaces/:id` | the workspace registry | |
| `GET`/`POST /api/servers` | one workspace's entries. A create answers an optional `warnings` list when the entry cannot start as written (`command` holding a whole command line) | ✅ |
| `GET`/`PUT`/`PATCH`/`DELETE /api/servers/:id` | one entry. `PUT` is create-or-replace (201, then 200): the idempotent form for config management. **A `PUT` body must repeat the path `id`** — a mismatch is `400 ID_MISMATCH`, never a rename. It writes config only — restart to apply, and the view's `restartRequired` says when that is needed; `warnings` appears here too | ✅ |
| `POST /api/servers/:id/{start,stop,restart,free-port,clear-logs}` | lifecycle; `free-port` asks whatever holds the port to stop (a supervised holder is refused). A refusal's `code` names it: `SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE`, `DEPENDENCY_FAILED`, else `ACTION_FAILED` | ✅ |
| `POST /api/servers/orphans/:id/stop` | stop a process the panel started that no entry claims any more (the orphan list is on the workspace view) | ✅ |
| `POST /api/servers/{start-all,stop-all}` | the whole workspace (`?withPersistent=true` includes persistent entries) | ✅ |
| `GET /api/servers/:id/logs?limit=` | the in-memory buffer (1–100000 lines; a value outside that is a `400`, not a clamp) | ✅ |
| `GET /api/servers/:id/stream` | one server's SSE: `server` frame, then its last 200 `log` lines, then live frames | ✅ |
| `GET /api/logs`, `/api/logs/:id?tail=&search=&stream=`, `DELETE /api/logs/:id`, `/api/logs/:id/download?file=` | log files on disk. `tail` is 50–5000 and **refused outside it** rather than clamped; `stream` filters `stdout`/`stderr`/`system`; `file` names one rotation (another name is `404 UNKNOWN_LOG_FILE`) | ✅ |
| `GET`/`PATCH /api/settings` | panel-wide settings: listener, auth, TLS, host vitals, backups, UI | |
| `GET`/`PATCH /api/settings/workspace` | server defaults, log retention, notifications | ✅ |
| `GET`/`PUT /api/ddns`, `PUT`/`DELETE /api/ddns/credentials/:id`, `POST /api/ddns/check` | dynamic DNS | ✅ |
| `PUT`/`DELETE /api/notifications/destinations/:id/token`, `POST …/{test,detect-chats}`, `POST /api/notifications/test-webhook` | notification credentials and test sends | ✅ |
| `GET`/`PATCH /api/proxy`, `POST /api/proxy/{engine,start,stop,apply,revert}`, `POST /api/proxy/routes/:id/retry-certificate`, `PUT`/`DELETE /api/proxy/certificates/:id` | the reverse proxy. `retry-certificate` drops and re-requests one name's certificate | |
| `GET`/`POST /api/backups`, `DELETE /api/backups/:name`, `POST /api/backups/restore`, `GET /api/backups/:name/download` | archives; `GET` is the selection model, fetch it when a dialog opens. `POST /api/backups` creates at once; a restore only plans unless `?confirm=true`. A missing archive is `404 BACKUP_NOT_FOUND` on every one of these | |
| `POST`/`DELETE /api/settings/ui`, `POST`/`DELETE /api/settings/tls` | install a UI zip / a PEM pair | |
| `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`, `POST`/`DELETE /api/auth/password` | the session and the password | |
| `POST`/`DELETE /api/auth/token` | generate (session only, shown once) or revoke the API token | |
| `GET`/`POST`/`DELETE /api/host/temperature` | the WSL2 temperature bridge: whether a helper is installed, install one, remove it (`supported: false` off WSL — hide the control) | |
| `GET /api/metrics` | Prometheus text | |
| `GET /healthz` | **no credential**: `200`/`503` and uptime; per-server counts with a session, the API token, or the local `run.json` token from this machine; to a caller on this machine, `home` — a fingerprint of the state directory, so the CLI can tell this home's panel from another one sharing the port | |

An entry body is **partial**: send only the fields the person chose, and the workspace's server
defaults fill the rest. Sending a default explicitly freezes it against later default changes.

**A create or `PUT` writes config; the running process keeps what it was started with.** The server
view's optional `restartRequired` is `true` when the running process predates a change to a field a
restart re-reads — `command`, `args`, `cwd`, `env`, `envFile`, `dataEnvs`, `port`, `bind`,
`persistent` and `stop`. A change to anything else (`label`, `enabled`, `health`, `restart`,
`resources`, `dependsOn`, log retention, backup paths, the port-conflict policy) takes effect live and
does **not** set it. A stopped entry never sets it.

## Live events

`GET /api/events` is a standard SSE stream. Browsers use `EventSource` (cookie auth); anything else
reads it with a streaming `fetch` and the bearer header.

**Every frame's `data` is one JSON object carrying a `type` field** (`"hello"`, `"state"`,
`"server"`, `"log"`, `"ping"`), and the `event:` line repeats it for `EventSource` users. Read the
`type` when you parse the payload: a client that switches on the parsed object does not depend on the
SSE machinery the transport happens to use.

| `event:` | `data:` |
| --- | --- |
| `hello` | `{ type: "hello", ts, state }` — always first: the complete snapshot |
| `state` | `{ type: "state", ts, state }` — something changed |
| `server` | `{ type: "server", ts, workspaceId, serverId, server }` — one entry |
| `log` | `{ type: "log", ts, workspaceId, serverId, lines }` — new output |
| `ping` | `{ type: "ping", ts }`, every 15 s |

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
workspaces — and `?logs=0` (or `logs=false`) drops log frames. **Naming a workspace or a server that does not exist is a
`404` before the stream opens** (`UNKNOWN_WORKSPACE` / `UNKNOWN_SERVER`), like every other route: a
stream that opened and published nothing reads as "nothing is happening". A slow client never makes
the panel buffer without bound: queued `state` and `server` frames are replaced by newer ones, and log
frames are dropped once too many are waiting — so treat every snapshot as complete, and logs as
best-effort (the log routes have the full history).

## Metrics

`GET /api/metrics` is Prometheus text behind the same credential as every `/api` route — scrape it
with a bearer token. Every series is a gauge; none ends in `_total`. A series with no reading is
**absent**, never `0`, so do not let a dashboard fill gaps with zero. `hh_host_cpu_used_percent`
(0–100) is the CPU figure to alert on; `hh_host_load1_per_cpu` is runnable tasks per core. Host
series also go absent when sampling is switched off, when the last sample is more than three
intervals old, and per reading when the platform cannot take it (Windows has no load average; a
failed macOS memory or swap read) — the state frame names those in `host.unmeasured`.
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

`home-hosted/client` ships in the package: a ~2 KB gzipped runtime over `hono/client`, typed from the
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
With a `token`, `createClient` refuses a `baseUrl` that is plain `http` to anything but this machine
(`localhost`, `127.x`, `::1`) — the token is full admin and would cross the network readable. Use
https, or pass `allowInsecureToken: true` for a network you trust end to end.
Types such as `AppState`, `ServerView` and `SseMessage` are exported too. The client and the panel
should come from the same release: the types describe the routes of the version they shipped with.

## Generating a client in another language

```bash
pnpm dlx openapi-typescript http://127.0.0.1:3999/openapi/spec.json -o src/home-hosted.d.ts
```

Any OpenAPI generator works: the document declares `bearerAuth`, gives every error a body and every
2xx a schema. Inside this repository the UIs call the published client instead — `@shared/api-client`,
which both UIs import and which validates each response against the same ArkType schema the route
validates its request with.

## For an AI agent

Give it the token, `/openapi/spec.json`, `home-hosted status --json` (where everything lives) and
[SERVERS.md](./SERVERS.md) (how an entry is declared). That is enough to run a home server without
guessing.
