# Upgrading

Per-version migration notes, lifted into the GitHub release body by `scripts/release-notes.mjs`.
A section here is what a person reads when they upgrade — the CHANGELOG lists commits, not what to
do about them.

Keep each entry to what someone must *change*, not what was added. If a release has nothing a person
must act on, it needs no section here at all.

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
