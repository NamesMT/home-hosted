# Security

**Safe out of the box.** The panel listens on `127.0.0.1` only, behind a password, and refuses to
listen anywhere else — or to be served through its own reverse proxy — until you set your own
password of at least 12 characters. Nothing is exposed until you decide it should be.

## The three things you actually have to do

1. **Set your own secret before exposing the panel.** The first `up` creates an account `default`
   with a random generated secret and prints it; `home-hosted status` shows it again on the machine
   until you change it (Global settings → Accounts, or `home-hosted account secret default`). Then
   bind to `lan` — in the UI, the config, or `up --host lan`. All three go through the same check,
   which also wants the secret to be **at least 12 characters**: any length works on loopback, but a
   shorter one keeps the panel there (and the API refuses one while the panel is already exposed).
   A secret set before this rule existed is not measured — set it again to be sure.
2. **Treat an `admin` account as the user it runs as.** It can create and start server entries,
   which run any command as the panel's user. Give a script the least it needs instead
   (`--scope read`, or `read,lifecycle` for a deploy hook), and revoke it under Global settings →
   Accounts, or with `home-hosted account revoke <id>`. **`config` is in the same class for this
   purpose** — it writes what will be run, and the panel runs it — so a monitor gets `read`, never
   `config`; see [the scope table](#an-account-is-scoped-and-the-scopes-mean-something).
3. **Forgot the secret?** Run `home-hosted account reset` on the machine: it writes a fresh
   generated secret to the secrets file directly — no login needed — and prints it once. A
   credential cannot reset another's secret through the API, which is what keeps a stolen one from
   making itself permanent; the machine is the way in.
   (`home-hosted account disable-auth` turns the guard off without deleting anything: nobody signs
   in, and only this machine reaches the panel until it is switched back on.)

## How a request is trusted

| Check | Rule |
| --- | --- |
| **Host** | must be an IP, `localhost`, a single-label or local-suffix name (`.local`, `.lan`, `.home.arpa`, …), a reverse-proxy route that serves the panel, or listed in `control.allowedHosts`. Otherwise `421`. This blocks DNS-rebinding attacks from web pages you visit. |
| **Origin** | a cookie-authenticated write from another origin is refused (`403 CROSS_ORIGIN`); cookies are `HttpOnly` and `SameSite=Strict`. Bearer-token requests are exempt — browsers never attach a token on their own. |
| **Credential** | a session cookie (sign in with an account id **and** secret), or `Authorization: Bearer <id>:<secret>`. |
| **"This machine"** | a request from a loopback address that carries **no** forwarding header — `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, or the `X-Forwarded-Proto`/`-Host`/`-Port`/`-Prefix` family. Only such a request may create the first account, use the local control channel, or use `/api` without a credential while no account is in force (authentication off, or on with none set; anything else gets `401 AUTH_DISABLED_REMOTE` / `AUTH_UNARMED`). **This is a heuristic, not a guarantee.** It answers correctly for the panel's own reverse proxy (a loopback peer that adds none of those headers — which is exactly why the rule exists) and for any proxy that adds at least one of them. A proxy that forwards the request while *stripping* every one of those headers is indistinguishable from a direct local client and would get local trust — unavoidable, since the panel's own engine is exactly such a peer. So set `control.auth.trustProxy` deliberately for the arrangement you actually have, and do not put the panel behind a proxy configured to remove them. |

Reaching the panel through an **external** proxy or tunnel on a public name? Add the name to
`control.allowedHosts` in `.hh/settings.json` (or under Global settings → Listener, reached by IP).

## Accounts, sessions and lockout

An **account** is one credential that does both jobs: an `id` a person types (like a username) and a
`secret` that opens a session for the browser *and* works as `Authorization: Bearer <id>:<secret>`
for a script. That replaced the separate password and API token, and it is what makes more than one
person possible.

- **The id is not secret.** It is what a login is keyed on, what the rate limit counts, and what
  makes a stolen secrets file unusable without the matching id. The **secret** is the credential.
- **A wrong id and a wrong secret answer identically, and cost the same.** The refusal never confirms
  that an id exists, so the login form is not an account-enumeration oracle — and an unknown id still
  runs one scrypt before answering, so the *timing* does not confirm it either.
- **Two hash algorithms, deliberately.** A secret a person chooses is stretched with scrypt, because
  it may be guessable and an offline attacker with the file would otherwise walk it. A secret the
  panel *generates* is 256 bits of randomness, where scrypt would only tax every request for a space
  nobody can walk. The record says which, and verification reads it.
- **Only a hash is stored**, and the value is shown exactly once — at creation, or when it is set.
- **Sessions** live in memory only, and the lifetime is an *idle* timeout: each request slides it. A
  session belongs to **its account**, so rotating one account's secret signs out *that account's*
  other sessions and leaves everyone else's alone. Revoking or disabling an account ends its sessions
  too — a valid cookie must not outlive the credential it was issued for.
- **Scopes are per account** — `read`, `lifecycle`, `config`, `admin`, cumulative — with an optional
  workspace limit. See [the scope table](#an-account-is-scoped-and-the-scopes-mean-something). A token
  used to be full admin, so a monitor that only read held the same credential as a deploy hook.
- **Managing credentials needs a session, never a credential.** Creating, editing or revoking an
  account requires a signed-in session whose account holds `admin` (`403 SESSION_REQUIRED` /
  `TOKEN_SCOPE`). A credential that could mint another could escalate past its own scopes, and a
  stolen one could make itself permanent. The same rule covers switching authentication off,
  installing a custom UI, and restoring an archive that carries `global:secrets`.
- **Two refusals keep the panel reachable**: you cannot revoke the account you are signed in as
  (`CANNOT_REVOKE_SELF`), and you cannot revoke the last one that can sign in (`LAST_ACCOUNT`).
- **Scopes are not a boundary against someone holding the credential.** An entry runs any command as
  the panel's user, so `admin` can do anything that user can on this machine. Give a script the least
  it needs, and treat a leaked credential as that user until you have revoked it.
- **Repeated login failures lock out per client address**, escalating to 15 minutes. On top of that,
  the whole panel accepts at most 100 failed sign-ins per 10 minutes, whatever address they claim;
  past that every sign-in — a correct one too — is `429` until the window closes. Recovery is
  `home-hosted account reset` on the machine, which always works. **A wrong `Authorization: Bearer`
  credential counts the same way, per client address:** it costs one scrypt to refuse, so an
  unlimited stream of them would be a way to make the panel burn CPU without holding any credential
  at all. It is bounded per address rather than panel-wide, because the panel-wide counter also
  refuses a *correct* credential once spent — reusing it here would let one caller posting junk
  headers lock every working script out of the API. A refused bearer answer is `401`, exactly as a
  wrong secret is.

## Behind a proxy

`control.auth.trustProxy` decides whose `X-Forwarded-For` names the client:

| Value | Trusts it from | Use when |
| --- | --- | --- |
| `loopback` *(default)* | a proxy on this machine | the panel's own reverse proxy, or nginx/Caddy on the same host. Remote clients get their real address (lockout, logs) and cannot forge one |
| `true` | any peer | the proxy runs on another machine and is the only way in. The client address is then whatever the header says, so the per-IP lockout can be dodged (the panel-wide cap above still holds); the panel warns at startup |
| `false` | nobody | nothing in front of the panel |

`cookieSecure: auto` adds `Secure` when the request arrived over https. To terminate TLS in the panel
itself, upload a PEM pair under Global settings → TLS.

## Secrets on disk

Never in a config file. The state directory (`.hh`) is created `0700` by whichever command creates
it first, `up` tightens an older one to `0700`, and each of these is `0600`:

| What | Where |
| --- | --- |
| password hash (and the first-run password, until it is changed), token hash | `.hh/.control-secrets.json` |
| notification tokens, DDNS credentials, a server's secret environment values | `.hh/<workspace>/.secrets.json` |
| the panel's TLS pair | `.hh/.tls/` |
| the running panel's local-channel token | `.hh/run.json` |

DDNS credentials are additionally sealed with AES-256-GCM under `HHOSTED_DDNS_SECRET`, because they
are replayed to a third party. Its default is a fixed value, which protects nothing if the state
directory is copied — **set your own** if you commit or share `.hh/`.

### An account is scoped, and the scopes mean something

A credential used to be full admin — the right shape for one script and the wrong one for a homelab.
The four scopes are **cumulative**, and `workspaces` narrows an account to some of them:

| scope | what it allows |
| --- | --- |
| `read` | the readings: state, logs, metrics, the live feed — every `GET` **except an archive download** |
| `lifecycle` | start, stop, restart, free a port, clear logs |
| `config` | server, workspace and settings writes, and backups (**if** the account names no workspace limit — an archive spans them all). **Also command execution:** it writes the command an entry or job runs, and the panel runs it |
| `admin` | everything, including tokens, the password, a UI install and restoring secrets |

`read` is not "cannot cause work to happen". `GET /api/host/temperature` is a reading, and answering
it **runs `host.tempCommand`** through a shell, so it is cached and its concurrent callers share one
probe — otherwise a `read` credential could spawn a process per request (measured: 20 simultaneous
requests peaked at 40 processes before the cache). The one place a `read` token can still cost the
panel a process is that probe, once per few seconds.

**A `read` account is refused `403 TOKEN_SCOPE` on every non-GET**, and one limited to `default`
cannot act on `staging`. **Leaving `?workspace=` out is not a way around that limit:** an omitted key
resolves to the panel's default workspace, so a request that names none is checked against the
default. An account limited to `staging` is therefore refused `GET /api/servers` (which would have
read `default`) exactly as it is refused `?workspace=default`. **Nor is naming the workspace in the
path:** `PATCH`/`DELETE /api/workspaces/:id` act on the workspace in the URL, so the limit is checked
against that id too — a limited account may rename and remove only the workspaces it names, while
creating one and listing the registry stay open. **The live feed is filtered too:** the stream carries
a `log` frame for every workspace, so a limited account sees only its own workspaces' frames (and
naming one it does not hold is the same `403`), rather than reading a workspace it may not poll. Its
**snapshot** frames are narrowed rather than dropped: `hello` and every later `state` frame carry the
whole panel, so a limited account's copy holds only its own workspaces' subtrees — otherwise the
opening frame handed it every server id, command, pid and status, which is the data the polling route
refuses. **So is the metrics scrape:** `GET /api/metrics` is panel-wide in its *query* but every
sample carries a `workspace` label, so a limited account's scrape holds only its own workspaces'
series — it would otherwise read another workspace's server ids, status, crash counts, restarts,
uptime, response time, RSS and CPU, which is the same data `GET /api/servers?workspace=…` refuses it.
**And so are the two panel-wide snapshots:** `GET /api/state` and `GET /api/workspaces` name no
workspace, but each answers `workspaces[].servers[]` — the very `ServerView` the polling route
refuses — plus each workspace's `configPath` and `logsDir`. A limited account's copy of either holds
only the workspaces it names. **And the reverse proxy:** `GET /api/proxy` flattens every workspace's
DDNS accounts into one list (a route names an account as `<workspace>/<account>`) and answers a route
table whose rows name the entry they forward to (a route names one as `<workspace>/<server>`), so a
limited account's copy holds only its own rows and its own accounts — otherwise it read another
workspace's account id, provider and zones *and* its route id, public hostname and target entry.
**The write side follows the same limit, and is the dangerous half:** a `PATCH` sends a route list,
and a list is replaced whole, so a limited account that sent its own one row used to delete every
other workspace's and could point a public hostname at an entry it may not act on. A row naming a
workspace outside the limit is `403 TOKEN_SCOPE`, and the rows it may not touch are carried over so
the replacement cannot drop them. The engine's own knobs (`enabled`, ports, `dns01`, certificates)
name no workspace, so a limit does not reach them — they are the panel's, like `PATCH /api/settings`.
An account with no limit reads and writes the whole panel as before,
so a person's overview, selector and proxy form are unchanged. The requirement is declared **once**, per route, in
`src/middleware/token-scope.ts`; a test walks every `/api` route in the published spec and fails on
one that has no declaration, so a new route cannot ship without a scope. A route with no declaration
is refused rather than allowed — the one somebody forgot must not be the one every token can use.

Sessions and this machine are unaffected: scopes are about **tokens**.

**A backup archive is `config`, not `read`, although fetching one is a `GET`.** An archive carries
every workspace's `secrets.json` and the panel's own `.control-secrets.json` in the clear — account
hashes, DDNS credentials, Telegram tokens, every server's secret environment values — so handing one
to a monitor credential would walk around every rule that keeps a secret *value* off a route. `read`
is the readings; an account that may take an archive (`POST /api/backups`) may fetch it.

**A workspace limit refuses the archive routes outright.** An archive reaches every workspace at once,
and it names no `?workspace=`, so there is nothing for the limit to narrow: an account limited to
`staging` used to take a backup that carried `default`'s `secrets.json`, restore one over `default`'s
`servers.config.json`, and delete an archive the owner had made. Every backup route (`GET
/api/backups`, `POST /api/backups`, `GET …/:name/download`, `POST …/restore`, `DELETE …/:name`) is
declared `workspaceScoped: 'all'` — the inverse of panel-wide-with-nothing-to-narrow — so an account
with **no** workspace limit keeps them and one with a limit gets `403 TOKEN_SCOPE`. Narrowing them
instead would need an archive format that names the workspaces a selection covers, and a restore that
checks each one; refusing is the honest answer until something does.

Only a hash is stored, compared in constant time against every token (an early return would make the
timing depend on which token was presented). The single pre-0.14 token migrates to one named
`default` with `admin`, so upgrading removes no access.

The `admin` scope is still "everything a token may do" — and a token may still run any command
through an entry. **It is not a boundary against someone holding the token**; it is a way to give a
script only what it needs.

> [!WARNING]
> **`config` also reaches command execution, so do not hand it to something you would not hand a
> shell.** A config write *declares what runs*, and the panel then runs it without asking again:
> `POST /api/jobs` with a `schedule` leaves the scheduler to execute the command on its next
> occurrence, `PUT`/`PATCH /api/servers/:id` with `autostart` runs the entry at the panel's next
> boot, and `PATCH /api/settings` sets `host.tempCommand`, which the host monitor executes every
> sample. Verified on a panel with an account holding `read,config` and **not** `lifecycle`: `POST
> /api/jobs/:id/run` was refused `403 TOKEN_SCOPE` while the same job's scheduled command produced a
> shell's `id` output a minute later. Every one of these is `workspaceScoped` where it names a
> workspace, so a limited account stays inside its own — but inside those workspaces, `config` is
> execution. Only give it to a deploy pipeline or an operator who is trusted to run commands as the
> panel's user; that is the same trust `admin` carries, which is why the two differ in *reach*
> (credentials, the UI, the panel's own secrets), not in `can it run a command`.

### A server's secret environment never enters its config

`servers.config.json` declares only the **names** (`secretEnv`); the values sit in the workspace's
secrets file. That split is the point, not an implementation detail: a config is copied into a
backup, printed by `home-hosted status`, served by `GET /api/state` and quoted in issues. Anything in
it is published.

The consequences are enforced rather than promised:

- `PUT /api/servers/:id/secrets` is **write-only** — it answers `ok` and nothing else;
- the server view reports `secretEnvSet`, the names that have a value, and no route returns a value;
- `home-hosted secret` prints a name and a set marker, never a value, on any path including an error;
- a name the entry does not declare is refused, so a leftover value cannot reach a child;
- **removing an entry or a job deletes the values it owned.** A re-created id starts with none, rather
  than inheriting a dead entry's credentials — the same rule its log lines and crash history already
  followed. (The declared-name rule above is what makes that safe rather than merely tidy: an entry
  that does not name a variable never receives one.)
- the file is `0600`, like every other secret, and the secrets part of a backup carries it — which is
  what makes a move to a new machine keep working. The old arrangement (an `envFile` beside the code)
  was not in a backup at all.

## Plain http on a LAN

`http://192.168.x.x` is not a secure context, so browsers withhold some APIs there. The stock UI
works around the one it uses (copy-to-clipboard), and says so when even the fallback is refused.

## Port conflicts

A busy port is named with its holder, and **Free port** looks the holder up again at that moment —
never from a pid quoted in a message — and refuses anything this panel supervises.

## Reporting a vulnerability

Open a private security advisory on
[GitHub](https://github.com/NamesMT/home-hosted/security/advisories/new) rather than a public issue.
