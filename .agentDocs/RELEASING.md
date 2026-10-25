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

Four workflows, and the split is deliberate:

| workflow | runs on | what it proves |
| --- | --- | --- |
| `quickcheck.yml` / `test.yml` | every push and PR | lint, types, the whole suite with coverage — Linux only |
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

## Waiting branches: merge these into the next breaking version

<!-- TEMPORARY — delete this section once both branches are merged. -->

A branch that carries a `BREAKING CHANGE:` does not ship as a patch, so it waits for the next **minor**.
These are outstanding; the release is not the moment to discover one of them is still unmerged.

| branch | what it changes | merge when |
| --- | --- | --- |
| `feat/backup-selection-endpoint` | `entries`/`files` leave `/api/state`, SSE frames, `GET`/`PATCH /api/settings`; the selection model is `GET /api/backups`. Stock 2.24.0, noc-console 1.22.0 | the next minor |

**Before dispatching that minor:** merge the branch, re-run the gate on the merge commit, and write
the `.agentDocs/UPGRADING.md` section — the client-side migration is "read `GET /api/backups` instead of
the frame's `backups.entries`/`backups.files`". Check this table is empty afterwards and delete it.

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
`dist/`, `uis/stock/dist`, `README.md`, the five user-facing `docs/*.md`, `AGENTS.md` and `LICENSE`.
`.agentDocs/` is deliberately not published — it is for agents working in this repo, not for people
installing the package, so a pointer from `AGENTS.md` into it is dead in an installed copy. The bin
falls back to tsx so `pnpm link` works before a build; `vue`/`vue-router` are devDependencies because
the UIs are prebuilt.
