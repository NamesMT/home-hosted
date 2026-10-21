# Blank-host restore, with a database

A worked example: one home stack backed up on one machine, restored onto a machine that starts with
nothing, and the database read back afterwards.

Every command below is real. The whole thing is a script you can run:
[`blank-host-restore.sh`](./demo/blank-host-restore.sh). It uses throwaway directories under `$TMPDIR` and
docker containers it removes on exit, so it touches nothing of yours.

```sh
docs/demo/blank-host-restore.sh
```

## The stack

One entry: a MongoDB container, with a database dump declared as its data.

```json
{
  "id": "blog-db",
  "command": "docker",
  "args": ["run", "--rm", "--name", "hh-demo-blog", "-p", "27017:27017", "mongo:7"],
  "port": 27017,
  "backupPaths": ["/srv/blog/dump"]
}
```

`backupPaths` is the important field. It names what belongs to this entry **beyond** its config, and
that is what the archive carries.

## Backing it up

`create` plans first. That listing is what the archive *would* contain, and nothing has been written
yet:

```console
$ home-hosted backup create --all
Plan — what a backup would capture; nothing has been written yet
  settings   global:settings
  secrets    global:secrets
    - global:secrets:password
    - global:secrets:apiToken
  tls        global:tls  (does not exist yet)
  workspace  workspace:default
    - workspace:default:settings
    - workspace:default:servers
    - workspace:default:data:/srv/blog/dump

Take this backup? [y/N] y

$ home-hosted backup list
1 archive in /home/you/.home-hosted/.hh/.backups
  backup-2026-10-21-04-15-49-881.zip       4 KB  2026-10-21 04:15
```

`--all` is required: a scope is never assumed, so `backup create` with neither flag refuses and
lists what could be picked. `--confirm` skips the prompt, which is what a cron job wants. `--json` prints the same plan as JSON
and never applies, so a script or an agent can read it and decide.

### Databases dump themselves

A database file copied while the engine runs is a torn copy. Declare `dump` and `load` on the entry
and the backup runs `mongodump` for you, into a `{dumpDir}` the archive carries; the restore runs
`mongorestore` from the same place. A failed dump **refuses the backup**, so an archive is never
half-done. See the engine table in [SERVERS.md](./SERVERS.md).

```console
$ home-hosted backup create --all --confirm
backup created backup-2026-10-21-06-55-40-147.zip (3 KB)

$ home-hosted backup restore backup-2026-10-21-06-55-40-147.zip --all --confirm
restored 3 items from backup-2026-10-21-06-55-40-147.zip
  load blog-db: ran
```

### Working while the panel is stopped

`backup` does not need the panel. It drives the same service either way, so a stopped panel is fine —
which is the point, since stopping the services is what someone does before a careful backup or a
migration:

```console
$ home-hosted down
$ home-hosted backup create --all --confirm
backup created backup-2026-10-21-06-55-40-147.zip (3 KB)
```

A **persistent** entry keeps running when the panel stops, so "panel off" is not "services off". Those
are named before the backup is taken, and it proceeds anyway — refusing would block the migration this
exists for:

```console
$ home-hosted backup create --all
Plan — what a backup would capture; nothing has been written yet
...
! 1 entry is still running (gitea) — its data may be captured mid-write

Take this backup? [y/N]
```

A restore writes a **lock** (`<state>/.hh/restore.lock`), taken by the service itself — so the panel's
own restore and this one exclude each other, and neither two shells nor a shell and the page can write
the same host at once. A lock left by a process that died is taken over; one held by a live process
names it and stops. A dry run takes none, because it writes nothing.

### Narrowing what an archive carries

`--include` takes the ids from the plan, comma-separated:

```console
$ home-hosted backup create --include workspace:default:servers,global:settings
```

`--exclude` is the other direction, and the usual one: naming the one thing to leave out beats listing
everything else. It applies after `--include`, and an excluded id covers what is under it.

```console
$ home-hosted backup create --all --exclude global:secrets --confirm
```

That is the command to reach for. `global:secrets` is the panel's password hash and API token hash, so
leaving it out keeps the archive from carrying the machine's credentials and keeps a restore from
replacing the target panel's with the source's. A per-field form works too —
`--exclude global:secrets:password` keeps the token and drops only the password.

`--all` is the only way to say "everything" — giving **neither** flag is refused, not assumed, so the
destructive default cannot be reached by silence:

```console
$ home-hosted backup create --confirm
error name what to act on — pass --include <ids> or --all

available (or narrow it):
  global:settings
  global:secrets
  global:tls
  workspace:default

--exclude <ids> leaves those out: --all --exclude global:secrets
```

