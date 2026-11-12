<div align="center">

<img src="docs/branding/logo.svg" alt="home-hosted" width="128" height="128">

# home-hosted

**The control panel for everything you self-host at home.**

<sub>The harness for your servers.</sub>

Point it at the things you run — a gateway, a media server, a bot, a database — and it starts them,
watches them, restarts what dies, and shows you one page of what is going on. Split them into
[workspaces](#-workspaces) when one panel holds more than one setup (a workspace is just a named
group that owns its own servers, secrets and logs), and
[bring your own UI](#-bring-your-own-ui-byou) (BYOU: a static site the panel serves instead of the
stock one) when you want one that fits you exactly.

[![npm](https://img.shields.io/npm/v/home-hosted.svg)](https://www.npmjs.com/package/home-hosted)
[![Downloads](https://img.shields.io/npm/dm/home-hosted.svg)](https://www.npmjs.com/package/home-hosted)
[![CI](https://github.com/NamesMT/home-hosted/actions/workflows/quickcheck.yml/badge.svg)](https://github.com/NamesMT/home-hosted/actions/workflows/quickcheck.yml)
[![License](https://img.shields.io/npm/l/home-hosted.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/home-hosted.svg)](https://nodejs.org)

[🚀 Quick start](#-quick-start) · [🗂 Workspaces](#-workspaces) · [🧩 Servers](./docs/SERVERS.md) · [🤖 Agents & API](#-agents-scripts-and-your-own-tools) · [✨ Features](#-features) · [🛠 CLI](#-cli) · [🔔 Notifications](./docs/NOTIFICATIONS.md) · [🌐 Dynamic DNS](./docs/DDNS.md) · [💾 Backups](#-backups) · [🔀 Reverse proxy](./docs/REVERSE_PROXY.md) · [🔐 Security](#-security) · [🎨 BYOU](#-bring-your-own-ui-byou) · [❓ FAQ](#-faq)

</div>

---

<div align="center">

![Eight views of the panel: the stock UI and its reverse proxy, the NOC console, and UI examples](docs/media/tour.gif)

<sub>The stock panel, the [NOC console](./uis/noc-console) that ships alongside it, and UI directions
you could build yourself — <a href="#-bring-your-own-ui-byou">BYOU</a>.</sub>

</div>

---

## 🤔 Why?

You run a handful of services at home. The usual choices are extremes — 🧟 `tmux` sessions you
forget about, 📜 a hand-written systemd unit per service, or 🐳 a whole container orchestrator — plus
😩 the monitoring, the reboots and the day you move to a new machine.

🙂✨ home-hosted sits in between: declare a server once, and it is started, watched, restarted,
alerted on, backed up and shown on one page — whether it is a plain command or a `docker compose`
stack.

```text
                   ┌──────────────────────────────────────┐
   your browser ──▶│  home-hosted  ·  127.0.0.1:3999      │◀── scripts, agents, your own UI
                   │  UI + JSON API + live events (SSE)   │    (Bearer token, OpenAPI)
                   └───────────────┬──────────────────────┘
                                   │  supervises
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
   ┌─────────┐               ┌─────────┐                ┌─────────┐
   │ gateway │               │ files   │                │ bot     │
   │ :4000   │               │ :4010   │                │  ...    │
   └────┬────┘               └─────────┘                └─────────┘
        │ compose up                        restarts ↻ · health ✓ · logs · alerts
        ▼
   ┌────────────┬────────────┬────────────┐
   │  gateway   │  postgres  │   redis    │     + backups · DDNS · reverse proxy (HTTPS)
   └────────────┴────────────┴────────────┘
```

|  |  |
| --- | --- |
| ❌ **"Is it still running?"** | Health, CPU/memory, uptime and live logs per server |
| ❌ **Silent deaths** | Restarted automatically, and you are told — in the panel, Telegram or a webhook |
| ❌ **Fragile reboots** | `autostart` brings the stack back; one `down` stops it all cleanly |
| ❌ **"Move it to the new box"** | One archive — config **and** data — restored on a blank host |
| ✅ **home-hosted** | Declare it once, watch it forever |

It ships with **no servers configured**: a server is a command, its arguments and its environment.

```json
{ "id": "gateway", "command": "node", "args": ["server.js"], "port": 4000, "autostart": true }
```

---

## ⚡ Quick start

```bash
npx home-hosted            # start it — detached, it keeps running — and print the first-run password
npx home-hosted status     # where it is, what is running, the first-run password until you change it
npx home-hosted down       # stop the panel *and* everything it started
```

Open **<http://127.0.0.1:3999>**, sign in with the printed password, and change it under **Global
settings → Authentication**. Then supervise something: **➕ Add server** in the panel, or add an entry
to `~/.home-hosted/.hh/default/servers.config.json` and run `npx home-hosted start <id>`.
<sub>Needs Node 24+. `pnpm dlx home-hosted …` works too. `--port`/`--host` on `up` are saved to
`settings.json`, so the next plain `up` binds the same way.</sub>

> [!IMPORTANT]
> **Before you expose it to anything but this machine.** It listens on `127.0.0.1` until you say
> otherwise, and it refuses to bind further — or to be put behind its own reverse proxy — while it
> still has the generated password. So: set your own password first, *then* bind to `lan` (UI,
> `settings.json`, or `up --host lan`). And an API token is **full admin**: it can create and start a
> server entry, and an entry runs any command as the panel's user. Changing the password does **not**
> revoke a token — rotate it with `set-token --generate`. The whole model, including which actions a
> token is refused: [SECURITY.md](./docs/SECURITY.md).

<details>
<summary><b>📦 Install it instead of npx-ing it</b></summary>

```bash
npm install -g home-hosted      # or: pnpm add -g home-hosted
hh up                           # `hh` is the short name for `home-hosted`
```

Everything it owns lives under `$HHOSTED_HOME/.hh` (default `~/.home-hosted/.hh`). Delete that and
nothing of it is left behind.

</details>

<details>
<summary><b>📁 Keep a whole setup in a git repository</b></summary>

```bash
npx home-hosted init            # every step has a default; --yes takes them all
```

The project's scripts all pass `--home ./state`, and its `.gitignore` commits the server
definitions while keeping secrets, logs, TLS keys and archives local:

```jsonc
// package.json
{ "scripts": { "up": "home-hosted up --home ./state", "down": "home-hosted down --home ./state", "status": "home-hosted status --home ./state" } }
```

Clone, `pnpm install`, `pnpm run up` — the same setup on any machine with Node. Give each project its
own panel port (`control.port`, e.g. `4399`) so two can run side by side. Call it `pnpm run up`:
`pnpm up` is pnpm's own update command. Worked example:
**[hhosted-ai-pack](https://github.com/NamesMT/hhosted-ai-pack)**.

</details>

<details>
<summary><b>🧰 Start it at boot: systemd or Docker</b></summary>

```ini
[Unit]
Description=home-hosted
After=network-online.target

[Service]
User=youruser
WorkingDirectory=/srv/home-hosted
Environment=HHOSTED_HOME=/srv/home-hosted
ExecStart=/usr/local/bin/home-hosted up --foreground
Restart=always

[Install]
WantedBy=multi-user.target
```

> [!CAUTION]
> **Set `WorkingDirectory`.** Relative paths in your servers (`cwd`, `{projectDir}`, `dataEnvs`)
> resolve against the directory the panel starts in, and systemd starts in `/`. Docker does the same
> without `-w`. Or pin it with `HHOSTED_PROJECT`.

</details>

---

## 🤖 Agents, scripts and your own tools

Everything the panel does goes through one HTTP API — the stock UI is just one client of it. Get a
token, then plain HTTP:

```bash
home-hosted set-token --generate        # hh_9uA2… — printed once, only its hash is kept
                                        #   (or Global settings → Authentication → Generate token)

curl -H "Authorization: Bearer hh_…" http://127.0.0.1:3999/api/state
curl -H "Authorization: Bearer hh_…" -X POST 'http://127.0.0.1:3999/api/servers/gateway/restart?workspace=default'
curl -N -H "Authorization: Bearer hh_…" http://127.0.0.1:3999/api/events            # live SSE
home-hosted status --json                                                            # where everything is
```

Building in TypeScript? `import { createClient } from 'home-hosted/client'` — a ~2 KB gzipped client
(5.2 KB raw) typed from the panel's own routes, with the live event stream
([API.md](./docs/API.md#the-typescript-client)).
Any other language: `GET /openapi/spec.json` documents every API route and its bodies (browse at
`/openapi/ui`), so an OpenAPI generator gives you a typed client. `GET /healthz` needs no credential
and is `503` while any server needs attention — point your uptime monitor at it.

> [!WARNING]
> **A token is full admin.** It can create and start server entries, which run commands as the
> panel's user. Keep it like a password; rotate with `set-token --generate`.

<details>
<summary><b>🌐 The endpoints worth knowing</b></summary>

✅ takes `?workspace=<id>` (omitted = the default workspace); ❌ is panel-wide.

| | | |
| --- | --- | --- |
| `GET /api/state` | the full snapshot: settings, every workspace and server, host vitals | ❌ |
| `GET /api/events` | SSE: `hello` (full state), then `state`, `server`, `log`, `ping` | optional |
| `GET`/`PUT`/`PATCH`/`DELETE /api/servers/:id` | entries — `PUT` is create-or-replace, so a re-run converges | ✅ |
| `POST /api/servers/:id/{start,stop,restart,free-port}` | lifecycle | ✅ |

Every error is one envelope — `{ "message", "code", "detail"? }` — with a stable `code` to branch on.
Every endpoint, SSE frames, metrics and compatibility rules: **[API.md](./docs/API.md)**.

</details>

<details>
<summary><b>🧑‍💻 Pointing an AI agent at it</b></summary>

Give it four things and it can run your home server without guessing:

1. the token (`home-hosted set-token --generate`),
2. `http://127.0.0.1:3999/openapi/spec.json` — the API it may call,
3. `home-hosted status --json` — where things are,
4. [SERVERS.md](./docs/SERVERS.md) — how a server is declared.

</details>

---

## ✨ Features

### What a plain supervisor does not do

| | |
| --- | --- |
| ♾️ **`persistent: true` survives the panel** | The entry runs under its own tiny supervisor (a **nanny** — this same CLI in a hidden mode) that owns its pipes and log file, so `down`, an upgrade or a crash leaves it serving; the next panel re-attaches |
| 🔗 **`dependsOn` waits for *healthy*** | A dependent is held until the health probe of what it needs has passed — not until that process merely exists — so a web app never binds before its database accepts connections |
| 🔄 **`onPortConflict: follow` adopts a self-restarting program** | A plugin that re-execs, or an updater that hands over to a new detached process, is recognised as *this entry's own successor* and taken over — pid, health, resources, stop — instead of blocking on its own port |
| 👻 **The orphan list** | A process this panel started that no entry owns any more — a renamed or removed entry left it behind — is listed under **Servers** by id, pid and start time, with a **Stop it** button. Nothing is killed on a guess |

The rest, one line each:

<details>
<summary><b>📋 The full feature list</b></summary>

| | |
| --- | --- |
| 🗂 **Workspaces** | One panel, many setups. Each owns its servers, secrets, logs and settings; listener, auth, backups, TLS and UI stay panel-wide |
| 🚦 **Lifecycle** | Start, stop, restart from the panel, the CLI or the API; `autostart` entries come up with it |
| 📝 **Hand edits welcome** | Edit `servers.config.json` or the panel's `settings.json` in an editor or `git checkout` — picked up in seconds. A file it cannot read is reported in the UI, and what is running is left alone |
| ♻️ **Auto-restart** | Exponential backoff on crash, with a retry budget that survives a panel restart |
| 🩺 **Health that acts** | TCP or HTTP probes: a card warns after `unhealthyThreshold` failed probes (default 3). Forcing a restart after a set time is **opt-in** — `forceRestartAfterMs` defaults to `0`, which never fires. Ports are checked before starting, and a program that restarts itself can be [followed](./docs/SERVERS.md#when-a-program-restarts-itself) |
| 📜 **Logs** | Live stream, rotated files, search, download, clear |
| 📈 **Resources** | CPU and memory per process tree (summed containers for compose), with an optional memory ceiling |
| 🌡️ **Host vitals** | CPU, memory, swap, disk, temperature and load, with thresholds that alert once per new breach and again on recovery |
| 🔔 **Notifications** | Telegram and webhooks (ntfy, Discord, Slack, …) on crash, unhealthy, recovery, host thresholds and DNS changes |
| 🌐 **Dynamic DNS** | Keep hostnames on your public IP — Cloudflare, Namecheap, Porkbun, GoDaddy, Gandi, deSEC, DuckDNS, No-IP and more |
| 🔀 **Reverse proxy** | One Caddy engine with automatic HTTPS: `git.example.com` → a Gitea entry, `panel.example.com` → the panel |
| 💾 **Backups** | Config, secrets and data in one zip — plain or AES-256, scheduled or manual, restorable on a blank host |
| 🤖 **API first** | Bearer tokens, OpenAPI, SSE — scripts, agents, TUIs and desktop apps get everything the UI gets |
| 🎨 **Bring your own UI** | Upload a static build; `ui-update` follows its releases, `ui-revert` goes back |
| 🌍 **Translated** | English, Vietnamese, Chinese, Japanese, Spanish, Korean, Russian, French, German |
| 🖥 **Cross-platform** | Linux, macOS and Windows — no shell utilities assumed |

</details>

---

## 🗂 Workspaces

A workspace is the ownership boundary: its own servers, secrets, logs and settings. The first boot
creates `default`. A server id is unique only inside its workspace. A workspace id is its directory
name: lowercase letters, digits, `-` and `_`, at most 40 characters, and never a Windows device name
(`con`, `nul`, `com1`, …).

| page | url | scope |
| --- | --- | --- |
| **Overview** · **Servers** · **Logs** · **Settings** | `/w/<workspace>` · `…/servers` · `…/logs` · `…/settings` | one workspace |
| **One server** | `/w/<workspace>/servers/<id>` | config, live logs, resources |
| **Global overview** · **Global settings** | `/global/overview` · `/global/settings` | every workspace; listener, auth, backups, TLS, UI |
| **Reverse proxy** | `/proxy` | panel-wide |

<details>
<summary><b>🗂 What lives where</b></summary>

| | |
| --- | --- |
| panel-wide — `$HHOSTED_HOME/.hh/` | `settings.json` (listener, auth, TLS, host vitals, backups, proxy), `workspaces.json`, `.control-secrets.json` (password + token hashes, 0600), `.tls/`, `.ui/`, `.backups/`, `.logs/`, `.proxy/` (the engine and its state), `run.json` (the live panel, 0600) |
| per workspace — `.hh/<id>/` | `settings.json` (server defaults, logs, notifications, DDNS), `servers.config.json`, `.secrets.json` (0600), `.logs/<id>.log`, `.state/` |

</details>

---

## 🧩 Servers

Add one with **➕ Add server** — presets for Node, Python, Jellyfin, Minecraft, Gitea, MongoDB, Docker
Compose and more fill the form — or write it into the workspace's `servers.config.json`:

```json
{
  "id": "blog",
  "command": "node",
  "args": ["server.js", "--port", "{port}"],
  "cwd": "./apps/blog",
  "port": 8080,
  "bind": "lan",
  "autostart": true,
  "dataEnvs": { "DATA_DIR": "{projectDir}/data/blog" }
}
```

- `command` is a **program, not a shell line** — `"node server.js"` looks for a program of that name.
- `port` turns on the readiness wait, health checks and port-conflict detection.
- `bind` is `local` (`127.0.0.1`), `lan` (`0.0.0.0`) or one of this machine's IPv4 addresses; the
  program reads it as `{host}`.
- `dataEnvs` sets an environment variable *and* marks that directory for backups.

**Every field, placeholder and port-conflict policy, plus Docker Compose and persistent entries:
[SERVERS.md](./docs/SERVERS.md).**

---

## 🛠 CLI

| command | |
| --- | --- |
| `home-hosted up` | start the panel detached. With one already running: says where and exits `0` — **if the flags agree**. `--port`/`--host` naming something else is refused (exit `1`, "`--port X` was not honoured"), because a re-run must not report success for a move it did not make |
| `home-hosted down` | stop it and everything it started — persistent entries stay unless `--with-persistent` |
| `home-hosted restart [<id>]` | the panel (`down` then `up`), or just one server, leaving the panel up |
| `home-hosted status` | running? where? how many servers up? every path (`--json`) |
| `home-hosted start <id>` / `stop <id>` | one server — `start` brings up what it `dependsOn` first; `stop` stops only that one (`-w <workspace>`, `--free-port`) |
| `home-hosted free-port <id>` | ask whatever holds that server's port to stop; supervised holders are refused |
| `home-hosted logs [<id>]` | the panel's console, or one server's log (`--lines`, `--follow`, `--json`) |
| `home-hosted usage` | CPU and memory per server, loudest first, plus starts and crashes over the history window |
| `home-hosted backup` | `list`, `create`, `restore` — works with the panel stopped |
| `home-hosted set-password` / `set-token` | credentials, without a browser |
| `home-hosted migrate` | bring configs up to this release's schema (`--dry-run`) |
| `home-hosted init` | scaffold a self-contained project |
| `home-hosted ui-switch` / `ui-update` / `ui-revert` | install, update or remove a custom UI |
| `home-hosted setup-temp --wsl` | read the CPU temperature through the Windows host on WSL2 |

<details>
<summary><b>⚙️ Every command and its flags</b></summary>

```text
up                -p/--port <port> --host <local|lan|ipv4> --open --no-autostart --foreground --print-config
                  (--port and --host are saved to settings.json)
down              --with-persistent
restart           (no id) down, then up: up's flags plus --with-persistent
restart <id>      one server through the panel: [-w/--workspace <id>] — up's flags are refused here
status            --json
start <id>        [-w/--workspace <id>] [--free-port]
stop <id>         [-w/--workspace <id>]
free-port <id>    [-w/--workspace <id>]
logs [<id>]       --lines <n≥1|all> --follow --json [-w/--workspace <id>]
usage             --json
backup list       --json
backup create     (--include <ids> | --all) [--exclude <ids>] --password <text> --confirm --json
backup restore    (<name> | --from <path>) (--include <ids> | --all) [--exclude <ids>] --password <text> --confirm --json
init              --dir <dir> --name <name> --pm <pnpm|npm|yarn|bun> --no-install -y/--yes
set-password      --clear                      (HHOSTED_PASSWORD for a script; --clear locks every sign-in out)
set-token         --generate --clear           (HHOSTED_TOKEN for a script)
migrate           --dry-run -y/--yes           (HHOSTED_MIGRATE=allow for a script)
ui-switch         --repo <owner/name> --tag <tag> --asset <name> --file <path|url> [--insecure] --list --token <token> -y/--yes
ui-update         --check --tag <tag> --asset <name> --old --repo <owner/name> --token <token> -y/--yes
ui-revert         (no flags)
setup-temp        --wsl [--download | --no-download] | --clear

every command     --home <dir> --project <dir> -h/--help -v/--version   (or $HHOSTED_HOME, $HHOSTED_PROJECT)
help <command>    the same as <command> --help
environment       HHOSTED_PASSWORD, HHOSTED_TOKEN, HHOSTED_MIGRATE=allow, HHOSTED_DDNS_SECRET,
                  GITHUB_TOKEN / GH_TOKEN (ui-switch, ui-update)
```

- `--json` prints one document on stdout or nothing; refusals go to stderr. Branch on the exit code.
  The exception is a stream: `logs --follow --json` prints one `{ path, line }` object per line.
- A flag a command cannot honour is refused, and `backup create`/`restore` without a terminal need
  `--confirm` (without it they show the plan and exit 1). Depth: [CLI.md](./docs/CLI.md).
- Piping into `head`/`grep -q` exits 0, so `set -o pipefail` is safe.
- `start web && curl …` works: `start` waits to confirm the process stayed up.
- A misspelled command or flag suggests the one you meant.

</details>

<details>
<summary><b>🧭 Upgrading, and why the panel sometimes refuses to start</b></summary>

```bash
home-hosted migrate --dry-run   # what would change
home-hosted migrate             # asks once before any schema step, keeps a .bak beside each file
```

A newer release always reads an older config, and unknown keys are kept and reported, never reset.
What it will not do is run a config it cannot read — a wrong value, a duplicate id, a newer schema —
so `up` stops with the exact problem instead of starting on defaults. Release notes say what each
upgrade needs from you. **Coming from 0.6.x:** run the latest 0.7.x once first.

</details>

<details>
<summary><b>🤔 What <code>status --json</code> tells you</b></summary>

`running` and `liveness` are always present. `liveness` is `live` (it is this panel), `unknown`
(alive, start time unavailable — counted as running), `gone`, or `recycled` (the pid now belongs to
another process — nothing is signalled). Then `answering: false` means the process exists but does not
respond, and `exitedCleanly` says whether someone ran `down` or it died. There is more in that
document (paths, ports, the missing-record cases) — [CLI.md](./docs/CLI.md#what-status-tells-you).

</details>

---

## 🔐 Security

**Safe out of the box.** The panel listens on `127.0.0.1` only, behind a password generated on first
start. It refuses to listen anywhere else — or to be served through its own reverse proxy — until you
set your own password of at least 12 characters.

<details>
<summary><b>🛡️ The three things you actually have to do</b></summary>

1. **Set your own password (12+ characters) before exposing it**, then bind to `lan` (UI, config, or `up --host lan`).
2. **Treat an API token as the account it runs as** — changing the password does *not* revoke it.
3. **Forgot the password?** Run `home-hosted set-password` on the machine to set a new one; no login needed.

</details>

<details>
<summary><b>🔍 How a request is trusted</b></summary>

| Check | Rule |
| --- | --- |
| **Host** | an IP, `localhost`, a local name (`.local`, `.lan`, `homeserver`, …), a panel proxy route, or listed in `control.allowedHosts` — otherwise `421`. This blocks DNS-rebinding attacks from web pages you visit |
| **Origin** | a cookie-authenticated write must be same-origin; bearer-token requests are exempt (browsers never attach one by themselves) |
| **"This machine"** | a loopback peer that also carries **none** of `Forwarded`, `X-Forwarded-For`, `X-Real-IP` or the `X-Forwarded-Proto`/`-Host`/`-Port`/`-Prefix` family. That is right for the panel's own reverse proxy and for any proxy that adds at least one of them — but it is a **heuristic, not a guarantee**: a proxy that strips them all is indistinguishable from a local client. Set `trustProxy` deliberately and never put the panel behind a header-stripping proxy |
| **Lockout** | repeated failures lock out per client address; `trustProxy: "loopback"` (default) reads the real address from a proxy on this machine |

Secrets never go in a config file: every secret file is `0600`, and `.hh` is `0700` from the moment
any command creates it. DDNS
credentials are also sealed under `HHOSTED_DDNS_SECRET` — set your own if you commit or share `.hh/`.
Details: [SECURITY.md](./docs/SECURITY.md).

</details>

---

## 🔔 Notifications

A message when something happens while you are not looking: a server that gave up restarting, a
failing health check, a forced restart, a recovery, a host threshold, a DNS change. Alerts go to
**destinations** — Telegram chats and webhooks — with event toggles and a throttle set once and
inherited or overridden per destination. **Two minutes of setup: [NOTIFICATIONS.md](./docs/NOTIFICATIONS.md).**

## 🌐 Dynamic DNS

**Workspace settings → Dynamic DNS** keeps hostnames pointed at this machine's public IP: add an
account, paste credentials, add hostnames. A provider is called only when the address changed, and a
permanent refusal (bad credentials) stops retrying until you fix it. **[DDNS.md](./docs/DDNS.md).**

## 🔀 Reverse proxy

One Caddy engine in front of everything, installed and supervised by the panel, with automatic HTTPS
(or your own certificates): route a hostname to any server, to an external address, or to the panel.
**[REVERSE_PROXY.md](./docs/REVERSE_PROXY.md).**

---

## 💾 Backups

**Global settings → Backups** takes one `.zip` of the panel and the workspaces you pick — settings,
servers, secrets, declared data — plain or AES-256, and puts it back.

```bash
home-hosted backup create --all --confirm
home-hosted backup create --all --exclude global:secrets --confirm
home-hosted backup restore <name> --all --confirm
home-hosted backup restore --from /media/usb/x.zip --all --confirm
```

Both work with the panel **stopped**, which is when you usually need them.

<details>
<summary><b>🚚 One archive is a whole setup</b></summary>

Start a **blank** home-hosted anywhere, upload the archive, restore: workspaces come back, data lands
where *this* machine's config says (`{projectDir}`, `{home}` follow the new host), and `autostart`
entries come up. A restore never writes where no config declares. Older archives are migrated on the
way in; archives from a newer release are refused.

</details>

<details>
<summary><b>⏱️ Schedules, and what not to restore</b></summary>

- A schedule writes an `auto-…` archive every N hours with its own retention, and never prunes the
  ones you took by hand.
- Pick per item: whole workspaces, or one secret, one data directory.
- **The password and token hashes are secrets too** — restoring them reinstates the old machine's
  credentials. Leave `global:secrets` unticked, or rotate afterwards.
- **A live database copied file by file can be torn.** Stop it around the backup, or declare
  `dump`/`load` hooks so the engine writes the backup itself.

That is the whole of what you have to decide before ticking a box. What an id selects, how retention
counts, which paths follow a new host: [BACKUPS.md](./docs/BACKUPS.md).

</details>

---

## 🎨 Bring your own UI (BYOU)

The panel serves whatever static site is in `$HHOSTED_HOME/.hh/.ui`. **Global settings → Interface**
takes a zip, `home-hosted ui-switch --asset noc-console` installs the NOC console from a release, and
`home-hosted ui-revert` brings back the stock UI if yours breaks.

<details>
<summary><b>🤖 Have an agent build the UI you actually want</b></summary>

> Help me build a UI for `home-hosted`: a nostalgic game theme — servers as a party menu, health as HP
> bars, logs in a text box. Follow `docs/UI_CREATION.md` and `docs/API.md`.

[UI_CREATION.md](./docs/UI_CREATION.md) is the contract: install, `ui.json`, the rules of the road and
a checklist.

</details>

---

## ❓ FAQ

<details>
<summary><b>Something is wrong — where do I look?</b></summary>

```bash
home-hosted status            # the overview
home-hosted logs --follow     # the panel's own console — works even when the panel is wedged
home-hosted logs web          # one server's log (-w <workspace> for another workspace)
home-hosted usage             # what is eating the machine
```

</details>

<details>
<summary><b>What happens to my servers when the panel stops?</b></summary>

`down`, `SIGTERM` and `SIGINT` stop every server the panel started. `persistent` entries keep running
under their **nanny** (the small supervisor described [above](#-features)) and are re-attached by the
next panel; `down --with-persistent` stops them too.

Being **killed** is the other case: a panel that dies hard cannot stop anything, so its servers keep
running and the next panel adopts them — [SERVERS.md](./docs/SERVERS.md#orphaned-processes).

</details>

<details>
<summary><b>Is it a systemd replacement?</b></summary>

No — keep systemd for the panel itself and for system services; use home-hosted for what you run
yourself.

</details>

<details>
<summary><b>Which ports does it use?</b></summary>

The panel: `3999` (`--port` or `control.port`). Your servers: the ports you give them. The reverse
proxy, only when enabled: `80`/`443`, or `4480`/`4443` unprivileged with your router forwarding.

</details>

<details>
<summary><b>I reach the panel through Cloudflare Tunnel / nginx on a public name and get <code>421</code></b></summary>

Add that name to `control.allowedHosts` in `.hh/settings.json` (or **Global settings → Listener**,
reached by IP). IPs and local names never need it.

</details>

<details>
<summary><b>Where is my state?</b></summary>

`~/.home-hosted/.hh` (or `$HHOSTED_HOME/.hh`) — see [What lives where](#-workspaces). `home-hosted status`
prints every path.

</details>

<details>
<summary><b>Windows support, really?</b></summary>

Yes: process trees from Win32_Process, `taskkill` for stopping, `.cmd` shims resolved in
`node_modules/.bin`, and configs saved by Notepad or PowerShell (BOM, UTF-16) read as-is.

</details>

---

## 🗂 Working on it

```bash
pnpm install
pnpm dev            # panel :6000 + stock UI dev server :6001, state in .dev-state/ (password: dev)
pnpm run check:fast # while working: lint/types (cached) + only the tests your changes reach
pnpm run check      # before pushing: lint, types, doc links and the full suite with coverage
```

```text
src/          the panel. Top level: app.ts (Hono root), cli.ts, index.ts (all wiring),
              client.ts (the published client), openapi.ts + openapi-reference.ts.
              Then one directory per layer:
              cli/ (one module per command)      api/ (one route factory per URL group)
              services/ (stateful)               providers/ (OS/vendor leaves, plain data)
              config/ (stores, parsing, migrations)   middleware/ (host, auth, loopback)
              helpers/ (cross-layer utilities)   shared/ (schemas + code the UIs import too;
                                                 no Vue, no node:)
uis/          stock (ships in the package) and noc-console — Vite + Vue, static output.
              Shared by both: vite.shared.ts (config, aliases, dev proxy) and tap-targets.css
test/         vitest; one directory per src/ layer, plus support/ (harnesses), fixtures/
              and scripts/ (tests that drive a script in scripts/)
docs/         user docs, mockups/, media/, branding/, demo/
scripts/      build, release and check helpers — quickcheck.mjs is the gate
.agentDocs/   internals docs for agents; not published
bin/          the published `home-hosted` / `hh` entry point
```

| if you want to… | read |
| --- | --- |
| declare a server: every field, placeholders, port conflicts | [SERVERS.md](./docs/SERVERS.md) |
| drive it from code: endpoints, SSE, errors, metrics | [API.md](./docs/API.md) |
| every CLI command and what `status` means | [CLI.md](./docs/CLI.md) |
| backups and restores in depth | [BACKUPS.md](./docs/BACKUPS.md) |
| hostnames and HTTPS | [REVERSE_PROXY.md](./docs/REVERSE_PROXY.md) · [DDNS.md](./docs/DDNS.md) |
| alerts | [NOTIFICATIONS.md](./docs/NOTIFICATIONS.md) |
| the security model | [SECURITY.md](./docs/SECURITY.md) |
| build a UI | [UI_CREATION.md](./docs/UI_CREATION.md) |
| change the internals | [AGENTS.md](https://github.com/NamesMT/home-hosted/blob/main/AGENTS.md) |

**Built on home-hosted:** [dsh-home-hosted](https://github.com/NamesMT/dsh-home-hosted) — server
management with boot autostart inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
<sub>PRs to add yours are welcome.</sub>

<div align="center">

**MIT**

</div>
