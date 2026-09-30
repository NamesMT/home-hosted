# Reverse proxy

Expose the whole stack through one engine with automatic HTTPS: `git.example.com` →
your Gitea entry, `media.example.com` → Jellyfin, `panel.example.com` → this panel.

The engine is **Caddy**, downloaded and supervised by the panel. You never edit its
configuration — the panel generates it from the route table and applies it through
Caddy's admin API, which is atomic: a configuration that does not load leaves the
running one in place.

Setup is **Others → Reverse Proxy** in the sidebar.

## Quick start

1. **Install the engine** — one button, a pinned Caddy release (~46 MB) into
   `$HHOSTED_HOME/.hh/.proxy/bin/`. The version and its SHA-256 are shown afterwards.
2. **Set the ports** — `80` and `443` by default, plus the ACME account e-mail.
3. **Add a route** — a hostname and a target.
4. Point the hostname's DNS at this machine (Dynamic DNS can do that) and switch the
   proxy on.

```json
{
  "proxy": {
    "enabled": true,
    "engine": "caddy",
    "httpPort": 80,
    "httpsPort": 443,
    "email": "me@example.com",
    "staging": false,
    "routes": [
      { "id": "gitea", "host": "git.example.com", "target": "server", "workspace": "default", "server": "gitea" },
      { "id": "panel", "host": "panel.example.com", "target": "panel" },
      { "id": "nas", "host": "nas.example.com", "target": "external", "url": "http://10.0.0.5:8080", "tls": "off" }
    ]
  }
}
```

That block lives in `$HHOSTED_HOME/.hh/settings.json` — the panel writes it for you.

## Ports

`80` and `443` are what automatic HTTPS wants: a certificate is issued over an ACME
challenge on one of them, and anything else needs the router to forward them anyway.

Binding below 1024 needs a privilege. On Linux:

```sh
sudo setcap 'cap_net_bind_service=+ep' "$HHOSTED_HOME/.hh/.proxy/bin/hh-caddy"
```

Otherwise use **4480/4443** — one click in the page, or `httpPort`/`httpsPort` — and
forward `80 → 4480` and `443 → 4443` on your router. A port already in use is reported with
the pid that holds it, on a first start and on a later change alike, and no listener the
panel did not start is ever killed.

## Routes

| Field | Notes |
| --- | --- |
| `id` | Stable name, `[a-z0-9_-]`. |
| `host` | The public hostname. A local-only name (`gitea.lan`, `box`, an IP) gets the engine's own CA instead of a public certificate. |
| `enabled` | A disabled route stays configured but is not served. |
| `target` | `server` (a supervised entry), `panel` (this control panel), `external` (any `host:port`). |
| `workspace` + `server` | For `target: "server"` — an id is only unique inside its workspace. The upstream address is resolved live; a stopped entry leaves the hostname dark and the page says so. |
| `url` | For `target: "external"`, e.g. `http://10.0.0.5:8080`. An `https://` upstream is dialled with TLS, and **its certificate is not verified** — a homelab upstream behind a self-signed certificate works, and so does an impostor. |
| `path` | Optional prefix, so one hostname can serve several apps. |
| `tls` | `auto` (default), `off`, `manual`. |

A route pointing at the panel is exposure, and answers to the same rule as binding the
listener beyond loopback: authentication on and a non-default password, or the save is
refused.

## HTTPS

| `tls` | What it means |
| --- | --- |
| `auto` | The engine decides. A public name gets a Let's Encrypt certificate (HTTP-01 or TLS-ALPN-01, with ZeroSSL as fallback and renewal in the background). A local-only name gets the engine's own locally-trusted CA. |
| `off` | Plain HTTP on the http port, no certificate. |
| `manual` | One of the uploaded pairs, whichever covers the hostname (the engine picks by SNI). A route set to this with no pair covering it is refused, rather than quietly given a certificate from somewhere else. |

`email` is required as soon as a route uses a public hostname, and it is the contact
address the ACME account is registered with. `staging` points that account at the ACME
staging endpoint while you test: the certificates are untrusted, and it is the way to
avoid burning a rate limit. Both reach the engine as one automation policy covering the
**public** names only, so a local-only name keeps the engine's own CA. The engine page
shows the soonest expiry among the publicly-issued certificates. Issuance is Let's
Encrypt; ZeroSSL is not offered as a second issuer because it needs an EAB key the panel
does not collect.

