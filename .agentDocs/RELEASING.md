# Releasing

**Goal:** how a release is cut, and which version to dispatch.
**Scope:** the release workflow, the version rule, and what the package ships. The `ui.json` version
semantics are in `ARCHITECTURE.md`; compatibility rules are in `COMPATIBILITY.md`.

Dispatched from `.github/workflows/release.yml` with a version (`-f dry-run=true` to rehearse). It
verifies the version, lints/types/tests, builds the CLI and every UI zip, lets changelogen write the
changelog and bump `package.json`, commits and tags `v<version>`, creates the GitHub release with the
UI bundles attached, and publishes to npm through trusted publishing (OIDC, no token). npm only offers
a trusted publisher for a package that **already exists**, so a first-ever release has to be published
by hand.

```sh
gh workflow run release.yml -f version=<version>
```

## The README media is a separate, optional step

`-f regenerate-media=true` adds a final step after the publish: it re-renders `docs/media` (the
mockups, both UIs served by a real panel, and `tour.gif`), then commits and pushes the result to
`main`. It is **off by default**, and that is the point — a patch that changes one function should
not pay minutes and a follow-up commit to reproduce the same GIF. Turn it on when the UI moved, or
when the tour is simply stale.

Two reasons it runs *after* the publish rather than before:

- **Nothing it produces ships.** `docs/media/*.png` is gitignored and `package.json#files` does not
  include the directory; only `tour.gif` is committed, and the README references it at its GitHub
  path, which npm rewrites to the repository URL. The published tarball cannot be affected, so a
  failure here cannot invalidate a release that already succeeded.
- **A failure is its own red step.** A weak render (tofu boxes) or a push conflict is reported
  after `npm publish` has already answered.

The step runs `playwright install --with-deps chromium` first: the script drives a real Chromium
against `dist/cli.js`, and neither the browser binary nor its system libraries come with
`pnpm install`.

Five workflows, and the split is deliberate:

| workflow | runs on | what it proves |
| --- | --- | --- |
| `quickcheck.yml` | every push and PR | lint, types, doc links — Linux only |
| `test.yml` | every push and PR; manual dispatch | the tests a push's changes reach since the last green run (Linux); dispatched, the whole suite with coverage |
| `smoke.yml` | every push and PR; by hand | the **browser** pass: every route of both UIs at two viewports, with the pixel, placeholder and sideways-scroll checks. Nothing else here is blind to a UI defect the way `check` is |
| `cross-platform.yml` | the release gate, or by hand | the same suite on macOS and Windows |
| `release.yml` | dispatched with a version | the platform gate, the browser pass, then tag, publish, release assets |

**The browser pass runs before anything is published, in the release workflow as well as on a push.**
Chromium installed only for the optional media regeneration runs *after* `npm publish`, so a defect it
could have caught is reported on a release that already shipped.

The platform gate is not a per-push job on purpose: it is the expensive half, and it is what makes a
platform-specific break fail before shipping rather than on someone's machine. Every job carries a
`timeout-minutes`, so a wedged runner is reported instead of sitting out GitHub's 6-hour default.

**Check it ran on the commit you are shipping, not on one you recognise.** A green platform run is a
claim about *that sha*, and one twelve commits behind says nothing about the tree you are releasing.

    gh run list --workflow cross-platform.yml --json headSha,conclusion | grep "$(git rev-parse HEAD)"

If the sha is not there, dispatch it (`gh workflow run cross-platform.yml --ref <branch>`) and wait. That
is the one gate whose result cannot be inferred from a local run.

**Read the skip count, not just the tick.** Linux has no skips; macOS and Windows report a handful
(Windows more), all from platform guards. What to watch is the *shape*: a new skip appearing, or a
clean pass where a guard should have fired. **A test that returns early instead of skipping reports a
pass**, hiding a platform that never ran the code — use `it.runIf`/`it.skipIf` with the condition
computed at **module load**.

**`npm publish` exiting 0 is the whole answer.** The registry can take up to ten minutes to show a
package it has accepted — npm's queue, not this run's. Do not poll it, and do not hold work waiting.

## Before you dispatch: the findings are closed

**A release is not a checkpoint, it is a claim that this version is good.** Every finding from the
review of the work — including the ones ranked minor — is fixed, or explicitly deferred with the
user's agreement, *before* the version is dispatched. Shipping a known defect and patching it an
hour later is not a fast fix: it hands someone the broken version first, and `latest` is what they
install.

The trap is judging a finding "too big for this change". That is never a reason to ship it. It is a
reason to say so and let the scope be decided. Measured once, the hard way: 0.9.0 went out with two
known majors from its own review and was patched as 0.9.1 ninety minutes later.

So the pre-dispatch check is: read the review's findings list top to bottom and account for every
line. "Addressed in a follow-up" is only true if the user chose the follow-up.

**What to walk before dispatching.** Run these against a built panel on a scratch `HHOSTED_HOME`, in a
browser, at 1280x800 and at ~390px:

- **Every mutating action**, not every page: add/edit/delete a server, start/stop/restart, free-port,
  edit a config and reload to see it persisted; change a value in each settings group and reload;
  create a job and read its log; create a backup and open the restore tree; add a proxy route; mint and
  revoke an account.
- **A save that reports success must read back** from the panel, not from the field.
- **One non-English language**, chosen in Global settings — it is per-browser, not a panel setting.
- **Logs out, then in again**, and confirm a revoked session stops working.
- `/openapi/spec.json` and `/openapi/ui` load.
- `pnpm run smoke` against the panel it is meant to check.

