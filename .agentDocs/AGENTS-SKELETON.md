# Canonical AGENTS.md skeleton

Every repo under `~/mine` uses **these section names, in this order**. Repo-specific sections go
after, never interleaved. A section with nothing to say is omitted, not emptied.

| # | section | required | what goes in it |
| --- | --- | --- | --- |
| — | intro | yes | one paragraph: what this is, runtime, package name, build/test tools |
| 1 | `## Docs` | yes | the three tiers + an index of `.agentDocs/` and `docs/` |
| 2 | `## Commands` | yes | the real scripts, one per line with a trailing comment |
| 3 | `## Structure` | yes | where files live and what owns what |
| 4 | `## Conventions` | yes | how code is written at a boundary: commits, lint, imports, API rules |
| 5 | `## Rules that matter` | when non-trivial | hard rules that prevent a defect if broken |
| 6 | `## How to work here` | yes | the working method (below) |
| 7 | `## Conciseness` | yes | the pruning rule (below) |
| 8 | `## User-facing docs` | yes | README/doc rules for a person |
| 9 | `## Releasing` | yes | how a release is cut, and the version rule |
| 10 | `## Gotchas` | yes | the traps, with causes |
| 11 | `## Where to extend` | when applicable | the recipe for the common change |

**Names are fixed.** `Releases` → `Releasing`, `Deeper docs` → `Docs`, `Layout` → `Structure`,
`Fast start` → `Commands`. Renaming is free; the point is that an agent moving between repos reads
the same map.

---

## `## How to work here` — the required content

Actionable, each line a behaviour. Adapt the examples; keep the instructions.

- **Check the callers before you change anything.** Grep who uses it and which tests name it. If the
  impact is unclear, say so — do not guess.
- **Do not rewrite what you have not read.** A large section you have not understood is not yours to
  delete; ask if it is unclear.
- **Do not invent requirements.** Build what was asked. Surface what else you notice and let it be
  decided.
- **Fix the class, not the instance.** A copied helper, a rule stated twice, a guard bypassed by a
  second path is one problem: one implementation, one guard. That is the work, not a follow-up to
  ask for. Stay inside the task rather than refactoring the world.
- **Verify, and say how.** For every claim, name what you checked and in which direction. **A passing
  test is not evidence it pins anything: break the thing it guards and watch it fail.** If it still
  passes, either the test is decoration or a different guard is running — find out which. Where a stub
  cannot answer the question, drive the real thing.
- **Report risk with the change** — what could break (correctness, security, operational,
  integration), what you could not verify, and every assumption you made. An unverified claim marked
  as such beats a confident one that is wrong.
- **Missing recall of this repo?** Read this file, `## Docs` and `git log` before acting, then ask
  1–3 focused questions rather than guessing at intent.

## `## Conciseness` — the required content

**Prune verbose, keep correctness** — code, comments, docs alike.

- Code: a comment only for non-obvious *intent*, never to restate the line.
- Docs: one idea per sentence. Cut anything that would not change what a reader does.
- Delete history `git log` already holds — keep the *rule* that came out of it, not the story.
- **Never drop a caveat to save a line.** Concise means no filler, not fewer facts.

## `## Docs` — the required content

Three tiers, so a reader loads only what the task needs:

1. **`AGENTS.md`** (this file) — orientation and the rules that prevent defects. Read every session.
2. **`.agentDocs/`** — depth that would bloat this file: module rationale, traps with causes,
   compatibility rules. Read on demand.
3. **`README.md` / `docs/`** — for a person using the package, not for an agent.

Create `.agentDocs/` when a section above outgrows a screen or two: move the *reasoning* out and keep
the *rule* here with a pointer — nobody reads a file they do not open. Each document opens with a
one-line scope, and this file indexes it.
