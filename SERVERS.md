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
| `onPortConflict` | `block` (default), `warn`, or `adopt` — see below |
| `health.mode` | `port` (TCP connect) or `http` (path, expected status, expected body) |
| `health.unhealthyThreshold`, `forceRestartAfterMs` | how many failed probes before the card warns, and when to restart anyway |
| `restart.*` | backoff: `maxRetries`, `baseDelayMs`, `factor`, `maxDelayMs`, `resetAfterMs` |
| `stop.*` | `signal`, `killGroup`, `graceMs`, and `killPortHolders` to sweep a leftover listener |
| `dependsOn` | ids that must be healthy first; stopped in reverse order |
| `resources.maxRssBytes` | restart when the process tree grows past a limit |
| `bootstrap` | one command to run once before the first start (migrations, warmups) |
| `backupPaths` | extra paths this entry owns, included in backups |

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
| `adopt` | if the listener is a **detached restart of this same entry**, the panel adopts it; anything else blocks, exactly like `block` |

### Adopting a self-restarting program

Some programs restart themselves by launching a new detached process and exiting — a plugin doing an
update, a `re-exec` on config change. The panel used to see the successor's port as a conflict and sit
there blocked while the service was actually up.

`adopt` fixes that. Every process gets `HHOSTED_SERVER_ID` in its environment, the successor inherits
it, and the panel reads that marker (Linux `/proc`, macOS `ps -E`) to tell a successor apart from a
stranger:

- **ours** → adopt: report it running with the successor's pid, health-probe it, sample its CPU/RSS,
  and start our own process again when it exits.
- **a stranger** → it blocks, exactly like `block`, and the banner names the pid. `adopt` never starts
  a second copy on top of somebody else's listener.

Adopted entries are marked **detached** in the panel, can be stopped and restarted like any other, and
their output stays wherever the successor redirected it — the panel reads their state, not their pipe.
On Windows there is no per-process environment, so adoption does not apply and you get the conflict
banner plus the free-port button instead.

If the holder is ours but the policy is not `adopt`, the message says so, which is how you discover
the setting:

```text
port 4374 is already in use (pid 912) — pid 912 is a detached restart of this entry;
set onPortConflict to "adopt" to follow it
```

## Editing fields

Changes from the panel are atomic and validated before they are written. Editing an entry in the file
by hand is picked up without a restart; a value the schema rejects is refused with the exact path, and
the panel keeps running on the config it already had.
