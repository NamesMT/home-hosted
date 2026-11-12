# The CLI

`home-hosted <command>`, or `hh <command>` once installed. `home-hosted <command> --help` (or
`home-hosted help <command>`) prints what a command takes, and a misspelled command or flag suggests
the one you meant. Every command and flag on one screen: the README's
[CLI section](../README.md#-cli). This page is the depth behind it.

## Rules every command follows

- A numeric flag must be a whole number (`--port 8000x` is refused, not read as 8000; `--lines` takes
  1 or more, or `all`), and a flag a command cannot honour is refused rather than ignored.
- Server commands act in the panel's default workspace; `-w/--workspace <id>` picks another.
- Hints name the command as you ran it, `--home` included, so they can be pasted.
- Commands that only look — `status`, `logs`, `usage`, `backup list`, a backup plan — never create
  state files. Whatever creates `.hh` first creates it `0700`.
- `up --port`/`--host` are saved to `settings.json`, so the next plain `up` binds the same way.
  `restart` checks every `up` flag before it stops anything, and stops if `down` fails.

## Scripting

- `--json` prints **one JSON document on stdout, or nothing**; every refusal goes to stderr. Branch
  on the exit code first, then the document. The one exception is a stream, which has no single
  document: `logs --follow --json` prints **one object per line** (NDJSON), each `{ path, line }`, so
  a consumer needs no out-of-band knowledge of which file it is reading.
- Piping into `head` or `grep -q` exits 0, not with a broken-pipe error, so `set -o pipefail` is safe.
- `start` and `restart <id>` wait to confirm the process stayed up, so `start web && curl …` works.
- `backup create`/`restore` never write without consent: at a terminal they ask, and without one they
  print the plan and **exit 1** unless `--confirm` is given — a cron job without it fails loudly
  instead of silently taking no backup. `--json` without `--confirm` is the plan request and exits 0.

## What `status` tells you

```text
home-hosted <version>
  status     running
  servers    2 of 3 up
             worker  crashed  ← needs attention
             web     running
             api     running
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
- If `run.json` is missing but **this home's** panel answers on the configured port (its `/healthz`
  says which home it serves), `status` reports `answeringWithoutRecord` and `down` refuses rather
  than guess which process to stop. Anything else on that port — another home's panel, another
  program — is `portTakenByOther`: `down` has nothing of this home to stop and exits 0, and `up` will
  need another `--port`.
- With the panel stopped, **persistent entries are still listed**: `status` names each one still
  running (`persistentRunning` in `--json`), `stop <id>` stops one through its own supervisor, and
  `down --with-persistent` stops them all.

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
server shows a dash, never `0`. `STARTS` and `CRASH` cover the history window: `STARTS` counts start
events, so a long-lived server shows the start it got (usually `1`) rather than `0`, and a flapping
one climbs — which is what makes it visible while its live CPU and memory still look idle. It is
**not** the retry budget the panel shows on a server's card: that is `server.restarts`, the crashes
spent out of `restart.maxRetries` on the current sequence, which a deliberate start resets. `--json`
names the count `starts` for the same reason (a panel predating the rename sends `restarts`, and this
command reads either).

## Starting at boot

```bash
home-hosted service install           # this account: systemd --user, a LaunchAgent, a logon task
home-hosted service install --system  # the machine, at boot: /etc/systemd/system, a LaunchDaemon, a SYSTEM boot task
home-hosted service install --print   # the unit on stdout, nothing written or run
home-hosted service status            # whether it is installed, and what the manager says
home-hosted service uninstall         # stop it, unregister it, remove the file
```

The unit runs `<node> <cli> --home <home> --project <project> up --foreground` with absolute paths,
`HHOSTED_HOME`/`HHOSTED_PROJECT`, and the installing shell's `PATH` (this node's directory first;
fnm's per-shell directories are dropped, since they vanish at reboot). It is named `home-hosted` for
the default home and `home-hosted-<8 hex>` for any other, so two homes get two units.

- **Only the panel is signalled on stop** (`KillMode=process`; launchd `AbandonProcessGroup`): the
  panel stops its own servers, and persistent entries keep running as they do on `down`.
- **It restarts only after a failure.** `down` exits 0, so the panel stays down until the next boot
  or `systemctl start`.
- **A Linux user service** stops at logout and waits for a login after a reboot; `loginctl
  enable-linger <you>` keeps it running without one.
- An install over an existing unit is refused — `uninstall` first, or edit the file it names.
- On Windows the task XML is kept in `.hh/.service/` as the record of what was registered; a task
  cannot carry environment variables, so the home and project travel as flags and `PATH` is the
  account's own.

## Upgrading

```bash
home-hosted migrate --dry-run   # what would change, writes nothing
home-hosted migrate             # asks once before any schema step, keeps a .bak beside each file
```

Each config records the release and schema that wrote it. A newer release always reads an older
config, and keys it does not know are kept and reported, never reset. A config it cannot read — a
wrong value, a duplicate id, a newer schema — stops `up` with the exact problem instead of starting
with defaults. A file no schema step changes needs no migration: a hand-written
`servers.config.json` with no `meta` loads as it is, and `migrate` only restamps it. Per-release notes live in the
[release notes](https://github.com/NamesMT/home-hosted/releases).

**Coming from 0.6.x:** install the latest 0.7.x and run it once — it moves the state into `.hh/` —
then upgrade.
