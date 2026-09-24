<div align="center">

# 🏠 home-hosted

**The control panel for everything you self-host at home.**

<sub>The harness for your servers.</sub>

Point it at the things you run — a gateway, a media server, a bot, a database — and it starts
them, watches them, restarts what dies, and shows you one page of what is going on. Or
[BYOU](#-bring-your-own-ui-byou), for a specialized UI that fits you exactly.

[![npm](https://img.shields.io/npm/v/home-hosted.svg)](https://www.npmjs.com/package/home-hosted)
[![Downloads](https://img.shields.io/npm/dm/home-hosted.svg)](https://www.npmjs.com/package/home-hosted)
[![CI](https://github.com/NamesMT/home-hosted/actions/workflows/quickcheck.yml/badge.svg)](https://github.com/NamesMT/home-hosted/actions/workflows/quickcheck.yml)
[![License](https://img.shields.io/npm/l/home-hosted.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/home-hosted.svg)](https://nodejs.org)

[🚀 Quick start](#-quick-start) · [✨ Features](#-features) · [🧩 Adding a server](#-adding-a-server) · [🛠 CLI](#-cli) · [🔐 Security](#-security) · [💾 Backups](#-backups) · [🎨 BYOU](#-bring-your-own-ui-byou)

</div>

---

<div align="center">

![Six views of the panel: the stock UI, the NOC-console, and UI examples](docs/media/tour.gif)

<sub>The stock panel, the [NOC-console](./uis/noc-console) that ships alongside it (for TUI and
shortcuts wizards), and UI directions you could build yourself —
<a href="#-bring-your-own-ui-byou">BYOU</a>.</sub>

</div>

---

## 🤔 Why?

Running services on a home machine usually means one of two extremes: `tmux` sessions you
forget about, or a hand-written systemd unit per service (times six).

|  |  |
| --- | --- |
| ❌ **"Is it still running?"** | You check with `ps`, then `curl`, then hope. |
| ❌ **Silent deaths** | Something crashes at 3am and you notice days later. |
| ❌ **One terminal per service** | Logs scroll away in tabs you closed. |
| ❌ **Fragile restarts** | The box reboots and half the stack is gone. |
| ✅ **home-hosted** | Declare it once, watch it forever, one command to stop it all. |

```text
                   ┌──────────────────────────────────────┐
   your browser ──▶│  home-hosted  ·  127.0.0.1:3999      │
                   │  your UI + JSON API + SSE logs       │
                   └───────────────┬──────────────────────┘
                                   │  supervises
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
   ┌─────────┐               ┌─────────┐                ┌─────────┐
   │ gateway │               │ files   │                │ bot     │
   │ :4000   │               │ :4010   │                │  ...    │
   └─────────┘               └─────────┘                └─────────┘
     health ✓                  health ✓                  restarts ↻
```

It ships with **nothing**. No blessed paths, no "data directory" setting, no opinion about
what you run — a server is a command, some arguments, and the environment you give it.

---

## ⚡ Quick start

```bash
npx home-hosted            # start it — detached, it stays running
npx home-hosted status     # where is it, is it healthy
```

That is it. The panel is on **<http://127.0.0.1:3999>** and keeps running after the terminal
closes. <sub>Needs Node 24 or newer.</sub> Stop it whenever you like:

```bash
npx home-hosted down       # stops the panel *and* everything it started
```

> [!NOTE]
> The first boot writes a default password (`hh`) so the panel is never unprotected. Change
> it under **Settings → Authentication** — binding beyond `127.0.0.1` stays refused until you do.

<details>
<summary><b>📦 Install it instead of npx-ing it</b></summary>

```bash
npm install -g home-hosted
home-hosted up
```

Everything it owns — config, secrets, logs, TLS, backups — lives in `$HHOSTED_HOME`, default
`~/.home-hosted`. Delete that and nothing of yours is left behind.

</details>

<details>
<summary><b>📁 Keep it in a project you can take anywhere (and share)</b></summary>

Install the servers next to it and commit the whole project — it *is* the setup:

```bash
mkdir my-servers && cd my-servers
npm init -y
npm install home-hosted 9router serve             # the lockfile pins them, so `npm ci` reproduces

npx home-hosted up --home ./state                 # state lives inside the project
```

```jsonc
// package.json
{
  "scripts": {
    "up": "home-hosted up --home ./state",
    "down": "home-hosted down --home ./state",
    "status": "home-hosted status --home ./state"
  }
}
```

```gitignore
state/*                 # secrets, logs, TLS keys and archives stay local…
!state/servers.config.json   # …but the server definitions are committed
```

<sub>Call them as `npm run up` — `npm up` is npm's own update, not your script.</sub>

One clone, `npm ci`, `npm run up`, and the whole setup is up on any machine with Node — or export
it as one archive under **Settings → Backups**.

</details>

<details>
<summary><b>🧰 Run it under systemd or Docker (no daemon needed)</b></summary>

```bash
home-hosted up --foreground     # stays in the foreground, logs to stderr
```

```ini
[Unit]
Description=home-hosted
[Service]
ExecStart=/usr/local/bin/home-hosted up --foreground
Environment=HHOSTED_HOME=/srv/home-hosted
Restart=always
[Install]
WantedBy=multi-user.target
```

</details>

---

## ✨ Features

| | |
| --- | --- |
| 🚦 **Lifecycle** | Start, stop, restart from the panel or the API; `autostart` entries come up with it. |
| ♻️ **Auto-restart** | Exponential backoff on crash, with the counter reset once a process stays up. |
| 🩺 **Health that acts** | TCP or HTTP probes per server: warn on the card, force a restart after a timeout, and check ports before starting — and when something else is squatting on one, kill it from the card. |
| 🔗 **Ordered startup** | `dependsOn` waits for a dependency to be *healthy* — not merely spawned — and stops in reverse. |
| 📜 **Logs** | Live per-server stream, buffer plus rotated files on disk, search, download, one click to clear. |
| 📈 **Resources** | CPU and RSS of the whole process tree, with an optional memory ceiling that triggers a restart. |
| 🌡️ **Host vitals** | Load, memory, swap, disk and CPU temperature, with thresholds that notify once and again on recovery. |
| 💾 **Backups** | One click for config, secrets, TLS and your declared data directories — plain `.zip`, or AES-256 with a password, restored per path. |
| 🚚 **Portable setup** | Restore a shared backup onto a blank instance and the whole server setup is back: definitions, data, secrets and all. |
| 🎨 **BYOU — Bring Your Own UI** | Upload a static build, `home-hosted ui-revert` to go back. [UI_CREATION.md](./UI_CREATION.md) |
| 🔔 **Notifications** | Telegram (grammY) on crash, unhealthy, forced restart, recovery and host thresholds. |
| 🔐 **Security** | httpOnly cookie sessions, **API tokens** for scripts, scrypt hashes, per-IP lockout, optional TLS, and a refusal to expose itself without a password. |
| 🧩 **Server-agnostic** | `command` + `args` + `env` + `cwd`. Nothing in the code knows what you run. |
| 🖥 **Cross-platform** | Linux, macOS and Windows: `/proc`, `ps` or Win32_Process, process groups or `taskkill /T`, no shell dependencies. |

---

## 🧩 Adding a server

Use **➕ Add server** in the panel, or write it into `servers.config.json`:

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

<details>
<summary><b>🧾 Field reference</b></summary>

| field | what it does |
| --- | --- |
| `command`, `args`, `cwd` | what to run, with `{placeholders}` resolved per entry |
| `env`, `dataEnvs`, `envFile` | environment; `dataEnvs` also marks data directories for backups, `envFile` keeps secrets out of the config |
| `port`, `bind` | enables the readiness wait, health checks and the conflict preflight; `local` keeps it on `127.0.0.1` |
| `health.mode` | `port` (TCP connect) or `http` (path, expected status, expected body) |
| `restart.*` | backoff: `maxRetries`, `baseDelayMs`, `factor`, `maxDelayMs`, `resetAfterMs` |
| `stop.*` | signal, `killGroup`, grace period, and whether to sweep leftover port holders |
| `dependsOn` | ids that must be healthy first; stopped in reverse order |
| `resources.maxRssBytes` | restart when the process tree grows past a limit |
| `bootstrap` | one command to run once before the first start (migrations, warmups) |
| `backupPaths` | extra paths this entry owns, included in backups |

Placeholders, and what each one resolves to:

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
environment (including `envFile`).

Every supervised process also gets `HHOSTED_SERVER_ID` and `HHOSTED_CONTROL_PORT`, so a
service can tell which entry it is and how to reach the panel.

</details>

---

## 🛠 CLI

| command | |
| --- | --- |
| `home-hosted up` | start the panel detached, and keep it alive in the background |
| `home-hosted down` | stop it cleanly — supervised processes included |
| `home-hosted restart` | `down`, then `up` |
| `home-hosted status` | pid, URL, health, uptime, state and log paths (`--json` for scripts) |
| `home-hosted set-password` | set the panel password without opening a browser |
| `home-hosted set-token` | set the API token scripts and agents use (`--generate`, `--clear`) |
| `home-hosted ui-revert` | go back to the stock panel UI after uploading your own |

<details>
<summary><b>⚙️ Flags</b></summary>

```text
-c, --config <file>   servers config (default: <state>/servers.config.json)
-p, --port <port>     control panel port (default: 3999)
    --host <bind>     local | lan | an ipv4 address
    --open            open the panel in a browser once it is up
    --no-autostart    do not start the entries marked autostart
    --foreground      run in this process instead of detaching
    --print-config    print the effective config and exit
    --home <dir>      state directory         (or $HHOSTED_HOME)
    --project <dir>   base for relative paths (or $HHOSTED_PROJECT)
```

</details>

---

## 🔐 Security

Everything binds `127.0.0.1` until you say otherwise.

- **A password is required to expose the panel.** Replace the default, then bind to `lan` —
  in the UI, in the config, or with `--host lan`. The same guard applies in all three places.
- **Sessions** live in memory only; the cookie is `HttpOnly` and `SameSite=Strict`, and the
  login route locks out repeated failures per IP.
- **API tokens** let a script or an agent drive the panel without the password:
  `home-hosted set-token --generate` prints one once, and a request proves itself with
  `Authorization: Bearer …`. It is stored as a SHA-256 hash, holds the same access as a
  signed-in browser, works without restarting the panel, and `set-token --clear` revokes it
  instantly.
- **Port conflicts** are shown as `port 4010 is already in use (pid 4242)` and can be resolved
  from a confirmation popover on that banner or card. The process is looked up again at that
  moment — never taken from the message — and anything the panel supervises is refused, not
  killed. Once it is free, the entry starts normally.
- **Secrets never enter the config**: the password hash, the API token hash, the Telegram token
  and the TLS key live in `$HHOSTED_HOME/.control-secrets.json` with mode `0600`.
- **Behind a proxy** turn on `trustProxy` and let `cookieSecure: auto` add `Secure` on https,
  or upload a PEM pair and let home-hosted terminate TLS itself.

---

## 💾 Backups

**Settings → Backups** archives the config, the secrets file, the TLS pair and the data
directories your entries declare — as an ordinary `.zip`:

- no password → **plain zip**, openable by every operating system out of the box
- with a password → **WinZip AES-256**, openable in 7-Zip, WinRAR, Keka, PeaZip, Ark…
- restore is selective: check config, secrets, TLS or individual data paths, and nothing
  else is touched

### 🚚 One archive is a whole setup

Start a **blank** home-hosted anywhere — another machine, another user, a fresh container — upload
the archive under **Settings → Backups** and restore. Definitions come back, data lands where *this*
machine's config says, and `autostart` entries come up immediately.

It works because an archive carries its own `servers.config.json` and paths are matched by the
**declaration** (`9router:DATA_DIR`), not by an absolute path from the source machine. A restore
never writes where no config declares.

<details>
<summary><b>🗂 Declaring data directories</b></summary>

```json
{
  "dataEnvs": { "DATA_DIR": "{home}/.myapp" },
  "backupPaths": ["{home}/.myapp/uploads"]
}
```

`dataEnvs` is exported to the process *and* backed up, so a data directory is declared once.
A path already covered by a declared parent is skipped.

</details>

---

## 🎨 Bring your own UI (BYOU)

The panel is a static site: `$HHOSTED_HOME/.ui` overrides the packaged one, and **Settings →
Interface** takes a zip. No restart, no fork — and `home-hosted ui-revert` brings back the stock
panel if yours breaks.

Two ship in this repo: `uis/stock`, and `uis/noc-console` for TUI and shortcuts wizards; a release
attaches both as `home-hosted-ui-<name>.zip`. Yours can be anything that compiles to static files —
the server never cares what built it. `/openapi/ui` documents the API; [UI_CREATION.md](./UI_CREATION.md)
has the rules and a worked example.

<details>
<summary><b>🤖 Or have an agent build the UI you actually want</b></summary>

The whole contract fits in one file, so a coding agent can do this. Point it at this repo and be
specific about the result:

> Help me build an UI for `home-hosted`: a nostalgic game theme — servers as a party menu, health as
> HP bars, logs in a text-box pane, keyboard navigation, and a save-state corner for backups.
> Follow `UI_CREATION.md`.

Zip the build, install it under **Settings → Interface**, and `home-hosted ui-revert` undoes it if
you change your mind. [`docs/mockups/`](./docs/mockups) holds example directions to borrow from, or
ignore all of them.

</details>

---

## 🌐 HTTP API

The panel is a client of its own API, so everything is scriptable:

| | |
| --- | --- |
| `GET /api/state` | the full snapshot: config, live status, host vitals |
| `GET /api/events` | SSE: the live state, plus logs (`?logs=0`, `?serverId=…`) |
| `GET /api/servers/:id/stream` | SSE: one server's state and logs |
| `POST /api/servers/:id/{start,stop,restart}` | lifecycle |
| `POST /api/servers/:id/free-port` | ask whatever holds that server's port to stop |
| `PATCH /api/servers/:id`, `PATCH /api/settings` | edit configuration |
| `GET /api/logs`, `/api/backups`, `/api/notifications` | logs, archives, Telegram |
| `GET /healthz` | no session needed — the one an external monitor wants (its per-server detail needs a credential) |
| `GET /api/metrics` | Prometheus text |

Everything under `/api` takes either credential: the session cookie, or an API token.

```bash
home-hosted set-token --generate      # prints the token once, then forgets the text

curl -H "Authorization: Bearer hh_…" http://127.0.0.1:3999/api/state
curl -H "Authorization: Bearer hh_…" -X POST http://127.0.0.1:3999/api/servers/9router/restart
curl -N -H "Authorization: Bearer hh_…" 'http://127.0.0.1:3999/api/events?logs=1'   # SSE
```

`GET /openapi/spec.json` describes all of it; `/openapi/ui` is the browsable version.

---

## ❓ FAQ

<details>
<summary><b>Is it a systemd replacement?</b></summary>

No — it is a friendlier layer for the handful of things you run yourself. Keep systemd for the
panel itself (`--foreground`) and for system services; use home-hosted for the rest.

</details>

<details>
<summary><b>What happens to my servers when the panel stops?</b></summary>

`home-hosted down` stops them — that is the point of the command. `SIGTERM`/`SIGINT` are handled
the same way: every supervised process tree is stopped before the panel exits.

</details>

<details>
<summary><b>Which ports does it use?</b></summary>

Just the control panel, `3999` by default. Supervised servers use the ports you give them.

</details>

<details>
<summary><b>Where is my state?</b></summary>

`$HHOSTED_HOME`, default `~/.home-hosted`:

```text
servers.config.json      your servers (the UI writes it back atomically)
servers.config.schema.json  regenerated on every start, for editor autocomplete
.control-secrets.json    password hash + API token hash + Telegram token (mode 0600)
.logs/                   rotated per-server logs + history
.tls/                    an uploaded PEM pair
.backups/                zip archives
run.json                 the running panel (pid, url, token, mode 0600)
```

`home-hosted status` prints the paths.

</details>

<details>
<summary><b>Windows support, really?</b></summary>

Yes. Process trees are sampled from Win32_Process, termination uses `taskkill /T`, and the
shipped examples avoid POSIX-only commands. CPU temperature and swap are best-effort where the
OS does not expose them to an unprivileged process.

</details>

<details>
<summary><b>Nothing starts and the port is busy</b></summary>

A supervised server whose port is taken is reported rather than started over — the panel names
the holder. The control port itself is checked before the listener is opened.

</details>

---

## 🗂 Working on it

<details>
<summary><b>Layout, scripts and conventions</b></summary>

```text
src/            control plane: config, supervisor, API, providers, services
src/cli.ts      the command line (up/down/status/restart/set-password/set-token)
src/index.ts    the control plane itself, used by `up --foreground`
uis/            UIs: `stock` (shipped) and alternatives — any framework, static output
bin/            the published entry point
```

`pnpm dev` runs the panel with `tsx watch` plus the stock UI's dev server (state goes to
`.dev-state/`); `pnpm build` produces `dist/` and `uis/stock/dist/`; `pnpm quickcheck` is lint plus
types; `pnpm test` is vitest; `pnpm run media` regenerates the GIF above. [AGENTS.md](./AGENTS.md)
has the architecture and the rules worth knowing before changing anything.

</details>

---

<div align="center">

**MIT**

</div>
