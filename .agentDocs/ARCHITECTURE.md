# Architecture — per-file rationale

**Goal:** why each module exists and what it owns, so a change lands in the right file.
**Scope:** module responsibility and the decisions behind it. Runtime rules stay in `AGENTS.md`;
state layout is there too.

## Layout

- `src/cli.ts` — the CLI's thin root. Two things happen before [citty](https://github.com/unjs/citty)
  is asked anything: `--home`/`--project` are peeled off and applied (`src/cli/args.ts`), and the
  curated dispatch — `help`/`version`, `unknown command`, and the `-p 4000` shorthand for `up` — is
  decided, because `#src/helpers/paths.ts` resolves at import time. The curated dispatch reads only the
  flag forms (`--help`/`-h`, `--version`/`-v`) after a command name, never a bare `help`/`version`,
  because that is an option's value (`init --name help`). Its static imports stay node
  builtins, citty and two path-free local modules; every command is a lazy
  `() => import('#src/cli/<command>')` in `subCommands`, so a command module *may* use static `#src`
  imports — that is the point of the pre-pass. The hidden `__nanny` is dispatched by an early branch,
  not `subCommands`, so it stays out of the curated help and the unknown-command message.
  `runMain` is deliberately unused: it prints its own usage and `console.error`s before
  `process.exit(1)`, replacing `fail()`'s one error shape. `src/cli/io.ts` is the one place readline
  prompts and colours live.
- `src/index.ts` — `runControlPlane()`: wiring, startup guards (exposure, free port, live run.json),
  `run.json`, signals. **Wiring belongs here and nowhere else.**
