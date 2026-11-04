# home-hosted — end-user review log

Ideas found by wearing different users' hats, each verified by exercising the real CLI, panel or
docs. This file keeps what is **still actionable**; the work that shipped is in `git log` and the
one-line record below, so it is not repeated here.

## Open

Real, verified, and blocked on a product decision rather than on code.

| # | Idea | Why it is open |
| --- | --- | --- |
| 8 | `up` on a busy control port exits 0 from the shell wrapper | The direct CLI and a correctly-invoked wrapper both exit 1. What remains is npm's own `[ELIFECYCLE]` chatter around the one sentence that matters, printed twice. Arguably correct — it *is* npm reporting its child failed — but a script parsing stderr sees noise. Needs a decision on whether to suppress it. |
| 15, 17 | A `usage` command and per-server `logs` | **Done** — `home-hosted usage` and `logs <id> -w <workspace>`. Kept listed only because 15's remaining half (a per-server *resource history*, not a snapshot) is still unbuilt. |
| 19 | A panel started without `node` on PATH marks every entry failed | Verified correct: the panel has Node by definition (`process.execPath`), children inherit `PATH`, and `describeSpawnError` names the cause. A systemd/docker user hits it fleet-wide, so a docs note may be worth it. No code change justified. |
| 40 | `processTreePids` has no production caller | It is a tested provider API superseded by `processTreeOwners`. Removing it is a judgement call, not a defect. |

## Shipped — one line each, the commit carries the reasoning

| # | What was wrong |
| --- | --- |
| 1, 2, 3, 4 | `up --print-config` armed a default password and refused a live panel; `init --no-install` led with a step that exits 127; a hint named a UI page that does not exist; an exposure refusal named a command the user lacks |
| 5 | `status --json` omitted `liveness` when there was no `run.json` |
| 6, 23 | `up` dropped `--port`/`--host`/`--open` on a live panel and exited 0 |
| 7 | A clean stop and a crash were separable only by inferring from absent keys — now `exitedCleanly` |
| 9 | The scaffold's `.gitignore`, claimed unsafe, is correct: config tracked; secrets, logs, TLS, backups, proxy and generated schemas ignored |
| 10 | `--frozen-lockfile` cannot run in a `--no-install` project |
| 12, 13, 14 | Memory ceiling never fired on an *adopted* process; a port clash named a pid rather than the row to stop; a hand-lowered `logs.keep` did not prune |
| 16, 24 | `start`/`restart <id>` reported success for an entry already in its crash loop |
| 20 | A misspelt `?workspace=` ran a **destructive** request against the default workspace |
| 21, 22 | Refusals printed to stdout while exiting 1; the README overstated the `--json` promise |
| 25 | `down` said "not running" and exited 0 while a panel still listened |
| 26, 27 | A wedged panel passed a readiness gate; `PUT` wrote config and left the old process serving — both now documented contracts |
| 29, 30, 31 | A truncated `settings.json` sent the upgrader to `migrate`, which could not read it; `migrate --dry-run` printed nothing about work the real run did; `migrate` kept no `.bak` |
| 34, 35, 36 | `up --host` refused even when it agreed; the guard could not fail; `--print-config` claimed "changing nothing" |
| 37, 38 | Dead `siblings` plumbing; two tests racing for one ephemeral port |
| 39 | Unknown query keys now 400 on ~20 workspace routes — documented in `UPGRADING.md` for 0.11.1 |

## Verified good — recorded so nobody "fixes" them

Broken `servers.config.json` keeps running servers and says so · the crash retry budget survives a
panel restart · a panel without `node` on PATH fails with the right message · `--help`, `--version`,
unknown commands and idempotency · crash recovery and the 0.9→0.11 upgrade surface · restamping a live
panel's configs reloads it without touching a running entry.
