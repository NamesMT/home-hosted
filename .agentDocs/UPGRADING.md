# Upgrading

Per-version migration notes, lifted into the GitHub release body by `scripts/release-notes.mjs`.
A section here is what a person reads when they upgrade — the CHANGELOG lists commits, not what to
do about them.

Keep each entry to what someone must *change*, not what was added. If a release has nothing a person
must act on, it needs no section here at all.

The script reads only the section for the version being released, so a section is deleted once that
version ships: its text lives on in that GitHub release's body.

## 0.16.0

**A job is no longer a server entry.** `kind` and `schedule` are gone from `servers.config.json`; a
scheduled job lives in `jobs.config.json`, with its own page, API and command — see
[JOBS.md](../docs/JOBS.md).

**Run `home-hosted migrate` and your jobs move.** Until you do, a servers file that still declares a
job is **refused**, with the instruction:

```text
nightly-backup: this entry is a `job`, which now lives in jobs.config.json — run `home-hosted migrate`
to move it, then remove `kind`/`schedule` here
```

That is deliberate. The dangerous outcome is not an error — it is that `kind: "job"` would be read as
a service and its schedule would silently stop firing. A refusal that names the fix is better than a
panel that quietly stopped running a backup.

**What was removed:**

- `kind` and `schedule` on a server entry. A server is always a supervised service.
- `home-hosted run <id>` → `home-hosted job run <id>`, with `home-hosted job ls` beside it.
- `POST /api/servers/:id/run` → `POST /api/jobs/:id/run`, plus `POST /api/jobs/:id/stop`.
- The `job` block on a server view, and the `NEXT RUN` column in `home-hosted ls`.
- **A job's stdout/stderr out of the panel log.** It goes to that job's own file now —
  `.hh/<workspace>/.logs/jobs/<id>.log` — and `home-hosted job log <id>` (or the **log** button on
  the Jobs page) reads it. The panel log keeps the summary lines only. If you were tailing the panel
  log at DEBUG to follow a backup, read `job log` instead: it has the same output, it is there
  whether or not the panel is verbose, and it is kept per job.

**What you gain:** jobs are no longer explained twice. The Servers page has no `kind` column and no
schedule field, its table has four columns always, and the rules about what a job may not declare
(`port`, `health`, `restart`, `persistent`) are gone because those fields no longer exist on a job —
a better answer than refusing them. Each job also gets its own expression, next run, last run, exit
code and **Stop** button on a page of its own.

## 0.15.0

**The password and the API token are one thing now: an account.** Each account has an `id` you type
and a `secret` only you hold. The same pair signs in to the panel *and* authenticates the API.

**Your existing credentials keep working — nothing to do.** The upgrade migrates on first read:

| You had | You now have |
| --- | --- |
| a panel password | an account `default` whose secret is that password, holding every scope |
| a 0.14 token named `monitor` | an account `monitor` with the same scopes and the same value |
| the pre-0.14 single token | an account `default` with that value, holding every scope |

So **the secret you type at the login screen is now paired with an id** — sign in as `default` with
your old password, or send a token as `Authorization: Bearer monitor:<the old token value>`. The id
goes in front of a colon; a value with no colon is refused rather than guessed, because there is no
longer a single-token model to fall back to.

**Why the id is needed at all.** A bare secret would have to be compared against every stored hash to
find its account, which is slower *and* a timing signal. The id is not secret — it is what a login is
keyed on and what makes a stolen secrets file unusable without it.

**You can now have more than one person.** `home-hosted account create <id> --scope read,lifecycle`
(or Global settings → Accounts) makes an account that can look and start things but not change
config. Accounts can be disabled without being deleted, limited to some workspaces, and revoked — and
revoking one ends its sessions immediately.

**What was removed:**

- `home-hosted set-password` → `home-hosted account secret <id>`, or `account reset` if you are
  locked out. `home-hosted set-token` → `home-hosted account create`.
- `POST /api/auth/password`, `POST`/`DELETE /api/auth/token` and `/api/auth/tokens` →
  `/api/auth/accounts`, `/api/auth/accounts/:id` and `/api/auth/accounts/me/secret`.
- `POST /api/auth/login` takes `{ id, secret }`, not `{ password }`.
- `DELETE /api/auth/password` still exists but now means "turn the guard off", and it **keeps the
  accounts** — disabling authentication is no longer the same act as destroying your way back in.

