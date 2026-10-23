# Compatibility and migrations

**Goal:** what may not break silently, and how a config from an older (or newer) release is handled.
**Scope:** config and UI compatibility, and the migration machinery. Feature behaviour is in
`README.md` and `docs/`.

Two surfaces outlive the release that wrote them: **configs absolutely, UIs within reason.** Breaking
either is a last resort, and never an accidental one.

## Configs

- **A config written by an older release has to load in a newer one.** That direction is the
  priority: add fields with defaults, never repurpose or remove one, and treat every existing key as
  permanent.
- **A new field is optional, but has no default, when "absent" must not be a value.** The schedule's
  `scope` is the case: absent means the whole default capture, and filling a default in would rewrite
  every existing config on its first save while reading "narrowed to these ids". Absent has to stay
  distinguishable from chosen, so the field is `optional()` and both UIs read missing as the full
  scope. Use a default everywhere else.
- **An unrecognized key is read, reported and left on disk** instead of failing anything — it is the
  normal way a config from a *newer* release looks. Anything that is not merely unrecognized (a wrong
  value, a duplicate id, an unreadable file) stops the panel instead of being papered over.
- **Unknown keys are dropped from the resolved config, kept on disk, and listed in a startup
  warning.** Dropping one must never fail the group it sits in — that once reset `control` (port,
  bind, auth policy) to schema defaults. A *write* to a group validates the same tolerant way, so a
  key this release does not know never blocks a save: removing a key from a schema must not brick the
  page that writes it.
- **A config records what wrote it.** Every write stamps a top-level `meta`
  (`{ writtenBy, schema }`). An unstamped file reads as the **oldest** schema (`UNSTAMPED_SCHEMA`,
  still 1), not the current one — so once a migration exists it is refused with "needs N migrations"
  and `migrate` lifts it. Reading it as current would skip that step silently.
- **Nobody runs a config this release cannot read.** `up` refuses to start — exit 1, the exact
  problem printed — when the file is unparseable, has an invalid value or a duplicate id, carries a
  newer `meta.schema`, or has a migration pending. A panel that is *already* running keeps the config
  it has and only reports the error, so a bad edit never disturbs supervision.

## The UI

- **Routes, response fields and SSE frames move in minor steps** — additive: keep the old one and add
  the new one.
- **A new response *field* is optional (`'x?'`) and read defensively** (see `AGENTS.md`): a new UI meets
  an older payload for a while, and a required field there rejects the whole frame. Request bodies and
  config keep their strict, defaulted shape.

## The metrics scrape

`/api/metrics` is a published surface nothing in this repo consumes, so a rename there has no
compatible form: the old series simply stops existing. That makes it a **minor**, with the migration
in the release notes and in `README.md`'s scrape section.

- **A Prometheus series name is an API.** `_total` is Prometheus' word for monotonic, so a value a
  manual action resets may never carry it — the name is a promise `rate()` acts on. Rename rather than
  reinterpret: the scrape publishes `hh_server_restarts` and `hh_servers` now, and a dashboard or
  alert on either old name goes quiet until it is updated.
- **No series here is a counter.** Every value is a snapshot that a stop, a delete or a manual start
  can lower, which is why every `# TYPE` is `gauge`; a scrape test enumerates the names and fails on a
  `_total` or a `counter`.
- **A reset a series cannot express belongs in its HELP.** A scrape has no page to explain itself, so
  `hh_server_restarts`'s HELP says a start someone asked for resets it to `0`.

## Migrations

- They **ship inside the package** (`src/config/migrations.ts`), are ordered, idempotent and
  described in one line each.
- `home-hosted migrate` prints the plan, keeps a `.bak` beside each file it rewrites, refuses to
  write a config it cannot read, and needs consent: `--yes`, `HHOSTED_MIGRATE=allow`, or a person at
  a terminal.
- **The pre-workspace relocation is gone as of 0.8.0.** `ensureLayout()` now **refuses** a 0.6.x
  `$HHOSTED_HOME` instead of moving it — `AGENTS.md` states the rule, `src/config/layout.ts` the reason
  it is a refusal rather than a read-as-empty.
- A secrets file that cannot be parsed is refused too, rather than read as a first boot — otherwise
  the default password written on an empty store replaces the password hash, the API token and every
  Telegram and DDNS credential.
- Fetching migration code from GitHub was considered and rejected: the panel supervises processes, so
  remote code is an RCE surface, and a migration would age against a newer store API anyway.

## Breaking changes

Allowed when nothing compatible can be done, but **never silent**: say so in the final answer *and*
in the commit message with a `BREAKING CHANGE:` footer naming the exact migration to run. Which
version channel that means is in [`.agentDocs/RELEASING.md`](RELEASING.md).

## How to test

Migration behaviour is covered by the config tests.
