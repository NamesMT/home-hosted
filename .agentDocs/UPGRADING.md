# Upgrading

Per-version migration notes, lifted into the GitHub release body by `scripts/release-notes.mjs`.
A section here is what a person reads when they upgrade — the CHANGELOG lists commits, not what to
do about them.

Keep each entry to what someone must *change*, not what was added. If a release has nothing a person
must act on, it needs no section here at all.

The script reads only the section for the version being released, so a section is deleted once that
version ships: its text lives on in that GitHub release's body.

## 0.13.0

**A config save can now answer `409 CONFIG_CHANGED_ON_DISK`.** When a `settings.json` or
`servers.config.json` was edited on disk after the panel last read it, a write through the API is
refused instead of silently overwriting that edit. The panel reloads the file; retry the request. A
script that treats every non-2xx as fatal should retry this one once.
It is also refused while the file on disk does not parse or fails validation: fix the file first, then
retry.

**With no password in force, `/api` answers only this machine or the API token.** A panel with auth
off that you reached through nginx, Caddy or a tunnel on the same host now answers those requests
`401 AUTH_DISABLED_REMOTE`. Set a password (`home-hosted set-password`) to use it that way.

**`backup create` / `backup restore` without `--confirm` and without a terminal exit 1.** A cron job
or CI step printed the plan and exited 0 before, so a missing `--confirm` never took a backup. Add
`--confirm`; `--json` without it is still the plan, exit 0.

**`logs --lines` takes a whole number of at least 1, or `all`.** `--lines 0` (it meant the whole
log) is now refused: use `--lines all`.

**The published client refuses to send a token over plain http to another host.** Use https, or
pass `allowInsecureToken: true` to `createClient` if the network is yours.

**Failed sign-ins are capped panel-wide** (100 per 10 minutes, on top of the per-address limit).
Past the cap every sign-in waits out the window; `home-hosted set-password` on the machine still
works.

**DDNS sends every record once more after the upgrade**, to record its options (`ttl`, `proxied`) in
the cache.

**`home-hosted usage` names its column `STARTS`, and `--json` emits `starts`.** The column used to be
`RESTARTS` and counted start events, so a server that had never restarted read `1`. If a script reads
that JSON, switch it to `starts`; the panel's own `server.restarts` — the crash budget spent out of
`restart.maxRetries` — is a different quantity and is unchanged.

**A supervised child now survives a hard panel death, and its output is a file.** Entries run as
before; what moved is where a child's stdout and stderr land, from a pipe the panel held to
`.hh/<workspace>/.state/<id>.out` and `.err`, which the panel reads back into the usual
`.logs/<id>.log`. Those two files are transport: not served, not counted against `logs.keep`, not
backed up, and removed with the entry. A server that writes faster than the panel reads now has the
oldest unread bytes dropped, cut on a line boundary, with `<stream>: the server wrote faster than the
panel could read it — N KiB of its output was dropped` in its own log rather than a silently growing file.

**A restore that would write the panel's own credentials needs a signed-in session.** `include`
naming `global:secrets`, a field of it, or its short alias `secrets` now answers `403 SESSION_REQUIRED`
to an API token. That was always the intent; the alias spelling was not covered.