Not reachable on a laptop, so say so rather than implying otherwise: compose/Docker lifecycle (needs a
daemon), full ACME issuance (needs a public name), and CPU temperature in a WSL2 guest (needs the
optional Windows helper).

**Three of those are now commands**, so a dispatch starts with them rather than with a browser:

```sh
pnpm run check                 # lint, types, doc links, the suite, coverage floors
pnpm run verify:actions        # boots its own panel: every mutating action, read back from the API
pnpm run audit:auth            # against a running panel: no write route open, a session reaches it
pnpm run smoke                 # built panel + both UIs in Chromium, two viewports
```

`verify:actions` and `audit:auth` cover between them what the manual walk above describes — a save that
persists, a credential that is refused, a lifecycle that reaches the state it promised. `smoke` is the
one that needs a browser and the only one that sees layout.

**One security rule is worth driving by hand**, because it is the one whose failure is silent: start the
built panel on a LAN bind with a secret shorter than 12 characters and confirm it **refuses**, naming the
fix:

```sh
HHOSTED_HOME=/tmp/exp node dist/cli.js up --port 6968 --host lan
# error refusing to start: can't listen on lan with a secret shorter than 12 characters …
```

Then repeat with a 12+ character secret and confirm it starts. `checkExposure()` is asserted in tests, but
the value of re-running it against the built binary is that it exercises the startup guard rather than
the function.

**Then verify the release machinery itself**, which fails at dispatch time rather than in the gate:

```sh
node scripts/check-release-version.mjs 0.16.0   # exits 0, prints the bump
node scripts/check-release-version.mjs 0.13.2   # exits 1 while a breaking commit is pending
node scripts/release-notes.mjs 0.16.0           # exits 1 until changelogen writes the section
```

The third failing **before** the dispatch is correct, not a defect: `release-notes.mjs` runs after
changelogen in the same job, so the `## v0.16.0` section exists only once the release has bumped. Run it
to see the diagnostics it gives when the section is missing, and do not "fix" it by hand-writing a
CHANGELOG entry.

## The migration reaches the release body, not just git

`CHANGELOG.md` is derived from commit subjects, so it names *what changed* and never *what a person
must do about it*. Two failures follow from relying on it: a `fix(auth):` commit with no `!` is not
even listed as breaking, and a `BREAKING CHANGE:` footer's prose stays in git.

So the migration lives in `.agentDocs/UPGRADING.md`, one `## <version>` section, and
`scripts/release-notes.mjs` lifts those sections above the commit list when building the release body.
Write it when the release needs it and skip it when it does not — a version with no section ships
the changelog alone.

**One release, one section.** The body carries every section up to the released version, oldest
first, so a version cannot go out with an earlier migration missing — but the *authoring* rule is one
section per release, for the version actually being dispatched. If the work lands as one release,
write one section however many distinct migrations it contains, or a dispatch ships several changes
and prints the migration for one. `test/scripts/release-notes.test.ts` pins the selection behaviour.

## Which version to dispatch

Below 1.0 the **minor is the breaking channel**: a fix or non-breaking feature is a **patch**, while a
minor means someone has to read the release notes and act. A `feat:` commit does not decide this — ask
what the user has to do about it. Never edit `package.json` by hand; changelogen bumps inside the
workflow. `scripts/check-release-version.mjs` refuses a patch while a breaking commit is pending.

**The one exception, asked for by name.** When the removal is real but narrow — nothing published
depends on the old shape, and leaving the fix unshipped costs more than the version number is worth —
dispatch with `allow-breaking-patch: true`. It prints the breaking subjects either way, so the choice
stays visible in the run log rather than looking like a slip.

## What the package ships

`pnpm pack` runs `prepack` (a full build) and ships the `files` list in `package.json`: `bin/`,
`dist/`, `uis/stock/dist`, `README.md`, the **ten** user-facing `docs/*.md` (`API`, `BACKUPS`, `CLI`,
`DDNS`, `JOBS`, `NOTIFICATIONS`, `REVERSE_PROXY`, `SECURITY`, `SERVERS`, `UI_CREATION`), the
`docs/branding` and `docs/demo` assets, and `LICENSE`.

**Every doc a shipped doc links to must itself be in `files`.** A doc missing from the list is a 404
for an npm user following a link from one that shipped, and `check-doc-links.mjs` reads the working
tree where the file exists, so only the `npm pack --dry-run` tarball answers it. Name the files rather
than a count, which drifts. **`AGENTS.md` is not in that list** — the
`files` array omits it, so it is repo-only like `.agentDocs/`, even though it is not gitignored.
Neither is published: both are for agents working in this repo, so a pointer from `AGENTS.md` into
`.agentDocs/` is dead in an installed copy, and a reader who installs the package never sees either
one.
Verify a claim about the tarball with `npm pack --dry-run`, which prints the real contents, rather
than by reading the `files` array: an entry there can name a directory whose contents are narrower
than it looks.

**`--dry-run` proves what is *in* the tarball, not that it *runs*.** Those are different failures and
only the second reaches a user. `pnpm pack`, then install the `.tgz` into an empty project and check
that `./node_modules/.bin/home-hosted --version` answers, `up` serves the stock UI at `/`, and
`/openapi/spec.json` answers `200` — `prepack` builds into the working tree, so the repo looks
complete either way. The bin falls back to tsx so `pnpm link` works before a build; `vue`/`vue-router` are
devDependencies because the UIs are prebuilt.
