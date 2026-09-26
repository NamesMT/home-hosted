# Servers

Every supervised process is one entry in `$HHOSTED_HOME/servers.config.json`. Add it with **➕ Add
server** in the panel, or write it by hand — the panel writes the same file.

```json
{
  "id": "myapp",
  "command": "node",
  "args": ["server.js"],
  "cwd": "./apps/myapp",
  "port": 8080,
  "autostart": true,
  "env": { "NODE_ENV": "production" },
  "health": { "mode": "http", "http": { "path": "/healthz" } }
}
```

Relative paths resolve against the directory you ran `home-hosted` from, so a project can keep its
servers and its state together.

## Field reference

| field | what it does |
| --- | --- |
| `command`, `args`, `cwd` | what to run, with `{placeholders}` resolved per entry |
| `env`, `dataEnvs`, `envFile` | environment; `dataEnvs` also marks data directories for backups, `envFile` keeps secrets out of the config |
| `port`, `bind` | enables the readiness wait, health checks and the conflict preflight; `local` keeps it on `127.0.0.1` |
| `onPortConflict` | `block` (default), `warn`, `follow`, `reclaim`, or `kill` — see below |
| `persistent` | run it under its own nanny so it survives the panel — see below |
| `health.mode` | `port` (TCP connect) or `http` (path, expected status, expected body) |
| `health.unhealthyThreshold`, `forceRestartAfterMs` | how many failed probes before the card warns, and when to restart anyway |
| `restart.*` | backoff: `maxRetries`, `baseDelayMs`, `factor`, `maxDelayMs`, `resetAfterMs` |
| `stop.*` | `signal`, `killGroup`, `graceMs`, and `killPortHolders` to sweep a leftover listener |
| `dependsOn` | ids that must be healthy first; stopped in reverse order |
| `resources.maxRssBytes` | restart when the process tree grows past a limit |
| `bootstrap` | one command to run once before the first start (migrations, warmups) |
| `backupPaths`, `backupIgnoreGenerated` | extra paths this entry owns, included in backups; the flag (on by default) skips the known build and dependency directories inside them — `node_modules`, `dist`, `.next`, framework caches |

### Placeholders

| placeholder | resolves to |
| --- | --- |
| `{id}` `{label}` | the entry's id, and its label (falling back to the id) |
| `{port}` | its configured port, empty when it has none |
| `{bind}` `{host}` `{displayHost}` | `local`/`lan`/an address; the address it binds (`127.0.0.1`, `0.0.0.0`); the address to *show* (`127.0.0.1`, the LAN IP) |
| `{lanIp}` | this machine's LAN address, or `127.0.0.1` |
| `{cwd}` | the entry's working directory (its `cwd`, else the project directory) |
| `{projectDir}` | where you ran `home-hosted` (or `--project`) — `$HHOSTED_PROJECT` |
| `{dataRoot}` | the state directory — `$HHOSTED_HOME`, default `~/.home-hosted` |
| `{home}` | the current user's home directory |

Unknown placeholders stay visible instead of silently becoming empty, and `${VAR}` reads from the
environment (including `envFile`). Every supervised process also gets `HHOSTED_SERVER_ID` and
`HHOSTED_CONTROL_PORT`, so a service can tell which entry it is and how to reach the panel.

`dataEnvs` is the one that pays for itself twice: the value is exported to the process *and* the path
is picked up by Backups, so a data directory is declared once.

## A busy port

Preflight runs before every start, so two servers cannot silently fight over one port.

| `onPortConflict` | what happens when something already listens |
| --- | --- |
| `block` *(default)* | the entry goes to **conflict** with `port 4000 is already in use (pid 4242)`, and does not start |
| `warn` | it starts anyway — useful when the listener is a leftover you are replacing |
| `follow` | if the listener is a **detached restart of this same entry**, the panel adopts it as-is; anything else blocks, exactly like `block` |
| `reclaim` | same detection, but it stops that successor and starts a fully supervised process of its own |
| `kill` | stops **whatever holds the port** — no ownership test — then starts. The blunt one: see below |

### When a program restarts itself

Some programs restart themselves by launching a new detached process and exiting — a plugin doing an
update, a `re-exec` on config change. The panel used to see the successor's port as a conflict and sit
there blocked while the service was actually up.

Every process gets `HHOSTED_SERVER_ID` in its environment and a successor inherits it, so the preflight
can tell a successor from a stranger — read from `/proc` on Linux and `ps -E` on macOS. **Windows
cannot read another process's environment**, so there the entry's own argv answers instead: a process
holding the port is the successor when its image and its arguments are both the entry's own. That
fallback also covers a Linux or macOS program that restarted itself in a way that dropped the marker.
Two policies act on the result:

| policy | what it does | trade-off |
| --- | --- | --- |
| `follow` | adopts the successor: pid, health probe, CPU/RSS, stop, and it starts its own process again when the successor exits | **keeps exactly what the program set up**, but its output is not captured — the pipe belongs to whoever spawned it, so that entry's log in the panel goes quiet |
| `reclaim` | stops the successor, then starts a fully supervised process of its own | **full features** — live logs, resources, stop semantics all behave like any other entry — at the cost of one restart |

Identification is deliberately strict, because `reclaim` kills what it identifies: the image has to be
the entry's resolved command **and** the arguments have to be the entry's own, compared literally — an
argument sharing a basename with another program's is not a match. When **more than one** holder
matches, the panel refuses to guess and blocks, naming the pids. These are the cases that still block
rather than being identified:

