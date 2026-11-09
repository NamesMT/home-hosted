# Backups

One `.zip` holds the panel and the workspaces you pick — settings, servers, secrets and the data
each entry declares — and puts it back, on this machine or a blank one. Plain, or AES-256 with a
password. **Global settings → Backups**, or the CLI:

```bash
home-hosted backup list
home-hosted backup create --all --confirm
home-hosted backup create --all --exclude global:secrets --confirm
home-hosted backup restore <name> --all --confirm
home-hosted backup restore --from /media/usb/x.zip --all --confirm
```

Both work with the panel **stopped**, which is when you usually need them. Without `--confirm` they
plan first: at a terminal they ask, and without one (cron, CI) they print the plan and exit 1, so an
unattended job never mistakes a plan for a backup. `--json` without `--confirm` is just the plan.
The local channel the CLI uses plans by default too (`POST /_hh/backups` and `/_hh/backups/restore`
answer a plan unless `confirm=true`); over `/api`, `POST /api/backups` creates at once, and a restore
plans unless `?confirm=true`.

## What an archive holds

Selection is two-level: whole workspaces, or single pieces of one.

| id | what |
| --- | --- |
| `global:settings`, `global:secrets`, `global:tls` | panel-wide settings, the password/token hashes, the TLS pair |
| `workspace:<id>:settings` · `:servers` · `:secrets` | a workspace's settings, its `servers.config.json`, its notification/DDNS credentials |
| `workspace:<id>:secrets:<name>` | one secret, restored on its own |
| `workspace:<id>:data:<path>` | one declared data directory |

A data directory is anything an entry declares in `dataEnvs` or `backupPaths`. Generated
directories inside them (`node_modules`, `dist`, `.next`, caches) are skipped unless the entry sets
`backupIgnoreGenerated: false`. A symlink that leads **outside** a declared path is not followed —
declare its target instead — and file permission bits travel (`0600` stays `0600`). A declared path
that is *itself* a symlink (`data -> /mnt/disk/data`) is the data: its target is captured, and a
restore writes back into that target. A declared path that ends up holding no files (a mount that
was not up) is still archived, with a warning in the create result and on the CLI's stderr. Each
declared path gets its own place in the archive, however alike two names read (`/srv/app-data`,
`/srv/app/data`); archives written before that still restore.

## Automatic backups

A schedule writes one archive every N hours, named `auto-…`, with its own retention. `Keep` bounds
the archives you take by hand; a scheduled pass never prunes those. Only archives the panel wrote
are ever pruned — another tool's zips in the same directory are left alone. A scheduled pass is
skipped while a restore is running.

What a schedule captures:

| Mode | Carries | CLI spelling |
| --- | --- | --- |
| **Everything** *(default)* | every workspace, plus `includePaths` — including workspaces added later | `--all` |
| **Only these** | only what you tick | `--include <ids>` |
| **Everything except** | everything but what you tick, including workspaces added later | `--all --exclude <ids>` |

## Restoring

Start a **blank** home-hosted anywhere, upload the archive, restore. Workspaces the target has never
seen are created, data lands where *this* machine's config says, and `autostart` entries come up.

- **Paths match by declaration**, not by the source machine's absolute path: `{projectDir}`,
  `{dataRoot}` and `{home}` follow the restoring panel; a literal absolute path stays that path.
- **A restore never writes where no config declares**, and never across workspaces.
- **Older archives are lifted** through the same migrations `home-hosted migrate` runs; an archive
  from a *newer* release is refused.
- **One secret merges by field** — restoring the Telegram token leaves DDNS credentials alone, and
  excluding one secret keeps the local copy of it.
- **The password and token hashes are secrets too.** Restoring them reinstates the old machine's
  credentials. Leave `global:secrets` unticked, or rotate afterwards (`set-token --generate`).
- **The plaintext first-run password is never archived** — only its hash, which is all a restore
  needs.
- **DDNS credentials are sealed under `HHOSTED_DDNS_SECRET`**, which is not in the archive. Use the
  same value on the new host, or re-enter them.

### What comes back

| | Restored | Still yours to do |
| --- | --- | --- |
| Panel settings, workspaces, servers, defaults | ✅ | restart the panel if the listener or TLS changed (the plan says so) |
| Declared data directories | ✅ | see the database note below |
| Notification and DDNS config | ✅ | DDNS credentials need the same `HHOSTED_DDNS_SECRET` |
| Password and API token | per secret | leave unticked, or rotate |
| Reverse-proxy routes | ✅ | certificates are reissued; re-upload a `manual` pair |
| Reverse-proxy engine | ❌ | reinstall it from Global settings → Reverse proxy |
| Logs, crash history, nanny state | ❌ | they describe the old box |
| An entry's `envFile` | ❌ | machine-local by design — copy it, or declare its directory in `backupPaths` |
| The panel's own environment (`HHOSTED_*`, `${ENV}` values) | ❌ | set them on the new host |

## Worked example

[`demo/blank-host-restore.sh`](./demo/blank-host-restore.sh) runs the whole move against real
panels in throwaway directories (it needs Docker): host A gets one MongoDB-backed entry with data,
an archive is taken with `backup create --all --exclude global:secrets --confirm`, host B starts
blank, and `backup restore --from <archive> --all --confirm` brings the workspace, the entry and its
data back — the script then reads the database on host B to prove it.

```bash
docs/demo/blank-host-restore.sh   # cleans up after itself; touches nothing of yours
```

## Databases

Data directories are copied file by file while servers keep running. That is fine for files and
most app data, but **not a consistent snapshot of a live database** — SQLite mid-transaction or a
Postgres data directory can be captured torn and fail to open later.

For a real database, either stop that entry around the backup, or declare `dump`/`load` hooks so
the engine itself writes the backup ([SERVERS.md](./SERVERS.md#dumping-a-database-for-backups)).

Restoring has the mirror-image hazard: data copied under a **running** server is replaced beneath a
live process. The plan names those entries (`Data was replaced under a running server`); stop them
before applying, or restart them after.
