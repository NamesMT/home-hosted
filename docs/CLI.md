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

## Accounts without a browser

```bash
home-hosted account create admin            # a new account; the secret is printed once
home-hosted account create monitor --scope read   # a monitor that cannot start or change anything
home-hosted account ls                      # ids, labels, scopes — never a secret
home-hosted account secret admin            # prompts, or HHOSTED_SECRET=… for a script
home-hosted account revoke monitor          # immediately; its sessions end too
home-hosted account reset admin             # the recovery path when you are locked out
home-hosted account disable-auth            # the guard off; the accounts are kept
```

An **account** is one credential: `create` prints an id and a secret, and that pair both signs in to
the panel and authenticates the API as `Authorization: Bearer <id>:<secret>`. Only a hash is stored,
so the secret is shown exactly once.

`--scope` takes a comma-separated subset of `read`, `lifecycle`, `config`, `admin` (cumulative;
default all four), and `-w/--workspace` limits the account to some workspaces. That is the whole
point of accounts: a monitor gets `read`, a deploy hook gets `read,lifecycle`, and neither holds a
credential that can change config.

**Two refusals keep the panel reachable**: `revoke` refuses the last account that can sign in, and
the API refuses revoking the account you are signed in as. `reset` is what to run when you cannot
sign in at all — it writes a fresh generated secret and prints it, on the machine that runs the
panel.

**Managing credentials needs a signed-in session**, never a bearer credential: an account that could
mint another could escalate past its own scopes. The same rule covers switching authentication off,
installing a custom UI, and restoring an archive that carries the panel's own credentials
(`403 SESSION_REQUIRED`). Scopes are **not** a boundary against someone holding a credential — an
entry runs any command as the panel's user — so revoke one that may have leaked.

## Declaring servers

```bash
home-hosted add web --port 4000 -- node server.js            # everything after -- is the command
home-hosted add api --cwd ./api --autostart -- pnpm start    # --cwd relative to --project
home-hosted add db -w media --persistent -- ./start-db.sh
home-hosted ls                                               # ID STATUS PORT COMMAND
home-hosted ls -w media --json
```

With the panel up, `add` and `ls` go through it (`POST`/`GET /_hh/servers`), so the entry appears at
once with the same validation as **➕ Add server**. With it down they read and write the workspace's
`servers.config.json` directly, through the same store and checks, atomically; `ls` then shows no
status. An added entry is **not started**, `autostart` or not — `autostart` means "comes up with the
panel", so it starts at the next `up`; run `start <id>` to start it now. An id the workspace already
has is refused (`SERVER_EXISTS`), and `add` never creates a workspace.

## Secret environment

A server's secrets live in the workspace's secrets file, never in `servers.config.json` — only the
**names** are declared there, in the entry's `secretEnv`. Declare a name first, then set its value:

```bash
home-hosted secret set app DATABASE_URL          # prompts without echo
printf '%s\n' "$DATABASE_URL" | home-hosted secret set app DATABASE_URL --stdin
home-hosted secret ls app                        # the names, and which have a value
home-hosted secret unset app DATABASE_URL
```

