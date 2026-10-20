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
  `patch-diff.ts` and `generated.ts` are shared helpers. **These must not import Vue or `node:` APIs.**
- `src/config/` — split by scope. `settings.ts` (`GlobalSettingsStore`: `.hh/settings.json` —
  listener, auth, TLS policy, host vitals, backups) and `store.ts` (`WorkspaceStore`: a workspace's
  `settings.json` + `servers.config.json`, validate/merge/atomic commit, reporting
  `configError`/`configWarnings` instead of throwing). `workspaces.ts` is the registry, `layout.ts`
  the refusal of a pre-workspace `$HHOSTED_HOME` (0.8.0 dropped the relocation itself). `schema.ts`
  holds the three on-disk shapes plus the `meta` stamp, `parse.ts` the tolerant readers, `patch.ts`
  the merge helpers, `migrations.ts` the schema constant and ordered step registry,
  `secrets.ts`/`seed.ts` the secret scopes and seeds.
- `src/providers/` — stateless leaves returning plain data: `process` (spawn, `terminate`,
  `terminatePid` for an adopted process), `port` (probe, holder lookup, `terminatePids`), `proc`
  (sampler, `processCarriesServerId`, `processTreePids`), `identity` (which port holder is this
  entry's own successor), `nanny` (a persistent entry's spec/state files and liveness rules),
  `log-tail` (offset reader surviving rotation and truncation), `ddns/` (one provider per registrar),
  `proxy/` (the engines this build can drive — the route model stays the panel's), health-check,
  host, telegram, archive.
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
  `capture-media.mjs`, `dev.mjs`. **Five that *gate* something:** `typecheck-uis.mjs` (the UI
  typecheck inside `test:types`, exits 1), `check-release-version.mjs` (may a release be
  dispatched), `release-notes.mjs` (the release body), `check-doc-links.mjs` (the links in the docs
  that ship), `stamp-uis.mjs` (the pre-commit version bump).
- `docs/` — the topic docs, `mockups/*.html`, and `media/*` regenerated by `pnpm run media`. Only
  the `.md` files are published; media is a build artifact.

## Why `src/shared/proxy-form.ts` exists

`uis/stock` and `uis/noc-console` had **40 byte-identical declarations**, and eight commits touched
both files — one literally "carry the fix into the other UI". One module now holds the route draft,
the save patch and the checks the panel would otherwise answer with a 400.

**Nothing in it may import Vue**: the UIs bundle Vue as a devDependency while the published package
does not ship it, so `cloneRoutes` (which needs `toRaw`) stays in each UI.
`test/shared/ui-parity.test.ts` fails if any consumer re-declares a shared member — the UIs **and**
`src/**`, because `services/proxy.ts` once kept its own `isPublicHost`/`LOCAL_TLDS` beside the shared
pair and the bodies had already diverged (the shared copy trims the host, the panel's did not).

## Why `src/shared/shape.ts` has one predicate

`isRecord` was defined nine times — seven strict, two that accepted an **array** because
`typeof [] === 'object'`. A caller reading a property off an array gets `undefined` rather than a
failure, and `Object.entries` yields the *indices*. The `!Array.isArray` half is load-bearing and
pinned directly. The parity guard matches the predicate's **body**, not its name, because a
name-based search missed the copies called `isPlainObject`, `isBootAttempt` and one inline ternary.

## What else both UIs share

Seven more modules, each created because the same code existed twice — the class above, found again:

| module | what it replaced |
| --- | --- |
| `server-key.ts` | `serverKey` was defined **three** times: `services/events.ts` (which dispatches SSE) and each UI's composable (which subscribes). Byte-identical by luck, and a change on one side would route frames to the wrong bucket **silently**. |
| `ui-format.ts` | Five byte-identical formatters, 911 duplicated characters. The cost showed inside one round: fixing `formatRatio`'s missing guard in `noc-console` left `stock` still rendering `NaN%` — and the guard then had to be fixed **twice**, which is the duplication arguing for itself. |
| `endpoint.ts` | `waitForEndpoint`, byte-identical and importing nothing. |
| `api-client.ts` | 25 identical API wrappers plus the `request` helper and `AuthRequiredError`. `request` had **already drifted** — one UI read a bare `error` field, the other did not. |
| `server-url.ts` | the "open server" link: a `lan` entry is reported at the machine's LAN address, unroutable for a viewer on a public hostname. Only the browser knows its own name, so the swap is client-side — and both UIs render that link, so one rule keeps them from disagreeing. |
| `fields.ts` | `linesToArray`/`envToText`/`textToEnv`/`commaList`, byte-identical in both UIs — and inlined a second time *inside* noc-console, so one parsing change had four places to land. Each UI keeps a re-export, so its own imports stay local. |
| `error-message.ts` | `caught instanceof Error ? caught.message : String(caught)`, written out **116 times across 61 files**. Two spellings of one idea, and the UIs are separate bundles, so a fix to one copy missed the others. |

**The rule for what belongs here, and what does not.** A module moves in when its dependencies already
resolve within `src/shared/`; it stays out when it would import *upward*. `rpc.ts` needs `AppType` from
`src/app.ts`, so it stays duplicated in each UI, and the same reasoning keeps the `ddns`/`proxy` helpers
where they are — they use Vue's `toRaw`. `formatBytes` and `formatDateTime` also stay per-UI: their
signatures and unit thresholds genuinely differ between the two products (`formatBytes` is `number` in
one and `number | null` in the other), a distinction worth keeping rather than collapsing for tidiness.

**`api-client.ts` carries its own tests, and had to.** The UIs exercised those calls *through the UI*,
so the move left the module at 25% and dropped `src/shared` below its 95% floor. **Moving code means
moving its tests.**

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

**A UI's strings live in CSV sheets, and its catalogs are generated.** `uis/<name>/i18n/sheets/` is
the source of truth — one row per string, one column per language — and `scripts/build-locales.mjs`
merges every sheet into the `i18n/generated/*.json` the app imports. That directory is git-ignored and
rebuilt by `pnpm install` and by every UI build, so a stale catalog cannot be committed; the sheets
are what a reviewer reads, and an untranslated string is a visibly empty cell rather than an absent
file.

**The sheets are sharded by key prefix, and that is about how they are read.** One 462 KB file was
returned whole by a single read — 1264 lines is under a reader's page limit — costing ~118K tokens
for one wording fix, and its three largest areas alone were 20–42K each. A sheet is named after the
key's own prefix (`settings.ddns.csv`), which makes "where does this string live" a property of the
key rather than a choice; `settings`/`proxy`/`views` shard one level deeper because they are large.
`test/i18n-catalog.test.ts` enforces the home, a per-file size budget, and — because multiple sheets
now merge, and the library's merge keeps the *last* definition silently — that no key is defined
twice.

A plural is one row per CLDR category (`key[one]`, `key[few]`, …), which `spreadsheet-i18n` cannot
fold back itself — it writes flat strings — so `build-locales.mjs` does. The generated JSON is
therefore *generated*, and neither the sheets nor the JSON is a build input a `ui.json` bump should
chase: a wording change ships a different UI, so it bumps like any other source edit.

## How to test

A component worth guarding mounts under `// @vitest-environment happy-dom`; the suite resolves `@/…`
from the UI that asks, so each UI's tests can import its own components. The commands are in
`AGENTS.md`.