- `src/app.ts` — the Hono root, chained routes only. `/_hh` is mounted *before* the `/api/*` auth
  guard on purpose (a local `down` uses run.json's token, not a session). `AppType` is the route type
  `hc<AppType>` clients and the OpenAPI document derive from.
- `src/openapi.ts` — `setupOpenAPI(app)`: `/openapi/spec.json`, generated from the same ArkType
  schemas the routes validate with (one source of truth, no second set of DTOs to drift), and the
  `/openapi/ui` Scalar reference. Both sit outside `/api`, so they need no session — a UI author has to
  read the spec before they can log in.
- `src/api/**` — one file per URL group (`$.routes.ts` = several routes), mirroring the path.
- `src/shared/` — the only code both `src/` and the UIs read. `contracts.ts` holds every ArkType
  schema (config, API and SSE DTOs); the OpenAPI spec is generated from it. `shape.ts` is the
  plain-object predicate. `proxy-form.ts` is the reverse-proxy form both UIs edit. `fields.ts` is the
  server form's textarea round-trips, `error-message.ts` the one rendering of a caught value;
  `patch-diff.ts` and `generated.ts` are shared helpers; `cpu-scale.ts` decides how a server's
  `cpuPercent` sits on *this* machine (`cpuCapacity`/`cpuBand`), because the charts and the numbers
  that colour themselves had drifted apart while the rule was restated at each surface;
  `host-readings.ts` decides whether a host frame carries a sample at all (`hostReadings`), read by
  the scrape and by every host surface in both UIs, so neither can publish the all-zero boot frame
  as a measurement.
  **These must not import Vue or `node:` APIs.**
- `src/config/` — split by scope. `settings.ts` (`GlobalSettingsStore`: `.hh/settings.json` —
  listener, auth, TLS policy, host vitals, backups) and `store.ts` (`WorkspaceStore`: a workspace's
  `settings.json` + `servers.config.json`, validate/merge/atomic commit, reporting
  `configError`/`configWarnings` instead of throwing). `workspaces.ts` is the registry, `layout.ts`
  the refusal of a pre-workspace `HHOSTED_HOME` (0.8.0 dropped the relocation itself). `schema.ts`
  holds the three on-disk shapes plus the `meta` stamp, `parse.ts` the tolerant readers, `patch.ts`
  the merge helpers, `migrations.ts` the schema constant and ordered step registry,
  `secrets.ts`/`seed.ts` the secret scopes and seeds.
- `src/providers/` — stateless leaves returning plain data: `process` (spawn, `terminate`,
  `terminatePid` for an adopted process), `port` (probe, holder lookup, `terminatePids`), `proc`
  (sampler, `processCarriesServerId`, `processTreeOwners`), `docker` (a compose entry's containers:
  detection from its argv, attribution by compose labels, one batched `docker stats` and its cache),
  `identity` (which port holder is this entry's own successor), `nanny` (a persistent entry's
  spec/state files and liveness rules), `log-tail` (offset reader surviving rotation and truncation),
  `ddns/` (one provider per registrar), `proxy/` (the engines this build can drive — the route model
  stays the panel's), health-check, host, telegram, archive.
- `src/services/` — stateful orchestration: `panel` (one `WorkspaceRuntime` per workspace, workspace
  CRUD, the single aggregate state frame — every per-workspace service hangs off it), supervisor,
  control-server, config-watch, state, auth + exposure, dependencies, history, log-buffer/log-files,
  notifications, host-monitor, ddns, proxy, backups, tls, ui, `init`, `nanny`, `log-relay`.
  **It names no server** — the scaffold must stay as neutral as the supervisor.
- `src/middleware/auth.ts` — the `/api/*` guard, and `requestIdentity()`, the one place a request's
  credentials are read: the `hh_session` cookie or `Authorization: Bearer <api token>`. A token has
  the same authority as a signed-in browser and is verified from the secrets file on every request,
  so `set-token` needs no restart.
- `src/middleware/loopback.ts` — `requestIp`/`isLoopback`/`isLoopbackRequest`, the client-address
  helpers shared by the auth guard and the setup routes. The address is srvx's, so whether it means
  anything is decided by `trustProxy`.
- `src/helpers/` — paths (`dataRoot` vs `projectDir`), daemon (run.json + a loopback probe that
  bypasses `fetch`, so TLS with a self-signed pair still answers), error, validator, atomic,
  template, env-file, openapi, factory.
- `uis/<name>/` — a Vite app (Vue 3 + Tailwind v4) built through `uis/vite.shared.ts`; `stock` is
  the one shipped in the package. Aliases: `@` → that UI's `src`, `@shared` → `src/shared`,
  `@server` → `src` (**types only**). `uis/<name>/public/ui.json` is the UI's identity.
- `bin/home-hosted.mjs` — the published bin: `dist/cli.js`, or `src/cli.ts` through tsx when the
  build is missing (a linked checkout).
- `scripts/` — build and CI helpers. **Build:** `build-uis.mjs`, `build-locales.mjs` (the sheet →
  catalog step), `build-brand.mjs`, `build-social-preview.mjs` (both `pnpm run brand`),
  `build-types.mjs` (the published client's declarations, `#src` rewritten), `capture-media.mjs`,
  `dev.mjs`. **Six that *gate* something:** `quickcheck.mjs` (eslint, tsc, vue-tsc and doc links in
  parallel, cached), `typecheck-uis.mjs` (the UI
  typecheck inside `test:types`, exits 1), `check-release-version.mjs` (may a release be
  dispatched), `release-notes.mjs` (the release body), `check-doc-links.mjs` (the links in the docs
  that ship), `stamp-uis.mjs` (the pre-commit version bump).
- `docs/` — the topic docs, `mockups/*.html`, and `media/*` regenerated by `pnpm run media`. Only
  the `.md` files are published; media is a build artifact.

## What both UIs share

Every module in `src/shared/` exists because the same code lived in both UIs (or a UI and `src/`)
and the copies had already drifted. The rule:

- A module moves in when its dependencies resolve within `src/shared/`; it stays out when it would
  import *upward* — `uis/stock/src/lib/rpc.ts` needs `AppType` from `src/app.ts`.
- **Nothing in it imports Vue or `node:`** (the package does not ship Vue). Reactive values are detached
  with `clonePlain` (`clone.ts`), so form logic is shared (`proxy-form.ts`, `ddns-form.ts`) and only the
  render stays per-UI.
- A helper whose signature genuinely differs per product stays per-UI (`formatBytes`, `formatDateTime`).
- `test/shared/ui-parity.test.ts` fails if any consumer (the UIs **or** `src/**`) re-declares a shared
  member; `isRecord` (`shape.ts`) is matched by body, not name, and its `!Array.isArray` half is pinned.
- **Moving code means moving its tests**: `src/shared` has a 95% coverage floor, and code the UIs
  exercised only through components counts for nothing there.

## UI versioning

**`ui.json` is bumped once, when the commit is made** — not on every edit. A commit altering what a
UI *ships* (`uis/<name>/src`, `public`, build inputs — not `test/` or the UI's own `README.md`)
raises that `version`: patch for a fix, minor for a feature, **major only for a rewrite or a
restyle**. The number tells a person how big the change is; `ui-update` prints it and holds it against
the release it offers.
`scripts/stamp-uis.mjs` enforces the rule from the pre-commit hook (see `AGENTS.md`).

**`tag` and `unix` are build provenance, and no source file carries them.** `build-uis.mjs` stamps both
into `dist/ui.json` after Vite runs; the release workflow passes `HHOSTED_UI_TAG`, anywhere else the
build stamps `v<package.json version>`. Committing either was the defect — a zip is built before its
release is cut, so the recorded tag could never reach the panel's own version and `ui-update`
reinstalled the same UI on every boot. `stamp-uis.mjs` only *checks* the version; it writes nothing.

**A shared contract is a build input, and the hook cannot see it.** `@shared` is aliased into every UI
bundle, so a change to `src/shared/contracts.ts` alters what each UI ships — but `stamp-uis.mjs` only
looks at staged `uis/<name>/*` paths, so a contracts-only commit passes the hook unbumped. Decide it
by hand: does a UI *call* the changed export at runtime (`serverPatchSchema` is validated client-side
by both UIs before they send), or does it read it as a *type* only (`serverSchema` is)? Only the
former changes the asset, and it bumps every UI that calls it.

## UI strings

- `uis/<name>/i18n/sheets/*.csv` is the source: one row per string, one column per language.
  `scripts/build-locales.mjs` merges them into the ignored `i18n/generated/*.json` (rebuilt by
  `pnpm install` and every UI build), and folds plural rows (`key[one]`, `key[few]`, ...) into CLDR forms.
- A sheet is named after its keys' prefix (`settings.ddns.csv`; `settings`/`proxy`/`views` shard one
  level deeper) so no single file is expensive to read. `uis/stock/test/i18n-catalog.test.ts` enforces
  the home, a per-file size budget, and no key defined twice (the merge keeps the last one silently).
- A wording change ships a different UI, so it bumps `ui.json` like any other source edit.
- `uis/stock/test/untranslated-copy.test.ts` fails on a literal word in a `.vue` template or accessible
  name (`<code>` is exempt: it holds a token the reader types); `uis/stock/test/toast-copy.test.ts`
  does the same for toast titles and messages in `.ts` and `.vue`, following the receiver
  `useToasts()` was bound to.

## How to test

A component worth guarding mounts under `// @vitest-environment happy-dom`; the suite resolves `@/…`
from the UI that asks, so each UI's tests can import its own components. The commands are in
`AGENTS.md`.
