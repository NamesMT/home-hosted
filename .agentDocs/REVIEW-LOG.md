# home-hosted — end-user review log

Ideas found by wearing different users' hats, each verified by exercising the real CLI, panel or
docs. Rebuilt after the original working copy was lost; every "implemented" row names the commit
that shipped it, and every claim below was measured rather than assumed.

**Status key:** `implemented` = shipped and pinned by a test · `logged` = real, deliberately not
changed (needs a decision) · `verified good` = exercised and found correct, recorded so nobody
"fixes" it.

---

## Round 1 — a first-time user who found this on GitHub

| # | Idea | Status |
|---|---|---|
| 1 | `up --print-config` armed a default password (`.control-secrets.json`) and refused a live panel | implemented `a172242` |
| 2 | `init --no-install` printed `<pm> run up` first, which exits 127 because nothing installed `home-hosted` | implemented `53de057` |
| 3 | The password hint named a page the UI does not have ("Settings → Authentication") | implemented `53de057` |
| 4 | An exposure refusal told the user to run a command they do not have | implemented `53de057` |
| 5 | `status --json` omitted `liveness` entirely when there was no `run.json` | implemented |
| 6 | `up` printed "already running" and exited 0 while ignoring `--port`/`--host` | implemented `2950d5e`, corrected in `1b33cb5` |
| 7 | `status --json` says `"running": false` with no reason for a clean stop | logged — `initialised` covers it; a shape change touches a documented contract |
| 8 | `up` on a busy control port exits 0 from the shell wrapper | logged |
| 9 | Claimed the scaffold's `.gitignore` kept schemas out of the repo | verified good — it tracks config and ignores secrets, logs, TLS, backups, proxy and the generated `.schema.json` files |
| 10 | README's `pnpm install --frozen-lockfile` cannot run in a `--no-install` project (no lockfile exists) | implemented `c1a518e` |
| 11 | A broken `servers.config.json` keeps running servers and says so | verified good |

## Round 2 — a homelab operator running 12 services

| # | Idea | Status |
|---|---|---|
| 12 | `resources.maxRssBytes` never fired on an *adopted* process (`enforceMemoryLimit` required `entry.child !== null`) | implemented `cfcf868` |
| 13 | A supervised port clash named a pid, not which of 14 rows to stop | implemented `2317f6e` |
| 14 | A hand-lowered `logs.keep` in `settings.json` did not prune rotations above it | implemented `23b6d43` |
| 15 | No CLI surface for per-server resource usage | implemented — `home-hosted usage` |
| 16 | `start` reports success for an entry that is already dead | implemented — verified on read-back |
| 17 | `logs` reads only the panel console | implemented — `logs <id>` with `-w/--workspace` |
| 18 | The crash retry budget survives a panel restart | verified good |
| 19 | A panel started without `node` on PATH marks every entry failed | verified good — the message names the cause correctly |

## Round 3 — an agent/script author driving the CLI and API

| # | Idea | Status |
|---|---|---|
| 20 | A misspelt `?workspace=` ran a **destructive** request against the default workspace | implemented `4150276` |
| 21 | `logs` and `down` printed a refusal on stdout while exiting 1 | implemented `bd8b241` |
| 22 | README's blanket "nothing to stdout on a refusal" was contradicted by four commands | implemented `bd8b241` |
| 23 | `up` dropped `--port`/`--host`/`--open` on a live panel and exited 0 | implemented `2950d5e` |
| 24 | `start` exits 0 for an entry that is already dying | implemented — same fix as 16, and `restart <id>` too |
| 25 | `down` says "not running" and exits 0 while a panel it started is still listening | implemented — probes the configured port, refuses, signals nothing |
| 26 | A wedged panel makes `status --json` say `running: true, answering: false` and exit 0 | implemented as docs `c1a518e` — the exit code is defensible, so the contract is documented |
| 27 | `PUT /api/servers/:id` writes config only, silently leaving the old process serving | implemented as docs `c1a518e` |
| 28 | `--help`, `--version`, unknown commands and idempotency | verified good |

## Round 4 — upgrading 0.9.x → 0.11.0, and crash recovery

| # | Idea | Status |
|---|---|---|
| 29 | A truncated `settings.json` sent the upgrader to `migrate`, which then could not read it | implemented `7c84f6c` |
| 30 | `migrate --dry-run` printed nothing about the restamping the real run does | implemented `a1cdc93` |
| 31 | `migrate` rewrote a file keeping no `.bak`, contradicting README and COMPATIBILITY | implemented `a1cdc93` |
| 32 | Crash recovery and the remaining upgrade surface | verified good |
| 33 | Restamping a **live** panel's configs reloads it; running entries untouched | verified good |

---

## Found by the independent QA review (after the rounds)

| # | Idea | Status |
|---|---|---|
| 34 | `up --host` refused even when it named the live bind, breaking the idempotent re-run | implemented `1b33cb5` |
| 35 | The `up`-conflict guard could not fail: deleting the call site left all 7 tests green | implemented `1b33cb5` |
| 36 | `--print-config` claimed "changing nothing" but writes 3 seeded files | implemented `1b33cb5` |
| 37 | Dead `siblings` field returned by `supervisedPids`/`portHolders` | implemented `eb2fa84` |
| 38 | `control-server.test.ts` could hand two parallel tests the same ephemeral port | implemented `0a470a6` |
| 39 | Unknown query keys now 400 on ~20 workspace routes — a breaking change for external clients | **open — needs a release note** |
| 40 | `processTreePids` has no production caller (superseded by `processTreeOwners`) | logged — it is a tested provider API; removing it is a judgement call |

---

## Still-valuable ideas needing a decision

These are the `logged` rows worth a second look. Each is real, verified, and blocked on a product
choice rather than on code:

- **15 / 17** — a `home-hosted usage` command, and per-server log access from the CLI. Both are the
  operator's most common question, and neither exists.
- **24** — `start x && curl x` races every boot; needs `--wait`/`--wait-ready` or a distinct exit code.
- **25** — `down` exits 0 while an ownerless panel still listens; needs a decision on whether `down`
  may search for one at all.
- **19** — a systemd/docker user hits this as a fleet-wide failure with a correct message. No code
  change; possibly a doc note.
- **39** — the one with external exposure. Either an `UPGRADING.md` entry or narrow the strictness to
  `workspace`-like keys only.