- a successor that re-execs under a **different image**, or rewrites its own arguments;
- an argument read back ambiguously — on macOS `ps` joins argv with spaces, so an argument that itself
  contains a space cannot be told from two arguments;
- a Windows entry launched through an `npm`/`pnpm` **`.cmd` shim**: the shim runs under `cmd.exe`, so
  the process actually holding the port is `node.exe` and its argv never mentions the shim;
- a Windows entry whose `CommandLine` PowerShell cannot read.

`kill` exists precisely for those cases: it does not need to identify anything.

Both are shown as **detached** in the panel while adopted, both can be stopped and restarted like any
other entry, and neither will ever start a second copy on top of a **stranger**: that still blocks,
exactly like `block`.

If the holder is ours under a different policy, the conflict message says so, which is how the setting
is discovered:

```text
port 4374 is already in use (pid 912) — pid 912 is a detached restart of this entry:
set onPortConflict to "follow" to adopt it, "reclaim" to replace it with a supervised process,
or "kill" to stop whatever holds the port
```

### The `kill` policy

`follow` and `reclaim` need to know *whose* port it is. When they cannot answer that — a program that
re-execs under a different image, or two holders that both look like the entry — `kill` skips the
question:

1. SIGTERM every listener on the port, escalating to SIGKILL after `stop.graceMs`.
2. Wait for the port to actually accept nothing, then start as usual.
3. If the port is somehow still held, the entry goes to **conflict** with the pids it tried —
   it does **not** retry in a loop.

It is the one policy that will stop a **stranger** whose port you have configured, so the log says
which pids it stopped and why. It will not touch the panel itself or any process the panel
supervises: a port held by a sibling entry is a config mistake and still blocks, exactly as it does
under `block`. If it is a stray leftover you would rather inspect first, the **Free port** button on
the server card does the same thing on demand.

Because a detached successor is not something the panel supervises, `kill` ends up doing what
`reclaim` does for your own restarted process — stops it and starts a supervised child — without ever
asking whether it was yours. Only `follow` ever adopts, and only `reclaim` will refuse to act on a
holder it cannot prove is yours.

## Persistent entries

`"persistent": true` means "keep this running whatever happens to the panel". It is off by default,
it is per entry (not a `Settings → Server defaults` field), and it covers the three ways the panel can
go away: `down`, a restart, or being killed outright.

How it works: the panel does not run the entry directly. It spawns a **nanny** — the same CLI, hidden
`__nanny` mode — which starts the entry, owns its pipes and writes its output to the entry's own log
file. The nanny is what survives; the panel reattaches to it on the next boot through
`$HHOSTED_HOME/.state/<id>.json`, and a stale file is how it learns how a child ended while nobody was
watching.

What that changes:

- **`down`, `restart` and `stop-all` leave it running** and say so (`2 persistent server(s) left
  running: …`). Only an explicit **Stop** on that entry — or removing/disabling it — ends it.
- **It is reattached, not restarted.** `--no-autostart` still starts nothing, but a persistent entry
  that is already running is adopted, because leaving it unmanaged would make the panel treat its own
  server as a stranger on the port.
- **Logs keep flowing.** The panel tails the nanny's file, so history survives the panel being down;
  `logs.persist: false` still keeps it out of the Logs page — but a file has to exist in
  `.logs/`, because there is no pipe to carry the output.
- **A crash while the panel is away is reported, not restarted.** Retries and backoff remain the
  panel's job, so an entry that dies with nobody watching shows up as **crashed** on the next boot
  with the exit code in its log.
- **Port policies still apply, as a fallback.** A persistent entry reattaches from its state file
  before any preflight runs, so `onPortConflict` matters only when that state is gone — and `follow`
  is then the policy that adopts instead of blocking.
- **A program that restarts itself wants `reclaim`, not `follow`.** The nanny lives exactly as long
  as the child it owns: when that child exits to hand over to a successor, the nanny exits too, and
  nothing is left writing the entry's log — `follow` would adopt the successor with no capture at
  all. `reclaim` stops it and starts a fresh nanny, which is both the log and the persistence back.

### What still ends one

The panel is not the only thing that can sweep a process off a machine. A persistent entry is a
normal process, so it is still subject to:

- **systemd**, when the panel runs as a unit with the default `KillMode=control-group` — stopping the
  unit kills everything in its cgroup, nanny included. Use `KillMode=process` if you want the panel's
  own lifecycle to be the only thing that decides.
- **A container.** Docker stops everything in the container's PID namespace, so persistence means the
  panel's lifetime inside that container, not the host's.
- **Windows, on the forced path.** `taskkill /T` walks the parent tree, and `down --force` uses it;
  the graceful path (which is what `down` normally takes) leaves a persistent entry alone.

## Editing fields

Changes from the panel are atomic and validated before they are written. Editing the file by hand —
an editor, a `git checkout`, a config-management tool — is picked up within a couple of seconds, no
restart needed:

- **A definition you changed** takes effect on that entry's next start; a running process is not
  restarted under you.
- **A definition you added** appears (and starts itself if it is `autostart`); **one you removed** is
  stopped and forgotten.
- **A file the schema rejects, or one that cannot be parsed**, is reported in the panel with the
  exact path and the running config is left alone. Fix it and it reloads on its own — a typo never
  stops a server.

A save from the panel's own UI is the panel's write: it replaces the file, so hand-edits made while
it runs are lost by that next save. Edit, then let the panel read it back, before using the UI.
