# Architecture — per-file rationale

**Goal:** why each module exists and what it owns, so a change lands in the right file.
**Scope:** module responsibility and the decisions behind it. Runtime rules stay in `AGENTS.md`;
state layout is there too.

## Layout

- `src/cli.ts` — the CLI's thin root. Two things happen before [citty](https://github.com/unjs/citty)
  is asked anything: `--home`/`--project` are peeled off and applied (`src/cli/args.ts`), and the
  curated dispatch — `help`/`version`, `unknown command`, and the `-p 4000` shorthand for `up` — is
  decided, because `#src/helpers/paths.ts` resolves at import time. Its static imports stay node
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
- `src/api/**` — one file per URL group (`$.routes.ts` = several routes), mirroring the path.
- `src/shared/` — the only code both `src/` and the UIs read. `contracts.ts` holds every ArkType
  schema (config, API and SSE DTOs); the OpenAPI spec is generated from it. `shape.ts` is the
  plain-object predicate. `proxy-form.ts` is the reverse-proxy form both UIs edit. `patch-diff.ts`
  and `generated.ts` are shared helpers. **These must not import Vue or `node:` APIs.**
- `src/config/` — split by scope. `settings.ts` (`GlobalSettingsStore`: `.hh/settings.json` —
  listener, auth, TLS policy, host vitals, backups) and `store.ts` (`WorkspaceStore`: a workspace's
  `settings.json` + `servers.config.json`, validate/merge/atomic commit, reporting
  `configError`/`configWarnings` instead of throwing). `workspaces.ts` is the registry, `layout.ts`
  the one-time relocation of a pre-workspace `$HHOSTED_HOME`. `schema.ts` holds the three on-disk
  shapes plus the `meta` stamp, `parse.ts` the tolerant readers, `patch.ts` the merge helpers,
  `migrations.ts` the schema constant and ordered step registry, `secrets.ts`/`seed.ts` the secret
  scopes and seeds.
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
- `src/helpers/` — paths (`dataRoot` vs `projectDir`), daemon (run.json + a loopback probe that
  bypasses `fetch`, so TLS with a self-signed pair still answers), error, validator, atomic,
  template, env-file, openapi, factory.
- `uis/<name>/` — a Vite app (Vue 3 + Tailwind v4) built through `uis/vite.shared.ts`; `stock` is
  the one shipped in the package. Aliases: `@` → that UI's `src`, `@shared` → `src/shared`,
  `@server` → `src` (**types only**). `public/ui.json` is the UI's identity.
- `bin/home-hosted.mjs` — the published bin: `dist/cli.js`, or `src/cli.ts` through tsx when the
  build is missing (a linked checkout).
- `scripts/` — build and CI helpers: `build-uis.mjs`, `typecheck-uis.mjs`, `capture-media.mjs`,
  `dev.mjs`, and four that *gate* something: `check-release-version.mjs` (may a release be
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
`test/shared/ui-parity.test.ts` fails if either UI re-declares a shared member.

## Why `src/shared/shape.ts` has one predicate

`isRecord` was defined nine times — seven strict, two that accepted an **array** because
`typeof [] === 'object'`. A caller reading a property off an array gets `undefined` rather than a
failure, and `Object.entries` yields the *indices*. The `!Array.isArray` half is load-bearing and
pinned directly. The parity guard matches the predicate's **body**, not its name, because a
name-based search missed the copies called `isPlainObject`, `isBootAttempt` and one inline ternary.

## UI versioning

**`ui.json` is bumped once, when the commit is made** — not on every edit. A commit altering what a
UI *ships* (`uis/<name>/src`, `public`, build inputs — not `test/`) raises that `version`: patch for
a fix, minor for a feature, **major only for a rewrite or a restyle**. The number tells a person how
big the change is; `ui-update` prints it and holds it against the release it offers.

`unix` is that commit's epoch: `scripts/stamp-uis.mjs` runs from the pre-commit hook and refuses a
commit that changed a shipped UI without raising its version. `tag` is **stamped by
`build-uis.mjs`**, never trusted from the source file — a zip is built before its release is cut. The
release workflow passes `HHOSTED_UI_TAG`; anywhere else the build stamps `v<package.json version>`.
Do not hand-edit `tag` to chase a release; a stale one makes `ui-update` reinstall the same UI on
every boot.

## How to test

`pnpm exec vitest run` for the suite, `pnpm run quickcheck` for lint and types. A component worth
guarding mounts under `// @vitest-environment happy-dom`; the suite resolves `@/…` from the UI that
asks, so each UI's tests can import its own components.
