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
| `onPortConflict` | `block` (default), `warn`, `follow`, or `reclaim` — see below |
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
holding the port is the successor when its image and arguments are the entry's own. That fallback also
covers a Linux or macOS program that restarted itself in a way that dropped the marker. Two policies
act on the result:

| policy | what it does | trade-off |
| --- | --- | --- |
| `follow` | adopts the successor: pid, health probe, CPU/RSS, stop, and it starts its own process again when the successor exits | **keeps exactly what the program set up**, but its output is not captured — the pipe belongs to whoever spawned it, so that entry's log in the panel goes quiet |
| `reclaim` | stops the successor, then starts a fully supervised process of its own | **full features** — live logs, resources, stop semantics all behave like any other entry — at the cost of one restart |

Identification is deliberately strict, because `reclaim` kills what it identifies: the image has to be
the entry's resolved command and its arguments have to open with the entry's own, and when **more than
one** holder matches, the panel refuses to guess and blocks, naming the pids. A successor that re-execs
under a different image is not recognized, and neither is one that rewrites its own arguments.

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
