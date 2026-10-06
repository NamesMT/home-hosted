# Reverse proxy

Expose the whole stack through one engine with automatic HTTPS: `git.example.com` →
your Gitea entry, `media.example.com` → Jellyfin, `panel.example.com` → this panel.

The engine is **Caddy**, downloaded and supervised by the panel. You never edit its
configuration — the panel generates it from the route table and applies it through
Caddy's admin API, which is atomic: a configuration that does not load leaves the
running one in place.

Setup is **Others → Reverse Proxy** in the sidebar.

## Quick start

1. **Install the engine** — one button, the current Caddy release (~46 MB) into
   `$HHOSTED_HOME/.hh/.proxy/bin/`. The version the binary reports is shown afterwards.
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
| `url` | For `target: "external"`, e.g. `http://10.0.0.5:8080`. The port is optional: without one the scheme's own default is used (`:80` for `http:`, `:443` for `https:`). An `https://` upstream is dialled with TLS, and **its certificate is not verified** — a homelab upstream behind a self-signed certificate works, and so does an impostor. |
| `path` | Optional prefix, so one hostname can serve several apps. |
| `tls` | `auto` (default), `off`, `manual`. |
| `dnsAccount` | Optional `workspace/account` for a DNS-01 challenge, referencing a DNS account from Settings. Empty picks the workspace's only account that can write TXT records, so a single-account setup needs nothing here. |

The list's hostname is a link to where the route answers — `https://host:<https port>`, or
the plain port for `tls: "off"`, path included. A route that is switched off is plain text.

A route pointing at the panel is exposure, and answers to the same rule as binding the
listener beyond loopback: authentication on and a non-default password, or the save is
refused.

## HTTPS

| `tls` | What it means |
| --- | --- |
| `auto` | The engine decides. A public name gets a Let's Encrypt certificate (HTTP-01 or TLS-ALPN-01, with renewal in the background). A local-only name gets the engine's own locally-trusted CA. |
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

A name the CA will not issue for falls back to the engine's own CA. The route reads
**Fell back to Local CA**: the name answers, but with an untrusted certificate, and the
engine keeps trying on its own. certmagic renews once a third of a certificate's lifetime
is left, and the engine's own CA issues 12 hours by default, so the next attempt is about
**8 hours** away — no restart, no downtime.

**Force retry certificate** appears on that row only, and asks the CA again immediately.
The engine is **not** restarted: a certificate the engine holds cannot be cleared by
deleting the file or by reloading the configuration, but it *is* released when the name
leaves the configuration — so the panel reloads without that one route, drops the stored
pair while it is out, and puts the route back. Every other route keeps serving; the name
itself has no certificate until the CA answers. It is not offered while a name is still
*pending*, because there the engine is already mid-ACME.

A **removed** route has its stored certificate dropped on the next apply, so adding it
back asks the CA instead of serving the old pair. A **disabled** route keeps its
certificate: it is still configured, and switching it back on should not cost a new
issuance.

The panel derives that wait from the certificate itself: certmagic renews once a third of
the lifetime is left, so two thirds of it is the wait — about 8 hours for the engine's own
12-hour CA. The interval is read, never configured, so there is no knob to shorten it.

A hostname **no route claims** gets a page saying so, on both ports — not a redirect into
a handshake that cannot finish. A visitor with no hostname at all (a bare IP on the HTTPS
port) is answered by the engine's own CA under `hh-fallback.invalid`, so the page appears
after the browser's warning. A hostname that is neither routed nor covered by a
certificate still fails its handshake: there is nothing to present a certificate for.

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
it is refused with the reason. An uploaded pair is re-read as soon as its file changes,
so editing or replacing one outside the panel is picked up on the next look; the engine's
own certificate store (the issued certificates) is read at most every 15 seconds.

Certificates are managed by the engine, inside `.hh/.proxy/engine/`, and nothing else on
the machine is touched: the generated configuration pins its storage root, and the
panel passes the engine no `$HOME` of its own to write into.

**DNS-01** is the way round a router that will not forward 80 and 443. A route is one
hostname, so there is no wildcard to issue; what DNS-01 buys is a certificate with
**no inbound port at all** — behind CGNAT, or on a host only reachable over VPN.
Turn it on in the page and point each route at a DNS account:

