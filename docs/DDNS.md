# Dynamic DNS

Keep a list of hostnames pointed at this machine's public IP. The panel checks the address on an
interval and calls a provider only when it actually changed — restart-safe, because the last
confirmed address per hostname is kept in `$HHOSTED_HOME/.state/ddns.json`.

**Settings → Dynamic DNS** is the whole setup: add an account, paste its credentials, add hostnames.
Nothing else is required, and provider credentials never enter `servers.config.json`.

```json
{
  "ddns": {
    "enabled": true,
    "intervalMs": 300000,
    "ipv4": { "enabled": true, "url": "" },
    "ipv6": { "enabled": false, "url": "" },
    "ttl": 1,
    "proxied": false,
    "notify": true,
    "accounts": [
      { "id": "cf", "provider": "cloudflare", "label": "Home zone" }
    ],
    "domains": [
      { "host": "home.example.com", "account": "cf", "types": ["A"] },
      { "host": "vpn.example.com", "account": "cf", "types": ["A", "AAAA"], "proxied": true }
    ]
  }
}
```

Credentials live in `.control-secrets.json` (0600), keyed by the account `id`. Header fields:

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Nothing runs until this is on. |
| `intervalMs` | `300000` | How often the public address is re-checked. |
| `ipv4` / `ipv6` | on / off | Which families to detect. A family must be on for its record types. |
| `ipv4.url` / `ipv6.url` | `""` | Override the detector with one endpoint. |
| `ttl` | `1` | Default record TTL; `1` is automatic where supported. |
| `proxied` | `false` | Default for providers with a CDN flag (Cloudflare). |
| `notify` | `true` | Tell Telegram about a change, and about a failure. |
| `accounts[]` | — | `id` (keys the credentials), `provider`, optional `label`. |
| `domains[]` | — | `host`, `account`, `types` (`A`/`AAAA`, default `A`), optional `ttl`, `proxied`, `zone`, `enabled`. |

Per-hostname `zone` pins the registered domain — only needed where a provider has to be told the apex
and the guess is wrong (`home.example.co.uk` is handled; an unusual suffix may not be).

## Providers

| Provider | Record types | Credentials | Notes |
| --- | --- | --- | --- |
| **Cloudflare** | A, AAAA | API token (`Zone → DNS → Edit`); or legacy email + global key | Zones and record ids are discovered, then cached. Updates use `PATCH`, so comments survive. |
| **Namecheap** | A | Dynamic DNS password | Router-style Dynamic DNS, not the XML API. The password is under Advanced DNS → Dynamic DNS — not the account password. IPv4 only. |
| **Spaceship** | A, AAAA | API key + secret | No DDNS endpoint; uses the DNS API's whole-record-set upsert. |
| **Porkbun** | A, AAAA | API key + secret key | Read-then-upsert by name and type. |
| **GoDaddy** | A, AAAA | API key + secret | Optional `baseUrl` points at the OTE test environment. GoDaddy has gated this API by account before; a 403 means the account is not eligible. |
| **Gandi** | A, AAAA | Personal access token (`pat_…`) | LiveDNS RRset update. |
| **DigitalOcean** | A, AAAA | API token | No upsert-by-name; lists records, then updates the one it found. |
| **deSEC** | A, AAAA | API token | `update.dedyn.io`, HTTP Basic with the hostname. |
| **DuckDNS** | A, AAAA | Account token | One token covers every subdomain. |
| **No-IP** | A, AAAA | Email + password | Sends a recognised `User-Agent`; override it if yours is registered. |
| **Dynu** | A, AAAA | Username + password | `password` may be the SHA-256 hash. |
| **Hurricane Electric** | A, AAAA | Per-host DDNS key | `dyn.dns.he.net`. |
| **FreeDNS (afraid.org)** | A, AAAA | The per-record "Direct URL" | Paste the whole URL or just its hash. |

Not supported: **Route 53** (AWS SigV4 signing, a much larger dependency), **DreamHost** (no public
DNS API), and the Namecheap XML API (a full zone rewrite per update).

## Notifications

Telegram carries one message per pass that changed a record, and one for a pass that failed. Turn it
off under Settings → Notifications → *Dynamic DNS*, or with `ddns.notify: false`.

## Adding a provider

`src/providers/ddns/<name>.ts` exports one `DdnsProvider`: its credential fields, the families it can
manage, and an `update()` that makes one HTTP call and returns `{ ok, changed, message }`. Register it
in `src/providers/ddns/index.ts`; the settings page, the credentials form and validation follow from
that metadata. Put the reasoning for `changed: false` in the provider — it is what makes the panel
skip a write when a record is already current.
