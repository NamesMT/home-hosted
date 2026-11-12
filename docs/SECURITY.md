# Security

**Safe out of the box.** The panel listens on `127.0.0.1` only, behind a password, and refuses to
listen anywhere else — or to be served through its own reverse proxy — until you set your own
password of at least 12 characters. Nothing is exposed until you decide it should be.

## The three things you actually have to do

1. **Set your own password before exposing the panel.** The first `up` generates a random
   first-run password and prints it; `home-hosted status` shows it again on the machine until you
   change it (Global settings → Authentication, or `home-hosted set-password`). Then bind to `lan`
   — in the UI, the config, or `up --host lan`. All three go through the same check, which also
   wants the password to be **at least 12 characters**: any length works on loopback, but a shorter
   one keeps the panel there (and `set-password` refuses one while the panel is already exposed).
   A password set before this rule existed is not measured — set it again to be sure.
2. **Treat an API token as the account it runs as.** A token can create and start server entries,
   which run any command as the panel's user. Changing the password does *not* revoke it; rotate or
   revoke it under Global settings → Authentication, or with `set-token --generate` / `--clear`.
3. **Forgot the password?** Run `home-hosted set-password` on the machine: it writes a new one to
   the secrets file directly — no login needed — and the panel picks it up at once.
   (`set-password --clear` removes the password without setting another: authentication stays on and
   nobody can sign in, so only this machine and an API token reach the panel until one is set.)

## How a request is trusted

| Check | Rule |
| --- | --- |
| **Host** | must be an IP, `localhost`, a single-label or local-suffix name (`.local`, `.lan`, `.home.arpa`, …), a reverse-proxy route that serves the panel, or listed in `control.allowedHosts`. Otherwise `421`. This blocks DNS-rebinding attacks from web pages you visit. |
| **Origin** | a cookie-authenticated write from another origin is refused (`403 CROSS_ORIGIN`); cookies are `HttpOnly` and `SameSite=Strict`. Bearer-token requests are exempt — browsers never attach a token on their own. |
| **Credential** | a session cookie, or `Authorization: Bearer <token>`. |
| **"This machine"** | a request from a loopback address that carries **no** forwarding header — `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, or the `X-Forwarded-Proto`/`-Host`/`-Port`/`-Prefix` family. Only such a request may set the first password, use the local control channel, or use `/api` without a credential while no password is in force (authentication off, or on with none set; anything else gets `401 AUTH_DISABLED_REMOTE` / `AUTH_UNARMED`). **This is a heuristic, not a guarantee.** It answers correctly for the panel's own reverse proxy (a loopback peer that adds none of those headers — which is exactly why the rule exists) and for any proxy that adds at least one of them. A proxy that forwards the request while *stripping* every one of those headers is indistinguishable from a direct local client and would get local trust — unavoidable, since the panel's own engine is exactly such a peer. So set `control.auth.trustProxy` deliberately for the arrangement you actually have, and do not put the panel behind a proxy configured to remove them. |

Reaching the panel through an **external** proxy or tunnel on a public name? Add the name to
`control.allowedHosts` in `.hh/settings.json` (or under Global settings → Listener, reached by IP).

## Sessions, tokens and lockout

- **Sessions** live in memory only. The lifetime is an *idle* timeout: each request slides it.
  Changing the password signs every session out.
- **Tokens** are stored as a SHA-256 hash; the value is shown once. **A token is full admin**: it can
  create and start an entry, and an entry runs any command as the panel's user — so anyone holding
  it can do anything that user can, on this machine, including what the panel refuses it.
- **A few actions are refused to a token** and need a signed-in session (or this machine):
  clearing the password, switching authentication off, minting or revoking an API token, setting the
  *first* password, installing a custom UI, and restoring an archive that carries `global:secrets`
  (`403 SESSION_REQUIRED`). That keeps a script from doing them by accident, and keeps a leaked
  token from locking you out of the panel itself. It is **not** a boundary against someone holding
  the token: revoke a leaked one, and treat the machine as theirs until you have.
- **Repeated login failures lock out per client address**, escalating to 15 minutes. On top of that,
  the whole panel accepts at most 100 failed sign-ins per 10 minutes, whatever address they claim;
  past that every sign-in — a correct one too — is `429` until the window closes
  (`home-hosted set-password` on the machine always works).

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

### A token is scoped, and the scopes mean something

A token used to be full admin — the right shape for one script and the wrong one for a homelab. The
four scopes are **cumulative**, and `workspaces` narrows a token to some of them:

| scope | what it allows |
| --- | --- |
| `read` | every `GET`: state, logs, metrics, the live feed |
| `lifecycle` | start, stop, restart, free a port, clear logs |
| `config` | server, workspace and settings writes, and backups |
| `admin` | everything, including tokens, the password, a UI install and restoring secrets |

**A `read` token is refused `403 TOKEN_SCOPE` on every non-GET**, and a token limited to `default`
cannot act on `staging`. The requirement is declared **once**, per route, in
`src/middleware/token-scope.ts`; a test walks every `/api` route in the published spec and fails on
one that has no declaration, so a new route cannot ship without a scope. A route with no declaration
is refused rather than allowed — the one somebody forgot must not be the one every token can use.

Sessions and this machine are unaffected: scopes are about **tokens**.

Only a hash is stored, compared in constant time against every token (an early return would make the
timing depend on which token was presented). The single pre-0.14 token migrates to one named
`default` with `admin`, so upgrading removes no access.

The `admin` scope is still "everything a token may do" — and a token may still run any command
through an entry. **It is not a boundary against someone holding the token**; it is a way to give a
script only what it needs.

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