**One behaviour changed for the better:** rotating a credential used to sign *everyone* out. Now it
ends only that account's sessions, because a session belongs to an account. Two people on one panel
no longer log each other out.

## 0.14.0

**Exposing the panel beyond loopback now needs a password of at least 12 characters.** A panel bound
to a non-loopback address, or reached through a proxy route to the panel, refuses to start while its
password is shorter than that — and `home-hosted set-password` refuses to set one, as does
`POST /api/auth/password` (it answers `400 PASSWORD_TOO_SHORT`). A password short enough to guess
from the network is no longer enough protection. Passwords hashed by an older release carry no length
record and are not measured, so run `home-hosted set-password` once to be sure yours qualifies: a
loopback-only panel still accepts any length.

**`POST /api/servers` with an id that already exists answers `409 SERVER_EXISTS`.** It answered
`400 INVALID_SERVER`, the same code as a schema failure, so a client could not tell "pick another id"
from "fix the entry". Re-running the same declaration now reads as a conflict rather than a bad body.

**The README's hand-written systemd unit is gone; use `home-hosted service install`.** Uninstall the
old unit first (`systemctl --user disable --now home-hosted`), then run the command: it writes the
absolute `node` and CLI path, this home and project, your shell's `PATH`, and the two policies the old
unit got wrong. Its `Restart=always` brings the panel back after `down`, and its default `KillMode`
takes persistent entries down with the panel. On a user install it also prints the
`loginctl enable-linger` hint that keeps the panel running when you log out.

**https upstreams are verified.** A `server` or `external` proxy route to an https upstream with a
self-signed (or otherwise untrusted) certificate stops working. Set `upstreamSkipVerify: true` on that
route to accept it, as the route dialog now offers.

**An upstream with a path (`https://host/sub`) is rejected** and the route is not served — a proxy
route forwards the whole host, and the path part was silently dropped before. Point the route at the
host and keep the prefix in the route's own `path`, or use an upstream that serves it at the root.

**A DNS-01 "Automatic" account answers only for names in its zones.** The zones come from the
account's Dynamic DNS hostnames and from routes that name it, so a route whose hostname is in no zone
of the chosen account falls back to HTTP-01 instead of failing a challenge. Name the account on the
route when you want it used, and add the zone to the account (or to a DDNS hostname on it) when it is
missing.

**A hand-replaced Caddy binary is refused** while `engine.json` records the digest of the binary the
panel downloaded. Reinstall the engine, or delete `engine.json` to run the binary you put there as a
custom build.

**`ui-switch --file http://…` needs `--insecure`.** An installed release is checked against the digest
GitHub publishes, so a release download needs no flag; only a plain-http hand-supplied zip asks for
the opt-in, and plain http from a release URL is refused either way.

**`migrate` asks once for every file, then writes them all.** It planned and asked file by file, so a
person answering "no" partway through had already written the earlier ones. A "no" now writes nothing;
a non-interactive run still needs `--yes` (or `HHOSTED_MIGRATE=allow`).

**A new workspace id is at most 40 characters and cannot be a Windows device name** (`con`, `prn`,
`aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`), which no directory can carry there. Existing ids still
load, whatever their length — only creating one is bounded.

**`setup-temp --clear` leaves the shared helper in place** unless this home's `host.tempCommand` is the
one that runs it. The helper sits in a machine-wide directory, so another home on this machine may be
using it; delete the file yourself if you know none is.

**A query flag accepts only `0`, `1`, `true` or `false`, and a count must be inside its range.** The
four spellings become booleans; `yes`, `on` and `TRUE` are refused (`400 INVALID_INPUT`) instead of
being silently read as one of them. `/api/logs/:id?tail=` is 50–5000 and `/api/servers/:id/logs?limit=`
1–100000, and a value outside the range is **refused**, not clamped or defaulted — `tail=3` used to be
raised to 50 and `tail=abc` fell back to 500. `?logs=false` now drops the log frames it always claimed
to (it kept them; only the literal `0` worked).

**A lifecycle refusal's `code` names the refusal.** "disabled", "still stopping", "the port is taken"
and "a dependency did not start" all answered one `ACTION_FAILED`, so a script had to match the English
to tell four different fixes apart. They answer `SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE` and
`DEPENDENCY_FAILED` now; `ACTION_FAILED` remains for a refusal none of them describes. `ok:false` and
`error` are unchanged on the body.

