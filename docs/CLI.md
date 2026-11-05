# The CLI

`home-hosted <command>`, or `hh <command>` once installed. `home-hosted <command> --help` prints what
a command takes, and a misspelled command or flag suggests the one you meant.

## Commands

| Command | |
| --- | --- |
| `up` | start the panel, detached. Already running? Says where and exits 0 |
| `down` | stop the panel and everything it started — [persistent entries](./SERVERS.md#persistent-entries) keep running unless `--with-persistent` |
| `restart` | `down` then `up` (takes `up`'s flags); `restart <id>` restarts one server and leaves the panel up |
| `status` | is it running, where, how many servers are up, every path (`--json` for scripts) |
| `start <id>`, `stop <id>` | one server (`--free-port` frees its port before starting) |
| `free-port <id>` | ask whatever holds that server's port to stop; anything this panel supervises is refused |
| `logs [<id>]` | the panel's own console, or one server's log (`--lines`, `--follow`, `--json`) |
| `usage` | live CPU and memory per server, loudest first, with crash counts (`--json`) |
| `backup` | `list`, `create`, `restore` — works with the panel stopped. See [BACKUPS.md](./BACKUPS.md) |
| `set-password` | set the panel password (`HHOSTED_PASSWORD` for scripts, `--clear` to remove) |
| `set-token` | the API token for scripts and agents (`--generate`, `--clear`) |
| `migrate` | bring every config up to this release's schema (`--dry-run`, `--yes`) |
| `init` | scaffold a self-contained project whose scripts keep state in the repo |
| `ui-switch`, `ui-update`, `ui-revert` | install a UI, follow its releases, go back to stock |
| `setup-temp --wsl` | on WSL2, read the CPU temperature from the Windows host |

Server commands act in the panel's default workspace; `-w/--workspace <id>` picks another.

## Flags

```text
up                -p/--port <port> --host <local|lan|ipv4> --open --no-autostart --foreground --print-config
down              --with-persistent
restart           (no id) down, then up: up's flags plus --with-persistent
restart <id>      one server through the panel: [-w/--workspace <id>] — up's flags are refused here
status            --json
start <id>        [-w/--workspace <id>] [--free-port]
stop <id>         [-w/--workspace <id>]
free-port <id>    [-w/--workspace <id>]
logs [<id>]       --lines <n|all> --follow --json [-w/--workspace <id>]
usage             --json
backup            [list|create|restore] [<name> | --from <path>] (--include <ids> | --all) [--exclude <ids>]
                  --password <text> --confirm --json
init              --dir <dir> --name <name> --pm <pnpm|npm|yarn|bun> --no-install -y/--yes
set-password      --clear                      (HHOSTED_PASSWORD for a script)
set-token         --generate --clear           (HHOSTED_TOKEN for a script)
migrate           --dry-run -y/--yes           (HHOSTED_MIGRATE=allow for a script)
ui-switch         --repo <owner/name> --tag <tag> --asset <name> --file <path|url> --list --token <token> -y/--yes
ui-update         --check --tag <tag> --asset <name> --old --repo <owner/name> --token <token> -y/--yes
ui-revert         (no flags)
setup-temp        --wsl [--download | --no-download] | --clear

every command     --home <dir> --project <dir> -h/--help -v/--version   (or $HHOSTED_HOME, $HHOSTED_PROJECT)
environment       HHOSTED_PASSWORD, HHOSTED_TOKEN, HHOSTED_MIGRATE=allow, HHOSTED_DDNS_SECRET,
                  GITHUB_TOKEN / GH_TOKEN (ui-switch, ui-update)
```

A numeric flag must be a whole number (`--port 8000x` is refused, not read as 8000), and a flag a
command cannot honour is refused rather than ignored.

## Scripting

- `--json` prints **one JSON document on stdout, or nothing**; every refusal goes to stderr. Branch
  on the exit code first, then the document.
- Piping into `head` or `grep -q` exits 0, not with a broken-pipe error, so `set -o pipefail` is safe.
- `start` and `restart <id>` wait to confirm the process stayed up, so `start web && curl …` works.

## What `status` tells you

```text
home-hosted 0.12.0
  status     running
  servers    3 of 3 up
  pid        4242 · up 2h 14m
  url        http://127.0.0.1:3999 (http)
  …          project, state, log and per-server log paths
  password   k7mq-x2pd-9fh  (only while the first-run password is in use)
```

`status --json` always carries `running` and `liveness`:

| `liveness` | Means |
| --- | --- |
| `live` | the recorded pid is this panel |
| `unknown` | the pid is alive but the platform will not report its start time — counted as running |
| `gone` | nothing is running |
| `recycled` | the OS gave the recorded pid to another process; nothing is signalled |

- `running: true` with `"answering": false` means the process exists but does not respond — anything
  that waits for the panel to *serve* should read `answering`.
- `exitedCleanly: true` (with `lastStopAt`) means someone ran `down`; `false` means it died.
- If `run.json` is missing but something answers on the configured port, `status` reports
  `answeringWithoutRecord` and `down` refuses rather than guess which process to stop.

## Logs and usage

```bash
home-hosted logs                 # the panel's console: what it did, and anything it could not finish
home-hosted logs --follow        # like tail -f
home-hosted logs web             # one server's log
home-hosted logs api -w staging  # a server in another workspace
home-hosted usage                # what is eating the machine
```

`logs` reads files directly, so it works when the panel is wedged. An id the workspace does not
declare is refused with a suggestion rather than answered with an empty log. In `usage`, a stopped
server shows a dash, never `0`.

## Upgrading

```bash
home-hosted migrate --dry-run   # what would change, writes nothing
home-hosted migrate             # asks before each schema step, keeps a .bak beside each file
```

Each config records the release and schema that wrote it. A newer release always reads an older
config, and keys it does not know are kept and reported, never reset. A config it cannot read — a
wrong value, a duplicate id, a newer schema — stops `up` with the exact problem instead of starting
with defaults. Per-release notes live in the
[release notes](https://github.com/NamesMT/home-hosted/releases).

**Coming from 0.6.x:** install the latest 0.7.x and run it once — it moves the state into `.hh/` —
then upgrade.
