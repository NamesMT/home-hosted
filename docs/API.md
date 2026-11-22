# The API

Everything the panel does goes through one HTTP API, so anything you build — a custom UI, a TUI, a
desktop app, a script, an AI agent — can do it too. The stock UI is just one client of it.

- **Spec:** `GET /openapi/spec.json` (OpenAPI 3, no session needed), browsable at `/openapi/ui`.
  It is generated from the same schemas the server validates with, so it cannot drift.
- **Live data:** server-sent events on `GET /api/events`.
- **Base URL:** wherever the panel listens — `http://127.0.0.1:3999` by default.

## Authenticating

An **account** is one credential. Its `id` and `secret` sign in to the panel *and* authenticate the
API — there is no separate token model.

| Client | Credential |
| --- | --- |
| A browser UI served by the panel | the `hh_session` cookie from `POST /api/auth/login` with `{ id, secret }` |
| Anything else | `Authorization: Bearer <id>:<secret>` |

```bash
home-hosted account create monitor --scope read   # prints the secret once; only a hash is stored
curl -H "Authorization: Bearer monitor:hh_…" http://127.0.0.1:3999/api/state
```

The id travels **in** the credential, like a username beside a password: the panel cannot be asked
"which account is this secret for" without comparing every stored hash, which is slower and a timing
signal. A value with no `:` is refused rather than guessed.

Or, signed in from anywhere: **Global settings → Accounts → Create account**, which is
`POST /api/auth/accounts`. Every account route needs a **session** whose account holds `admin` — a
credential may not create, edit or revoke one, because it could escalate past its own scopes. A `401`
with `code: "AUTH_REQUIRED"` means "show your login screen". A session's lifetime is an idle
timeout; the secret does not expire until it is rotated.

While no account exists (authentication off, or on with none set yet), `/api` answers only this
machine — a loopback request with no forwarding header — or a credential. Anything else, including
a request relayed by a proxy on the same host, is `401 AUTH_DISABLED_REMOTE` (auth off) or
`401 AUTH_UNARMED` (auth on, no account): create one first. `POST /api/auth/logout` needs no
credential, so a browser whose session already expired can still clear its cookie.