**"No such backup" is `BACKUP_NOT_FOUND` on every route.** `GET`/`DELETE /api/backups/:name` answered
`UNKNOWN_BACKUP` while `/_hh/backups/restore` answered `BACKUP_NOT_FOUND` for the same condition.
A client handling one missed the other. The full list of codes is now one catalogue in
`src/shared/error-codes.ts`, published in `docs/API.md`.

**The OpenAPI document is restructured.** Inline response schemas are `$ref`s to
`components.schemas` (`ServerView`, `AppState`, `ErrorEnvelope`, `ActionResult`, `SseMessage` and each
SSE frame), the two stream routes declare `text/event-stream` with a discriminated `oneOf`, the UI
upload declares its `multipart/form-data` body, `sessionCookie` is a declared security scheme, and
every response enum also carries `x-extensible-enum`. **Regenerate any generated client** — the
document's shape changed, though the API behind it did not. A client generated from the old document
still works; it just carries the old anonymous types.

**A server view has an optional `restartRequired`.** A `PUT`/`PATCH /api/servers/:id` writes config
only. `restartRequired: true` says the running process predates a change to a field a restart re-reads
(`command`, `args`, `cwd`, `env`, `envFile`, `dataEnvs`, `port`, `bind`, `persistent`, `stop`). It is
absent when false, so an existing reader is unaffected — but a UI that shows "saved" and nothing else
is now telling half the story.

**`GET /api/servers` and a create answer an optional `warnings` list.** A `POST`/`PUT` whose `command`
holds a whole command line now reports it instead of letting the entry fail at spawn after every
retry. The create still succeeds; the field is absent when there is nothing to say.

**The UI is served with different cache headers, and a missing file is a 404.** Only a content-hashed
name under `/assets/` gets `immutable, max-age=31536000`; everything else, `index.html` included, is
`no-cache`. A missing file with an extension is a `404`, not the shell — a UI that referenced
`./assets/…` relative paths or relied on the catch-all for a missing asset will show the 404 it always
had. A **hand-copied** UI must have `index.html` at the root of `.ui`.

**The published types need no `@types/node`.** A browser project importing `home-hosted/client` used to
get 8 errors from the declarations and be told to install Node's types. If you patched around that with
`skipLibCheck: false` and a `types` entry, you can drop it.

**A server's secrets can move into the panel, and that is the arrangement a backup covers.** Today
they sit in an `envFile` beside the code, which no backup includes — a move to a new machine silently
loses them. `secretEnv` on the entry declares the **names** and `home-hosted secret set` (or the config
page) stores the values in the workspace's `.secrets.json`, which *is* backed up. Nothing changes
until you declare a name: an `envFile` keeps working exactly as it did, and its values still override
`env`. When a name has both, the secret wins — `env` < `envFile` < `dataEnvs` < `secretEnv`.

**Nothing new is required.** There is no migration: an entry without `secretEnv` behaves as before, and
`secretEnv` defaults to an empty list on the first save.

**A server can now deploy itself, and run on a schedule.** Both are opt-in fields on an entry, so
nothing changes until you add them:

- `deploy` — an ordered list of steps (`{ "command": "git", "args": ["pull"] }`), run by
  `home-hosted deploy <id>`, **Deploy** on the card, or `POST /api/servers/:id/deploy`. A failed step
  stops the sequence and leaves the running process alone; `restart` defaults to true. There is **no
  migration**: an entry without `deploy` refuses the action with `400 NO_DEPLOY` rather than doing
  anything surprising.
- `kind: "job"` and `schedule` — a run-to-completion entry on a 5-field cron expression. A job may
  not declare `port`, `health`, `restart` or `persistent` (the panel refuses at save time rather than
  silently ignoring them), and a service may not declare a schedule. **6-field expressions and
  `@daily`-style macros are refused by name** — this release parses 5 fields only, and accepting a
  6-field one would run it on a schedule nobody intended. `home-hosted run <id>` runs one now; `ls`
  gained a NEXT RUN column.

One behaviour worth knowing before you rely on it: a **missed** occurrence is replayed **once** at
boot, not once per missed day, and a job whose previous run is still going is skipped and recorded as
`overlap` rather than queued.

**`home-hosted import` is new, and it writes nothing without `--confirm`.** A pm2 ecosystem (`.json`,
or `.js` only with `--allow-js` — that one runs the file) becomes one entry per app; a compose file
becomes one entry for the stack. Nothing here changes an existing home: it only adds entries, and a
re-run over an existing id fails that entry with the panel's `409 SERVER_EXISTS` sentence.
