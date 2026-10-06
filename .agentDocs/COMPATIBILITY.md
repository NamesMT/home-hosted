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
- **An unrecognized key is read, reported and left on disk** instead of failing anything — it is the
  normal way a config from a *newer* release looks. Anything that is not merely unrecognized (a wrong
  value, a duplicate id, an unreadable file) stops the panel instead of being papered over.
- **Unknown keys are dropped from the resolved config, kept on disk, and listed in a startup
  warning.** Dropping one must never fail the group it sits in — that once reset `control` (port,
  bind, auth policy) to schema defaults. A *write* to a group validates the same tolerant way, so a
  key this release does not know never blocks a save: removing a key from a schema must not brick the
  page that writes it.
- **A config records what wrote it.** Every write stamps a top-level `meta`
  (`{ writtenBy, schema }`). An unstamped file reads as the current schema, so nothing that existed
  before needed changing.
- **Nobody runs a config this release cannot read.** `up` refuses to start — exit 1, the exact
  problem printed — when the file is unparseable, has an invalid value or a duplicate id, carries a
  newer `meta.schema`, or has a migration pending. A panel that is *already* running keeps the config
  it has and only reports the error, so a bad edit never disturbs supervision.

## The UI

- **Routes, response fields and SSE frames move in minor steps** — additive: keep the old one and add
  the new one.
- **A new response *field* is optional (`'x?'`) and read defensively.** An upgrade writes a new
  `uis/stock/dist` while the old panel process keeps serving, so a new UI meets an older payload for
  a while — a required field there rejects the whole frame and blanks the app. Request bodies and
  config keep their strict, defaulted shape.

## Migrations

- They **ship inside the package** (`src/config/migrations.ts`), are ordered, idempotent and
  described in one line each.
- `home-hosted migrate` prints the plan, keeps a `.bak` beside each file it rewrites, refuses to
  write a config it cannot read, and needs consent: `--yes`, `HHOSTED_MIGRATE=allow`, or a person at
  a terminal.
- The layout relocation is **not** a schema change: it runs automatically from the CLI pre-pass
  (`ensureLayout()`), so an upgrade never starts against a half-moved directory.
- Fetching migration code from GitHub was considered and rejected: the panel supervises processes, so
  remote code is an RCE surface, and a migration would age against a newer store API anyway.

## Breaking changes

Allowed when nothing compatible can be done, but **never silent**: say so in the final answer *and*
in the commit message with a `BREAKING CHANGE:` footer naming the exact migration to run. Below 1.0
the minor is the breaking channel — see `AGENTS.md`.

## How to test

`test/shared/contracts.test.ts` pins every schema boundary and the patch/schema parity — update it
with any schema change. Migration behaviour is covered by the config tests.
