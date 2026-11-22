# Upgrading

Per-version migration notes, lifted into the GitHub release body by `scripts/release-notes.mjs`.
A section here is what a person reads when they upgrade — the CHANGELOG lists commits, not what to
do about them.

Keep each entry to what someone must *change*, not what was added. If a release has nothing a person
must act on, it needs no section here at all.

The script reads only the section for the version being released, so a section is deleted once that
version ships: its text lives on in that GitHub release's body.

## 0.16.0

**Run `home-hosted migrate`.** A job is no longer a server entry: `kind` and `schedule` are gone from
`servers.config.json` and a scheduled job lives in `jobs.config.json` (see [JOBS.md](../docs/JOBS.md)).
A servers file that still declares a job is **refused** rather than read as a service, so the schedule
cannot silently stop firing. If you run nothing else in this list, run this.

**Replace `home-hosted set-password` with `home-hosted account secret <id>`**, and `set-token` with
`account create`. A password and an API token are one thing now — an account, with an `id` you type and
a `secret` only you hold. Your existing credentials migrate on first read: the old password becomes
account `default`, a 0.14 token keeps its name and scopes, and the pre-0.14 single token becomes
`default`. Send a token as `Authorization: Bearer <id>:<secret>`; a value with no colon is refused
rather than guessed. `POST /api/auth/login` takes `{ id, secret }`, not `{ password }`; the password and
token routes are `/api/auth/accounts`, `/api/auth/accounts/:id` and `/api/auth/accounts/me/secret`.
`DELETE /api/auth/password` still exists but now means "turn the guard off" and **keeps the accounts**.

**Set a secret of at least 12 characters if the panel is exposed.** A panel on a non-loopback address,
or reached through a proxy route, refuses to start while its secret is shorter — and
`account secret <id>` refuses to set one. On loopback a short secret is still accepted, which is what
makes the first run possible. A password hashed by an older release carries no length record, so set it
again once with `account secret <id>`.

**Uninstall the hand-written systemd unit and use `home-hosted service install`.** The README's unit is
gone. `systemctl --user disable --now home-hosted` first, then run the command: it writes the absolute
`node` and CLI path, this home and project, your `PATH`, and the two policies the old unit got wrong
(`Restart=always` brought the panel back after `down`; the default `KillMode` took persistent entries
with it).

**Set `upstreamSkipVerify: true` on a route whose https upstream has an untrusted certificate**, or it
stops working — https upstreams are verified now, and the route dialog offers the toggle. **An upstream
with a path (`https://host/sub`) is rejected**: point the route at the host and keep the prefix in the
route's own `path`.

**A DNS-01 "Automatic" account answers only for names in its zones.** The zones come from the account's
Dynamic DNS hostnames and from routes that name it; a hostname in no zone falls back to HTTP-01. Name
the account on the route to have it used, and add the zone to the account when it is missing.

**Delete `engine.json` if you put a hand-replaced Caddy binary in place** — it is refused while the file
records the digest of the downloaded one.

**`ui-switch --file http://…` needs `--insecure`.** A release download is checked against the digest
GitHub publishes and needs no flag; only a plain-http hand-supplied zip asks for the opt-in.

**`migrate` now asks once and then writes all files**, so answering "no" partway through no longer
leaves earlier files written. A non-interactive run still needs `--yes` or `HHOSTED_MIGRATE=allow`.

**A workspace id is now at most 40 characters and cannot be a Windows device name** (`con`, `prn`,
`aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`). Existing ids still load whatever their length; only
creating one is bounded.

**A query flag accepts only `0`, `1`, `true` or `false`, and a count must be inside its range.** `yes`,
`on` and `TRUE` are refused (`400 INVALID_INPUT`) instead of being read as one of them.
`/api/logs/:id?tail=` is 50–5000 and `/api/servers/:id/logs?limit=` 1–100000, and a value outside the
range is refused rather than clamped. `?logs=false` now really drops the log frames.

**Match on a lifecycle refusal's `code`, not its English.** "disabled", "still stopping", "the port is
taken" and "a dependency did not start" now answer `SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE` and
`DEPENDENCY_FAILED`; `ACTION_FAILED` remains for anything else. `ok:false` and `error` are unchanged.

**"No such backup" is `BACKUP_NOT_FOUND` on every route.** `GET`/`DELETE /api/backups/:name` used to
answer `UNKNOWN_BACKUP` for the same condition. The full list is one catalogue in
`src/shared/error-codes.ts`, published in `docs/API.md`.

**Regenerate any client generated from the OpenAPI document.** Inline response schemas are now `$ref`s
to `components.schemas`, the two stream routes declare `text/event-stream` with a discriminated
`oneOf`, the UI upload declares its `multipart/form-data` body, `sessionCookie` is a declared security
scheme, and every response enum also carries `x-extensible-enum`. The API behind it did not change, and
a client generated from the old document still works.

**The UI is served with different cache headers, and a missing file is a `404`.** Only a content-hashed
name under `/assets/` is `immutable, max-age=31536000`; everything else, `index.html` included, is
`no-cache`. A **hand-copied** UI must have `index.html` at the root of `.ui`.

**Drop the `@types/node` workaround from a browser project consuming `home-hosted/client`** — the
declarations no longer need Node's types. If you added `skipLibCheck: false` and a `types` entry to
silence 8 errors, they can go.

**Check a saved entry that changed a restart-read field**: a server view now carries an optional
`restartRequired`, true when the running process predates a change to `command`, `args`, `cwd`, `env`,
`envFile`, `dataEnvs`, `port`, `bind`, `persistent` or `stop`. It is absent when false, so an existing
reader is unaffected — but "saved" alone no longer tells the whole story.

**Read the optional `warnings` list on a create and on `GET /api/servers`** — a `command` holding a whole
command line is reported there instead of failing at spawn after every retry. The create still
succeeds, and the field is absent when there is nothing to say.

**`setup-temp --clear` leaves the shared helper in place** unless this home's `host.tempCommand` runs it.
The helper sits in a machine-wide directory another home may be using; delete it yourself if you know
none is.