```json
{
  "proxy": {
    "dns01": { "enabled": true, "resolvers": [] },
    "routes": [
      { "id": "gitea", "host": "git.example.com", "target": "server", "workspace": "default", "server": "gitea", "dnsAccount": "default/cf" }
    ]
  }
}
```

The account is the one from **Workspace Settings → Dynamic DNS** — same credentials,
same workspace, same notification routing. It does not need the hostname in its
hostname list: the account names the zone, the route names the subject. A route may
name a different account from its neighbour, so names in two zones at two registrars
each get the right one; the panel gives each account a policy of its own.

Leave a route on **Automatic** and it uses the only account that can answer a
challenge. With more than one account, Automatic cannot choose: pick one per route, or
those names keep using the port challenges. A local-only name (`.lan`, an IP) is never
challenged — it is signed by the engine's own CA.

The account is checked when you save, not when the certificate is due: unknown, an
account whose provider cannot write a `TXT` record (the router-style Dynamic DNS
password providers), or one with no credentials stored yet is refused there.

Which accounts can answer: any whose provider writes a `TXT` record. Today that is
Cloudflare and **Namecheap (API)** — the latter is a separate provider from Namecheap's
Dynamic DNS entry, because its credentials differ (API user, key and a whitelisted
client IP) and it rewrites the whole zone per write. Namecheap's Dynamic DNS password
cannot write a TXT record at all, so that account is refused with the reason.

The engine holds no DNS credentials. It asks the panel over the ACMEProxy protocol on
loopback, with credentials the panel generated for it, and the panel writes the
`_acme-challenge` record through that account. `resolvers` overrides the nameservers
the engine checks the record against, which is what split-horizon DNS needs.

Setting it up needs no inbound port, but the record has to be **published** before the
CA looks: the panel writes it, the CA reads it, and the panel removes it again. A
provider that can only write a whole record set — Namecheap's XML API is the one —
is read-modify-write, so the panel rewrites records it did not create, and refuses
rather than adding a 151st record to a zone already at the limit.

## The engine

| | |
| --- | --- |
| Comes from | Caddy's own build service (`caddyserver.com/api/download`), at **its current release** — the panel pins no version, so **Update engine** is how a security fix reaches you. |
| Verified against | **Caddy 2.11.6.** That is the release this build was tested with; a newer one is installed anyway, and the panel reports the version that actually arrived. A release that changes the JSON schema may need a panel update first. |
| Carries | The `acmeproxy` DNS provider, compiled in for every install so the binary does not depend on a setting. `DNS-01` is offered because of it; an engine installed by an older release is refused with *update the engine* rather than failing inside Caddy. |
| Installed at | `.hh/.proxy/bin/hh-caddy` + `engine.json` (version, URL, size, when). |
| Replaceable | Drop any `hh-caddy` build at that path and the panel runs it: it reports *a path configured by hand* and probes no version. Installing or updating is refused while the engine is up — **Stop** it first, because the binary is replaced on disk. |
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
| `POST /api/proxy/engine` | Install or update the engine (`{ "version": "" }` = the current release). |
| `PUT` \| `DELETE /api/proxy/certificates/:id` | Store or remove one uploaded pair (`{ label, certificate, privateKey }`). |
| `POST /api/proxy/start` \| `stop` \| `apply` \| `revert` | Engine lifecycle and configuration. |
| `POST /api/proxy/routes/:id/retry-certificate` | Ask the CA again for one route, without restarting the engine. |
| `POST /_acme/present` \| `cleanup` | The engine's DNS-01 channel: loopback only, and behind credentials the panel generated. Not part of `/api`, so it needs no session. |


## Files

| Path | What |
| --- | --- |
| `.hh/.proxy/bin/` | The engine binary and the record of what was installed. |
| `.hh/.proxy/engine/current.json` | The generated configuration; `previous.json` is the revision before it. Both are `0600`: with DNS-01 on they carry the challenge credentials the engine authenticates with. |
| `.hh/.proxy/state/` | The nanny's spec and state, and `admin.json` (how to reach a running engine). |
| `.hh/.proxy/state/challenge.json` | The credentials the engine presents to `/_acme`, `0600`; written only when DNS-01 is on. |
| `.hh/.proxy/tls/<id>.crt.pem` \| `<id>.key.pem` | One uploaded pair per entry (the key is `0600`). |
| `.hh/.logs/proxy.log` | The engine's own JSON output, as the nanny captures it. |