An empty `--include` is refused too, rather than treated as "nothing selected" — a script passing an
unset `$LIST` gets an error instead of quietly backing up (or restoring) the whole machine:

```console
$ home-hosted backup create --include "$UNSET"
error --include is empty — name the ids to act on, or pass --all for everything
```

`--include` and `--all` together is also refused, since one of them would silently win.

The archive is a plain zip. Its contents, in full:

```text
dumps/
dumps/default/blog-db/
dumps/default/blog-db/blog.archive   <- what the entry's `dump` hook wrote
global/
global/secrets.json                  <- password hash, API token hash
global/settings.json                 <- listener, TLS policy, host vitals, proxy
global/workspaces.json               <- the registry: what workspaces exist
manifest.json                        <- what release wrote it, and the schema it understood
workspaces/
workspaces/default/
workspaces/default/servers.config.json
workspaces/default/settings.json
```

**The dump is the data.** `backupPaths` pointed at a directory holding `mongodump` output, not at
MongoDB's live data directory. That distinction matters: copying a running database's files can
capture it torn, which [`README.md`](../README.md#-backups) warns about. A dump is consistent by
construction.

## Restoring onto a blank host

```console
$ home-hosted backup restore backup-2026-10-21-04-15-49-881.zip
Plan for backup-2026-10-21-04-15-49-881.zip — nothing has been written yet
  settings   global:settings
  secrets    global:secrets
  secrets    global:secrets:password
  secrets    global:secrets:apiToken
  settings   workspace:default:settings
  servers    workspace:default:servers
  data       workspace:default:data:/srv/blog/dump

apply it with `home-hosted backup restore backup-2026-10-21-04-15-49-881.zip --confirm`
```

The plan comes first, always. A restore writes over live data, so the default is to say what it
*would* do.

```console
$ home-hosted backup restore backup-2026-10-21-04-15-49-881.zip --confirm
restored 7 items from backup-2026-10-21-04-15-49-881.zip
```

The workspace did not exist on this host. It was created, not skipped: an archive is a whole machine's
setup, and refusing it because the id is new would make a blank-host restore impossible.

Then the entry starts, and the database is read back:

```console
$ home-hosted start blog-db
started blog-db

$ docker exec hh-demo-blog mongosh --quiet --eval 'db.getSiblingDB("blog").posts.countDocuments()'
3
```

Nothing applies the dump by hand: `start` ran the entry's `load` hook, which replays it. The hook
runs in the background once the port answers, so `start` returns before it finishes — the read above
is simply taken after it has. A fresh container holds `0` documents, and this number is what the dump
put there.

Three documents, on a host that started with nothing.

> [!WARNING]
> `global:secrets` holds the **panel password hash and API token hash**. A backup that carries it
> carries the machine's credentials, and a restore that applies it **replaces** the target panel's
> password and token with the old machine's. Leave it out unless that is what you want:
>
> ```sh
> home-hosted backup create --all --exclude global:secrets --confirm
> home-hosted backup restore <name> --all --exclude global:secrets --confirm
> ```
>
> That is the recommended default for a shared or moved archive. After restoring one that did carry
> it, rotate with `home-hosted set-token --generate` and `set-password`.

## What is recovered, and what is not

| | |
| --- | --- |
| ✅ **Recovered** | Every workspace and its label. Every entry, with its command, args, env, port and policies. Workspace settings: notifications, DDNS, log retention, server defaults. Panel settings: listener, TLS policy, host vitals, backup schedule, proxy routes. Secrets, if you kept them ticked. Declared data paths, including the database dump. |
| ✅ **Recovered** | Secrets, if you kept them selected. |
| ✅ **Recovered, and the database loads itself** | With `dump`/`load` hooks on the entry, the backup runs the engine's own dump and the restore replays it. The load runs on the entry's **next start**, because `mongorestore` needs a server that is answering. Without hooks, the panel restores files only and applying the dump is your step. |
| ❌ **Not recovered** | `HHOSTED_DDNS_SECRET`, the key DDNS credentials are sealed under. It is never archived, so a restored host cannot decrypt them until you set it again. |
| ❌ **Not recovered** | Anything not in a `backupPaths` directory or the panel's own state: files your entries wrote elsewhere, host packages, `/etc` changes, a reverse proxy outside the panel, cron jobs, the docker images themselves. |
| ❌ **Not recovered** | `$HHOSTED_HOME/.ui` is not archived, so the panel keeps whatever UI it already has on that host. It is not replaced by the UI of the panel that took the backup. |

## Re-running it

The script is the reproducible form of everything above:

```sh
docs/demo/blank-host-restore.sh
```

It creates two state directories, seeds a real MongoDB, dumps it, backs it up, restores onto the
blank second host, starts the entry there and asserts the documents came back. It exits non-zero if
they do not.