> [!WARNING]
> **`admin` is everything the panel's user can do.** An entry runs any command as that user, so an
> admin credential is that user's account on this machine. Give a script only the scopes it needs
> (`read` for a monitor, `read,lifecycle` for a deploy hook), limit it to its workspaces, and revoke
> it when it may have leaked. Some operations are refused to a **bearer** credential entirely
> (`403 SESSION_REQUIRED`) — creating or revoking an account, switching authentication off, installing
> a custom UI, and restoring an archive that carries the panel's own credentials — so a stolen one
> cannot make itself permanent. That is not a boundary against someone holding it.

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
| `PAYLOAD_TOO_LARGE` | 413 | the request body was larger than the panel accepts (1 MB, or the route's own ceiling for an upload) |
| `LENGTH_REQUIRED` | 411 | the request body was chunked, so its size could not be checked before reading it — send a `Content-Length` |
| `INTERNAL_ERROR` | 500 | a failure with no more specific code; the panel logged it |
| `DETAILED_ERROR` | 500 | a `DetailedError` thrown without a code — a bug in the panel |
| `AUTH_REQUIRED` | 401 | no valid session or token; show the login screen |
| `AUTH_UNARMED` | 401 | authentication is on but no password is set, and the caller is not this machine |
| `AUTH_DISABLED_REMOTE` | 401 | authentication is off and the caller is not this machine (a proxy counts) |
| `LOGIN_FAILED` | 401 | a sign-in failed: wrong password (401), no password set (409), or too many attempts (429) |
| `SESSION_REQUIRED` | 403 | this operation needs a signed-in session, not an API token |
| `TOKEN_SCOPE` | 403 | the API token's scopes do not cover this route, or its workspace limit excludes it — `detail` names what it needed and what it holds |
| `UNKNOWN_JOB` | 404 | no job has that id in this workspace |
| `JOB_EXISTS` | 409 | a job with that id already exists |
| `JOB_RUNNING` | 409 | that job is already running |
| `INVALID_JOB` | 400 | the job would not be runnable |
| `INVALID_CONFIG` | 400 | the jobs file could not be read, and was left untouched |
| `NO_DEPLOY` | 400 | the server has no `deploy` steps to run |
| `DEPLOY_RUNNING` | 409 | a deploy is already running for that server |
| `DEPLOY_FAILED` | 409 | a deploy step failed — the previous process is still running |
| `ACCOUNT_EXISTS` | 409 | an account with that id already exists |
| `UNKNOWN_ACCOUNT` | 404 | no account has that id |
| `CANNOT_REVOKE_SELF` | 400 | that is the account making the request |
| `LAST_ACCOUNT` | 400 | the last account that can sign in; revoking it would lock the panel |
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
| `JOB_RUNNING` | 409 | a run of this job is already in flight |
| `JOB_FAILED` | 409 | the run happened and failed; its exit code is the outcome and its log says why |
| `ACTION_FAILED` | 409 | a lifecycle refusal none of the more specific codes describes |
| `UNKNOWN_ORPHAN` | 404 | no orphaned process is running under that id |
| `ORPHAN_SURVIVED` | 409 | an orphaned process ignored the stop |
| `UNKNOWN_LOG_FILE` | 404 | that file is not one of this entry's log rotations |
| `CURSOR_OUT_OF_RANGE` | 400 | a `?since=`/`?before=` cursor is older than the lines this route reads; download the log file for the full history |
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
| `GET /api/state` | the whole snapshot: settings, every workspace and server, host vitals. An account with a `workspaces` limit gets only its own workspaces' subtrees | |
| `GET /api/meta` | what this panel is, which credential answered and what that credential may not do (below) | |
| `GET /api/events` | the live feed (below). Its `hello`/`state` frames are narrowed for a limited account the same way `/api/state` is | ✅ optional |
| `GET`/`POST /api/workspaces`, `PATCH`/`DELETE /api/workspaces/:id` | the workspace registry. `GET` narrows to the workspaces a limited account names — each entry carries that workspace's servers | |
| `GET`/`POST /api/servers` | one workspace's entries. A create answers an optional `warnings` list when the entry cannot start as written (`command` holding a whole command line) | ✅ |
| `GET`/`PUT`/`PATCH`/`DELETE /api/servers/:id` | one entry. `PUT` is create-or-replace (201, then 200): the idempotent form for config management. **A `PUT` body must repeat the path `id`** — a mismatch is `400 ID_MISMATCH`, never a rename. It writes config only — restart to apply, and the view's `restartRequired` says when that is needed; `warnings` appears here too | ✅ |
| `POST /api/servers/:id/{start,stop,restart,free-port,clear-logs}` | lifecycle; `free-port` asks whatever holds the port to stop (a supervised holder is refused). A refusal's `code` names it: `SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE`, `DEPENDENCY_FAILED`, else `ACTION_FAILED` | ✅ |
| `POST /api/servers/:id/deploy` | run the entry's `deploy` steps, then restart. **Waits** for the outcome; `?wait=false` answers `202` instead. Refusals name themselves: `NO_DEPLOY`, `DEPLOY_RUNNING`, `DEPLOY_FAILED` | ✅ |
| `POST /api/servers/orphans/:id/stop` | stop a process the panel started that no entry claims any more (the orphan list is on the workspace view) | ✅ |
| `POST /api/servers/{start-all,stop-all}` | the whole workspace (`?withPersistent=true` includes persistent entries) | ✅ |
| `GET /api/servers/:id/logs?limit=` | the in-memory buffer (1–100000 lines; a value outside that is a `400`, not a clamp) | ✅ |
| `GET /api/servers/:id/stream` | one server's SSE: `server` frame, then its last 200 `log` lines, then live frames | ✅ |
| `GET /api/logs`, `/api/logs/:id?tail=&search=&stream=&since=&before=`, `DELETE /api/logs/:id`, `/api/logs/:id/download?file=` | log files on disk. `tail` is 50–5000 and **refused outside it** rather than clamped; `stream` filters `stdout`/`stderr`/`system`; `file` names one rotation (another name is `404 UNKNOWN_LOG_FILE`). `since`/`before` are **cursors** (a line's `ts`), exclusive on both ends: `since` pages forward and `before` backfills, so a client polling both ways never sees a line twice. A cursor older than the readable window is a `400 CURSOR_OUT_OF_RANGE`, never a short answer | ✅ |
| `GET`/`PATCH /api/settings` | panel-wide settings: listener, auth, TLS, host vitals, backups, UI | |
| `GET`/`PATCH /api/settings/workspace` | server defaults, log retention, notifications | ✅ |
| `GET`/`PUT /api/ddns`, `PUT`/`DELETE /api/ddns/credentials/:id`, `POST /api/ddns/check` | dynamic DNS | ✅ |
| `PUT`/`DELETE /api/notifications/destinations/:id/token`, `POST …/{test,detect-chats}`, `POST /api/notifications/test-webhook` | notification credentials and test sends | ✅ |
| `GET`/`PATCH /api/proxy`, `POST /api/proxy/{engine,start,stop,apply,revert}`, `POST /api/proxy/routes/:id/retry-certificate`, `PUT`/`DELETE /api/proxy/certificates/:id` | the reverse proxy. `retry-certificate` drops and re-requests one name's certificate. A limited account's `routes`/`config.routes` and `dnsAccounts` hold only its own workspaces, and a `PATCH` row naming another workspace is `403 TOKEN_SCOPE` — the rows it may not touch are carried over, because a route list is replaced whole | |
| `GET`/`POST /api/backups`, `DELETE /api/backups/:name`, `POST /api/backups/restore`, `GET /api/backups/:name/download` | archives; `GET` is the selection model, fetch it when a dialog opens. `POST /api/backups` creates at once; a restore only plans unless `?confirm=true`. A missing archive is `404 BACKUP_NOT_FOUND` on every one of these | |
| `POST`/`DELETE /api/settings/ui`, `POST`/`DELETE /api/settings/tls` | install a UI zip / a PEM pair | |
| `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`, `POST`/`DELETE /api/auth/password` | the session and the password | |
| `GET`/`POST /api/auth/accounts`, `PATCH`/`DELETE /api/auth/accounts/:id` | the panel's accounts. Session-only, and a new secret is shown once. Scopes are `read`, `lifecycle`, `config`, `proxy`, `admin` (cumulative; `proxy` and `admin` cannot be narrowed by `workspaces`); `workspaces` limits one. The list carries `scopes: [{ scope, workspaceLimited }]` so a UI can mark the panel-wide ones. `DELETE` refuses the account making the request (`CANNOT_REVOKE_SELF`) and the last one that can sign in (`LAST_ACCOUNT`). A route's requirement is published as `x-required-scope` |
| `GET`/`POST /api/jobs`, `PATCH`/`DELETE /api/jobs/:id` | a workspace's **jobs**: short-lived commands on cron schedules, in their own `jobs.config.json`. A job has no port, health check or restart policy — its exit code is the outcome. `workspaces` scope a job by its workspace rather than by an id |
| `POST /api/jobs/:id/run`, `POST /api/jobs/:id/stop` | run one now and wait for its exit code (a non-zero exit is `200` with `exitCode`, because the run happened), or end a run in flight. A run already going is `409 JOB_RUNNING` rather than a queue |
| `GET /api/jobs/:id/log` | a job's **own** log: what its runs wrote, one JSONL file per id under the workspace's `.logs/jobs/`. Takes a server log's `tail`/`search`/`stream`/`since`/`before` unchanged. `enabled: false` means the workspace keeps no logs, which is not the same as "it printed nothing" |
| `PUT /api/jobs/:id/secrets` | a job's secret environment values, write-only: a name the job does not declare in `secretEnv` is refused, because the declaration is the consent |
| `POST /api/auth/accounts/me/secret` | change **your own** secret, proving the current one (`CURRENT_PASSWORD_REQUIRED` / `CURRENT_PASSWORD_WRONG`). Keeps the session that made the change |
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

## The local channel: `/_hh`

The API above is what a UI and a remote script use. **`/_hh` is the other channel**: what the CLI talks
to when it finds a panel already running on this machine. It exists so `home-hosted` commands work
against a live panel without a session — `down`, `start`, `stop`, `backup` and `job run` all go through
it.

It is **not** a second public API, and it is guarded differently on purpose:

- **Loopback only.** The caller must be this machine by `isLoopbackRequest` — a loopback peer with no
  forwarding headers. The panel's own reverse proxy connects from `127.0.0.1`, which is why the header
  check is part of the rule rather than an extra.
- **The `run.json` token.** `$HHOSTED_HOME/.hh/run.json` (0600, written at boot) carries a token, sent
  as `x-home-hosted-token`. It is compared in constant time, and it is the **only** credential on this
  channel — which is why the check runs as middleware, before any body is parsed, so an unauthenticated
  caller cannot make the panel buffer a payload of their choosing.
- **No scopes.** Unlike an account, this token is not narrowed: it is what the person who owns
  `$HHOSTED_HOME` already is. Treat it as the panel's own key, not as a credential to hand to anything.

```bash
# `run.json` carries both halves: the token and the port the panel actually bound.
HH="$HOME/.home-hosted/.hh"
TOKEN=$(node -e "process.stdout.write(require('$HH/run.json').token)")
PORT=$(node -e "process.stdout.write(String(require('$HH/run.json').port))")
curl -sS -H "x-home-hosted-token: $TOKEN" "http://127.0.0.1:$PORT/_hh/usage"
```

Reading the port from `run.json` rather than assuming `3999` matters: the panel may have been started on
another one, and `run.json` is written at boot with the values it actually bound.

Refusals name themselves: `403 INVALID_TOKEN` (wrong or absent token) and `403 NOT_LOOPBACK` (the caller
came through something). Every operation is in `/openapi/spec.json` with its body, like `/api` — a client
generated from the spec can drive this channel too.

**Reach for `/api` unless you are the CLI.** A script with an account or a token has everything the
`/_hh` operations do, over a credential you can scope and revoke.

## What this panel is

`GET /api/meta` answers in **one** request what a client otherwise probes for piecemeal — start here
rather than hardcoding anything about a particular install.

```json
{
  "version": "0.13.0",
  "apiVersion": 1,
  "credential": { "kind": "token", "name": "monitor" },
  "actor": "agent",
  "refused": ["auth.disable", "password.clear", "password.first", "restore.credentials", "token.generate", "token.revoke", "ui.install"],
  "features": { "proxy": true, "ddns": false, "temperature": false },
  "errorCodes": ["INVALID_INPUT", "AUTH_REQUIRED", "…"],
  "events": ["hello", "state", "server", "log", "ping"]
}
```

- **`version`** is the release running, and **`apiVersion`** the response-shape version (`1` today).
  Check `apiVersion` once, then read defensively; a field only ever arrives as an optional addition.
- **`credential.kind`** says what answered: `session` (a browser's cookie), `token` (an API token), or
  `local` (authentication is off and the caller is this machine). For a token, `name` is the name it
  was minted with — what tells two credentials apart — falling back to the readable head of the
  secret only for a token migrated from before `0.14`, whose name was never recorded. Neither is
  enough to use one. `actor` is the same credential as a history event names it (`user`, `agent`).
- **`refused`** lists the actions this credential may **not** take, and is **empty** for a session
  and for `local`. An API token gets: `password.clear`, `password.first`, `auth.disable`,
  `token.generate`, `token.revoke`, `ui.install`, `restore.credentials` — each refused because it is a
  way for a stolen token to *replace the person who owns the panel* rather than merely drive it. **An
  API token is otherwise full admin** (it can run commands through entries); read this list as "the
  moves that would take the panel over", never as reduced authority.
- **`features`** reports whether each optional subsystem is switched on **right now** (`proxy` from
  the panel's settings, `ddns` if any workspace has it enabled, `temperature` if a temp command is
  configured). It is derived per request, so it follows a settings change immediately — do not cache it
  across a save.
- **`errorCodes`** is the panel's whole catalogue, from `src/shared/error-codes.ts`; **`events`** are
  the `event:` names its streams send. Both are safe to build a client's switch statements on.

`GET /api/auth/session` carries the same `credential` field, so a UI that already fetches the session
neither needs this route nor disagrees with it. Its `defaultPassword` is **absent**, never `null`: the
first-run password is shown on the machine that started the panel, never over the API.

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

### Resuming a stream

**Every frame carries an `id:`**, the panel-wide sequence number of what it reports. The stream also
sends `retry: 3000` **once, on its opening frame** — the reconnection delay, in ms — and never
repeats it.

A client that reconnects says where it got to, in whichever way suits it:

| How | Who sends it |
| --- | --- |
| `Last-Event-ID: <seq>` header | an `EventSource` re-sends the last `id:` it saw, by itself |
| `?since=<seq>` query | a `fetch`-based reader (the TypeScript client's `events({ since })`) |

If both are present `?since=` wins, and a `Last-Event-ID` that is not a whole number is ignored
rather than resumed from — it names nothing, so the stream starts fresh.

**A resumed stream answers with one current snapshot first, then the replay.** Concretely: `hello`
(current state), then the buffered `log` frames published after the sequence you named, oldest first.
The snapshot is *newer* than the replay, and its `id:` is your resume point rather than a new number —
so read as a cursor, everything you are sent after it is genuinely new to you. That ordering is the
contract:

- **Apply the snapshot as state; apply the replay to your log buffer only.** A `log` frame that
  arrives before the snapshot's sequence is an old line you missed, not fresher state.
- **`hello`, `state` and `server` frames are snapshots and are never replayed.** Replaying an older
  one would roll your state backwards, which is exactly what the snapshot-first ordering avoids.
- **Do not refetch `/api/state` on a successful resume** — `hello` already is that snapshot. Refetch
  only when the connection could not be resumed (no `id:` was ever received, or the stream was
  refused with a non-`200`).
- **A gap is possible and is log-only.** Only the last 200 `log` frames (and at most 256 KB of them)
  are kept, so a client away long enough resumes with the retained tail rather than the whole gap.
  The log routes keep the full history: `/api/logs/:id?since=` pages forward from a line's `ts`, and
  `/api/logs/:id/download` gives the rotation itself. State is never subject to a gap — `hello`
  is always current.

A per-server stream (`GET /api/servers/:id/stream`) resumes the same way, and seeds a **fresh** stream
with that entry's last 200 buffered lines; a resumed one replays from the sequence instead, so the
lines are not delivered twice.

`state.settingsError` is `{ message, path }` while the panel-wide `settings.json` cannot be applied
(the running settings are kept), `null` when it is fine, and absent on an older panel. A workspace's
own config problem is `configError` on that workspace.

Query: `?workspace=<id>` narrows `server`/`log` frames to one workspace, `&serverId=<id>` to one
server of it — of the **default** workspace when `workspace` is omitted, since ids repeat across
workspaces — and `?logs=0` (or `logs=false`) drops log frames. **Naming a workspace or a server that does not exist is a
`404` before the stream opens** (`UNKNOWN_WORKSPACE` / `UNKNOWN_SERVER`), like every other route: a
stream that opened and published nothing reads as "nothing is happening". A **workspace limit is
answered first**, so asking for a server in a workspace the credential may not watch is `403
TOKEN_SCOPE` whether or not that id exists — the pair is not an existence oracle over the other
workspace. A slow client never makes
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
- `GET /api/meta` → `apiVersion` is the **response-shape** version (`1` today). Bump it only for a
  change an older client cannot read; everything else is an optional field added beside the old one.

## The TypeScript client

`home-hosted/client` ships in the package: a **~3.5 kB** gzipped runtime over `hono/client`, typed from
the panel's own route table — every path, parameter, body and response — plus the event stream. (Measured:
8 671 bytes, 3 615 gzipped with `gzip -9`; the figure said "~2 KB" and was stale.)

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
