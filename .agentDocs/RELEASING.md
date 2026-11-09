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

Four workflows, and the split is deliberate:

| workflow | runs on | what it proves |
| --- | --- | --- |
| `quickcheck.yml` | every push and PR | lint, types, doc links — Linux only |
| `test.yml` | every push and PR; manual dispatch | the tests a push's changes reach since the last green run (Linux); dispatched, the whole suite with coverage |
| `release.yml` | manual dispatch | cross-platform, then lint, types and the whole suite **with coverage** — the coverage floors' automatic gate |
| `cross-platform.yml` | the release gate, or by hand | the same suite on macOS and Windows |
| `release.yml` | dispatched with a version | the platform gate, then tag, publish, release assets |

The platform gate is not a per-push job on purpose: it is the expensive half, and it is what makes a
platform-specific break fail before shipping rather than on someone's machine. Every job carries a
`timeout-minutes`, so a wedged runner is reported instead of sitting out GitHub's 6-hour default.

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

## The migration reaches the release body, not just git

`CHANGELOG.md` is derived from commit subjects, so it names *what changed* and never *what a person
must do about it*. Two failures follow from relying on it: a `fix(auth):` commit with no `!` is not
even listed as breaking, and a `BREAKING CHANGE:` footer's prose stays in git.

So the migration lives in `.agentDocs/UPGRADING.md`, one `## <version>` section, and
`scripts/release-notes.mjs` lifts that section above the commit list when building the release body.
Write it when the release needs it and skip it when it does not — a version with no section ships
the changelog alone.

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
`dist/`, `uis/stock/dist`, `README.md`, the ten user-facing `docs/*.md` (`API`, `BACKUPS`, `CLI`,
`DDNS`, `NOTIFICATIONS`, `RESTORE_DEMO`, `REVERSE_PROXY`, `SECURITY`, `SERVERS`, `UI_CREATION`), the
three `docs/branding` and `docs/demo` assets, and `LICENSE`. **`AGENTS.md` is not in that list** — the
`files` array omits it, so it is repo-only like `.agentDocs/`, even though it is not gitignored.
Neither is published: both are for agents working in this repo, so a pointer from `AGENTS.md` into
`.agentDocs/` is dead in an installed copy, and a reader who installs the package never sees either
one.
Verify a claim about the tarball with `npm pack --dry-run`, which prints the real contents, rather
than by reading the `files` array: an entry there can name a directory whose contents are narrower
than it looks. The bin falls back to tsx so `pnpm link` works before a build; `vue`/`vue-router` are
devDependencies because the UIs are prebuilt.
