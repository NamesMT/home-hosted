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
$ home-hosted backup create
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

`--confirm` skips the prompt, which is what a cron job wants. `--json` prints the same plan as JSON
and never applies, so a script or an agent can read it and decide.

### Narrowing what an archive carries

`--include` takes the ids from the plan, comma-separated:

```console
$ home-hosted backup create --include workspace:default:servers,global:settings
```

`--all` is the only way to say "everything", and it is the default when neither flag is given. An
empty `--include` is **refused** rather than treated as "nothing selected" — a script passing an
unset `$LIST` gets an error instead of quietly backing up (or restoring) the whole machine:

```console
$ home-hosted backup create --include "$UNSET"
error --include is empty — name the ids to act on, or pass --all for everything
```

`--include` and `--all` together is also refused, since one of them would silently win.

The archive is a plain zip. Its contents, in full:

```text
data/
data/srv-blog-dump/
data/srv-blog-dump/blog.archive      <- the database dump
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
0

$ docker exec hh-demo-blog mongorestore --archive=/srv/blog/dump/blog.archive --drop
$ docker exec hh-demo-blog mongosh --quiet --eval 'db.getSiblingDB("blog").posts.countDocuments()'
3
```

Three documents, on a host that started with nothing.

## What is recovered, and what is not

| | |
| --- | --- |
| ✅ **Recovered** | Every workspace and its label. Every entry, with its command, args, env, port and policies. Workspace settings: notifications, DDNS, log retention, server defaults. Panel settings: listener, TLS policy, host vitals, backup schedule, proxy routes. Secrets, if you kept them ticked. Declared data paths, including the database dump. |
| ⚠️ **Recovered, then you must act** | The **password hash and API token hash** travel in `global/secrets.json`, so the restored host has the old machine's credentials. Anyone holding that token still has access. Rotate with `home-hosted set-token --generate`, or exclude those secrets and set them fresh. |
| ⚠️ **Recovered, but the database needs its own step** | The panel restores **files**, not databases. It puts `blog.archive` back where it was; applying it is `mongorestore` (or `pg_restore`, `.restore`, whatever your engine calls it). That is deliberate: only the engine knows how to apply its own dump. |
| ❌ **Not recovered** | `HHOSTED_DDNS_SECRET`, the key DDNS credentials are sealed under. It is never archived, so a restored host cannot decrypt them until you set it again. |
| ❌ **Not recovered** | Anything not in a `backupPaths` directory or the panel's own state: files your entries wrote elsewhere, host packages, `/etc` changes, a reverse proxy outside the panel, cron jobs, the docker images themselves. |
| ❌ **Not recovered** | The UI you had installed, if it was not the stock one. An official UI is fetched again on the next `up`. |

## Re-running it

The script is the reproducible form of everything above:

```sh
docs/demo/blank-host-restore.sh
```

It creates two state directories, seeds a real MongoDB, dumps it, backs it up, restores onto the
blank second host, starts the entry there and asserts the documents came back. It exits non-zero if
they do not.
