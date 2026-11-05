# Upgrading

Per-version migration notes, lifted into the GitHub release body by `scripts/release-notes.mjs`.
A section here is what a person reads when they upgrade — the CHANGELOG lists commits, not what to
do about them.

Keep each entry to what someone must *change*, not what was added. If a release has nothing a person
must act on, it needs no section here at all.

## 0.12.0

**A public hostname must be declared.** The panel now refuses (`421 HOST_NOT_ALLOWED`) a request
whose `Host` is a public name it does not know — the fix for a DNS-rebinding attack that let any web
page drive a loopback-only panel. IPs, `localhost`, single-label and local names (`.local`, `.lan`,
`.home.arpa`, …) and the panel's own reverse-proxy routes keep working. **If you reach the panel
through an external proxy or tunnel on a public name**, add it before upgrading:

```json
{ "control": { "allowedHosts": ["panel.example.com"] } }
```

in `.hh/settings.json` (or under Global settings → Listener, reached by IP).

**`trustProxy` now defaults to `"loopback"`.** A proxy on the same machine is trusted for the client
address, so login lockout counts real clients instead of one shared `127.0.0.1`. A request carrying
`X-Forwarded-For`/`Forwarded`/`X-Real-IP` never counts as "this machine" any more, whatever the
setting. Set `trustProxy: false` explicitly to keep the old behaviour.

**No more shared default password.** A new home gets a random first-run password, printed by `up`
and shown by `status` until you change it. `/api/auth/session` no longer returns it (`defaultPassword`
is always `null`). A home still on the old `hh` keeps working, and `status` reminds you to change it.

**Bearer-token requests skip the same-origin check**, so a desktop or other-origin client can call
the API. Cookie-authenticated writes are still same-origin only.

**`SseMessage` is a union by `type`** (for TypeScript users of the shared contracts): narrow on
`frame.type` before reading `serverId`, `server`, `lines` or `state`. The frames on the wire are
unchanged. New: `home-hosted/client`, a typed client in the package.

**Lifecycle refusals carry `message` and `code`** like every other error (`ok`/`error` remain).
`/api/events?workspace=<id>` now filters server and log frames to that workspace, and refuses
undeclared query keys.

## 0.11.1

**A workspace-scoped route now refuses a query key it does not declare.** This is the one thing to
check before upgrading.

Every such route already took `?workspace=<id>`. What changed is that a *different* key is now a
`400 INVALID_INPUT` naming it, instead of being silently dropped. The reason: ArkType is permissive
by default, so `POST /api/servers/<id>/stop?worspace=staging` answered `200 {"ok":true}` having
stopped that entry in the **default** workspace — one transposed letter in a deploy script, aimed at
one workspace, acting on another, with nothing in the answer naming the typo.

The rule now spans every workspace-scoped route, so anything that appends an extra query parameter
will fail where it used to work. The realistic cases:

| what you send | before | now |
| --- | --- | --- |
| `?workspace=staging` (declared) | 200 | 200 |
| `?worspace=staging` (typo) | 200, against **default** | 400 |
| `?workspace=a&_=1730…` (cache-buster) | 200 | 400 |
| `?workspace=a&v=2` (your own version tag) | 200 | 400 |
| `?workspace=a&withPersistant=true` (typo) | 200, flag ignored | 400 |

**What to change:** drop the extra parameter, or send it on a route that declares it. The keys each
route accepts are in `GET /openapi/spec.json` — a route that declares nothing rejects everything but
`workspace`. Nothing else about these routes changed: the id resolution, the `404
UNKNOWN_WORKSPACE` for a name that does not exist, and every response shape are as they were.

The shipped UIs need no change; both send only declared keys.

## 0.11.0

**Nothing to do if you run the shipped panel.** It serves the UI it ships with, and both move
together. This section is for something you built yourself against the API.

**`entries` and `files` are no longer in the state frame.** `GET /api/state`, the SSE `state` frames
and `GET`/`PATCH /api/settings` used to carry the backup capture tree and the archive list. Reading
them there meant every frame read the global *and every workspace's* `.secrets.json` and stat'd every
archive — on a path rebuilt about thirteen times a second.

They moved to `GET /api/backups`, which answers `{ dir, entries, files }`:

- The UI fetches it when the settings page mounts, not per frame. If you poll `/api/state` for the
  archive list, poll `/api/backups` instead — it is cheaper by design, not merely slower.
- The fields stay **optional** in the response schema, so an older client parsing a newer panel
  still accepts them. A client that *requires* them is the case that breaks: a UI built before this
  release, served by this panel, renders an empty capture tree.

`GET /api/backups` already existed and had no caller — both UIs declared `fetchBackups()` and never
used it. Its shape did not change.

## 0.10.0

Two changes are outside the config, so `home-hosted migrate` cannot fix them.

**A dashboard or alert on `/api/metrics` must rename two series.** Neither was ever a valid
Prometheus counter — each falls when you act on it, which breaks `rate()`/`increase()`:

| Was | Now |
| --- | --- |
| `hh_server_restarts_total` | `hh_server_restarts` |
| `hh_servers_total` | `hh_servers` |

Replace every query, and compare the gauge directly (`hh_server_restarts > 2`) rather than wrapping
it in `rate()`. The old names are no longer published, so a stale query shows *no data* instead of a
wrong number.

**A script holding only an API token must sign in for three operations.** Each would otherwise let a
stolen token end up holding the panel, so each now needs a session and answers `403 SESSION_REQUIRED`:

- clearing the panel password,
- switching authentication off,
- restoring an archive that carries `global:secrets`.

Either sign in first, pass `--exclude global:secrets` to a restore, or run the command on the machine
(`home-hosted set-password --clear`, `home-hosted backup restore`) — those use the local channel and
need no session.

Related, and worth acting on while you are here: changing the panel password does **not** revoke an
API token. If a token may have leaked, rotate it with `home-hosted set-token --generate`.