The challenge is the part that catches people out: with the proxy on 4480/4443, **80 has
to reach 4480 and 443 has to reach 4443**, or the CA never sees the challenge and the name
never gets its certificate.

**A name with no certificate yet is still reachable.** The engine's own CA is the last
issuer in the policy, so the handshake completes with an untrusted certificate — the
browser offers to continue instead of failing with `ERR_SSL_PROTOCOL_ERROR` — and over
plain HTTP the same name answers with a page saying so, naming the ports to forward,
rather than redirecting into a handshake that cannot finish. The panel re-applies the
configuration when the certificate arrives, and the route table shows where each name
stands: *issued* · *pending* · *failed* (with the engine's own reason) · *local* (the
engine CA) · *uploaded*.

## Uploaded certificates

*Manual certificate* takes as many PEM pairs as you have names: add one per hostname,
label it, and the engine serves each to the name it covers. A route set to `manual` is
refused while no uploaded pair covers its hostname, and a pair cannot be removed while a
route still serves it — so the two can never disagree.

Certificates are read, never edited: the panel reports each pair's subject, issuer,
expiry and the hostnames it covers (from its SANs, wildcards included), and marks a pair
no route would be served from. An expired pair is never served — the route that asks for
it is refused with the reason. The store is re-read at most every 15 seconds, so a pair
changed outside the panel is reported for a moment before the next read.

Certificates are managed by the engine, inside `.hh/.proxy/engine/`, and nothing else on
the machine is touched: the generated configuration pins its storage root, and the
panel passes the engine no `$HOME` of its own to write into.

**Not yet: DNS-01.** Wildcard certificates, and issuing with no inbound port at all,
need a Caddy build with the registrar's plugin compiled in — every registrar is a
separate Go module, and the stock binary ships none. The engine download path already
takes a plugin list, so this is the next step, not a redesign.

## The engine

| | |
| --- | --- |
| Comes from | Caddy's own build service (`caddyserver.com/api/download`), at a version the panel pins — never "latest" by accident. |
| Installed at | `.hh/.proxy/bin/hh-caddy` + `engine.json` (version, URL, SHA-256, size). |
| Runs as | A child of the panel's own nanny, exactly like a `persistent: true` entry. |
| Supervised by | The panel. The admin API is opened on the panel side only: a unix socket in a `0700` directory (loopback TCP plus Caddy's origin check on Windows). |
| Reloaded by | `POST /load` — atomic, and the revision that applied is kept on disk so a change can be reverted in one click (the first one has nothing to go back to). A reload onto a port something else holds is refused with that pid before the engine is touched, and the panel keeps reporting the ports the engine is really on. |
| Stops with | **Stop** in the page, switching the proxy off, or `POST /api/proxy/stop`. It never stops itself, and `down` leaves it serving — the socket facing the internet is not something a panel restart should drop. It is never restarted automatically either: a configuration the engine refuses needs a person, not a retry loop. |

Because it runs under a nanny, a panel restart does not drop the socket that faces the
internet: the engine keeps serving, and the panel reattaches to it on the next boot.

## API

| Route | What it does |
| --- | --- |
| `GET /api/proxy` | Policy, engine, live state and every route with its resolved upstream. |
| `PATCH /api/proxy` | Change the settings or replace the route list, then apply. |
| `POST /api/proxy/engine` | Install or update the engine (`{ "version": "" }` = the pinned one). |
| `PUT` \| `DELETE /api/proxy/certificates/:id` | Store or remove one uploaded pair (`{ label, certificate, privateKey }`). |
| `POST /api/proxy/start` \| `stop` \| `apply` \| `revert` | Engine lifecycle and configuration. |


## Files

| Path | What |
| --- | --- |
| `.hh/.proxy/bin/` | The engine binary and the record of what was installed. |
| `.hh/.proxy/engine/current.json` | The generated configuration; `previous.json` is the revision before it. |
| `.hh/.proxy/state/` | The nanny's spec and state, and `admin.json` (how to reach a running engine). |
| `.hh/.proxy/tls/<id>.crt.pem` \| `<id>.key.pem` | One uploaded pair per entry (the key is `0600`). |
| `.hh/.logs/proxy.log` | The engine's own JSON output, as the nanny captures it. |