**The same commands take a job id**, because a job declares `secretEnv` exactly as a server does
([JOBS.md](./JOBS.md#a-jobs-secret-environment)):

```bash
home-hosted secret set nightly-backup BACKUP_TOKEN --stdin
home-hosted secret ls nightly-backup
```

An id resolves to a **server** first and a **job** second, and the two are different key spaces in
the secrets file (`serverEnv` beside `jobEnv`) — so a server and a job that share an id each keep
their own values, and `--json` names which one answered (`server` or `job`).

`set` refuses a name the entry does not declare **before** it asks for a value, so a mistyped name
costs nothing. A blank value is refused too: an empty environment variable reads as unset, so
`unset` is the intent there.

**No command prints a value** — not `ls`, not `--json`, not an error. The panel's
`PUT /api/servers/:id/secrets` is write-only for the same reason, and the view reports
`secretEnvSet` (the names that have a value) rather than anything else.

While the panel runs, the commands go through its `/_hh` channel so its own store does the write;
when it is down they write the file directly, and the next start reads it.

## Deploying

`deploy` runs an entry's `deploy` steps — see [SERVERS.md](./SERVERS.md#deploying) for what the block
is, and the three rules it follows.

```bash
home-hosted deploy web              # every step, then a restart; exits 1 if one fails
home-hosted deploy web --json       # { server, ok, failedStep?, error?, durationMs }
```

It **waits** and exits non-zero on failure: a command that answered "accepted" would leave the caller
believing a deploy worked. Through the panel it goes over `/_hh`, so its supervisor owns the sequence
and the history record; with the panel down it runs the same steps and says nothing was restarted.

## Jobs

`job` is the terminal's way into a workspace's scheduled commands — its own domain, beside `ls` for
servers. See [JOBS.md](./JOBS.md) for what a job is and how its schedule behaves.

```bash
home-hosted job ls                                  # id, expression, and whether it is scheduled, running or disabled
home-hosted job ls --json                           # { jobs: [{ id, schedule, nextRunAt, lastRunAt, lastExitCode, running }] }
home-hosted job run nightly-backup                  # waits; exits 0 when the exit code is 0
home-hosted job run nightly-backup --json           # { job, ok, exitCode, signal, durationMs, cancelled }
home-hosted job log nightly-backup                  # what its runs wrote, newest last
home-hosted job log nightly-backup --json           # { job, lines: [{ ts, stream, text }] }
```

`job run` **waits** and exits non-zero on a failed run: a job's exit code *is* its outcome, and a
command that answered "accepted" would leave a script believing a backup ran that did not. The run's
own output goes to the panel's log, so this prints the outcome rather than streaming it.

A refusal carries its own code: `JOB_RUNNING` (a run is already in flight — the same rule the schedule
follows) and `UNKNOWN_JOB`. There is no offline path: without a panel there is no scheduler, no log
and no history to record a run against, so it refuses rather than answering with a second,
unsupervised implementation.

`ls` lists **services** and only services, always in four columns. The `NEXT RUN` column it used to
grow is gone with the job entries that filled it — `home-hosted job ls` answers that question now.

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

## Coming from pm2 or compose

`import` carries an existing setup in. It **prints a plan and writes nothing** until you pass
`--confirm`, and a run with no terminal and no `--confirm` exits 1 — so a CI step cannot create
servers nobody asked for.

```bash
home-hosted import pm2 ecosystem.config.json            # the plan
home-hosted import pm2 ecosystem.config.json --confirm  # and write it
home-hosted import compose docker-compose.yml --id stack --confirm
```

**pm2** — each `apps[]` element becomes one entry:

| pm2 | becomes |
| --- | --- |
| `name` | `id` (slugified; two names that slugify onto one id are **refused**, not merged) |
| `script`, `interpreter` | `command` (the interpreter, default `node`) and `args[0]` (the script) |
| `args` | the rest of `args`, split on whitespace — a quoted argument is **reported**, not guessed |
| `cwd`, `env` | `cwd`, `env` (a numeric value becomes a string) |
| `autorestart`, `max_restarts` | `restart.enabled`, `restart.maxRetries` |
| `max_memory_restart` | `resources.maxRssBytes` (`200M`, `1G`, a bare number of bytes) |
| `watch`, `cron_restart`, `instances`/`exec_mode: cluster` | **not carried** — each is reported by name |

A `.js` ecosystem is code, so reading it means running it: pass `--allow-js` or export JSON. A
`.mjs`/`.cjs` works the same way.

**compose** — one entry per stack, because the containers *are* the server: `docker compose -f <file>
up`. YAML and a JSON export both work; only the presence of a `services` key is read, since docker
parses the file itself.

Nothing is started: `home-hosted start <id>` when you are ready.

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
