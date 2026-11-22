# Release review: `0.16.0`

**Status: mechanical pass done, independent review still outstanding.**

This file is the deliverable `task-1` describes. It currently holds what the root agent could verify
mechanically — page loads, section presence, layout, console errors — which is evidence rather than
opinion. It is **not** the independent review: a same-agent pass cannot contradict the agent that wrote the
code, and `RELEASING.md` requires that review's findings to be accounted for before a dispatch.

An independent reviewer should treat the section below as a baseline to check, not as done work, and add
findings above it.

## Browser tooling for the reviewer: Playwright, not bsk

`task-1` originally said *"bsk tools are available and verified working"*. **They are not usable here**, and
the task has been corrected. Measured twice:

- `bsk status` answers *"cannot start an independent Windows daemon; the Job Object of this process does not
  allow breakaway … Access is denied (os error 5)"*.
- `bsk.exe daemon start --foreground` **does** bring a daemon up from a background job, and `bsk status
  --json` then answers — but `bsk_session start` still fails with **"no browser is currently connected"**.
  Attaching one needs a human to open the browser-skill extension and wait for "connected".

**Playwright is installed and works** (`chromium.launch()` succeeds), and it is what `pnpm run smoke` uses,
so a finding reproduces in CI. That is the supported path.

## Mechanical pass (root agent, built panel, Playwright)

Panel: `HHOSTED_HOME=/tmp/hh-mech node dist/cli.js up --port 6993`, stock UI from the package.

| Route | h1 | Content | Console errors |
| --- | --- | --- | --- |
| `/global/settings` | Global settings | 7 601 chars | 0 |
| `/w/default/settings` | Workspace settings | 4 071 chars | 0 |
| `/w/default/servers` | Servers | 677 chars | 0 |
| `/w/default/jobs` | Jobs | 453 chars | 0 |
| `/w/default/logs` | Logs | 735 chars | 0 |
| `/proxy` | Reverse Proxy | 2 940 chars | 0 |
| `/global/overview` | Global Overview | 1 181 chars | 0 |
| `/openapi/ui` | home-hosted API | 4 746 chars | 0 |

**Settings sub-sections, all present:** `/global/settings` carries Listener, Authentication, Host vitals,
Backups, TLS, Language, Interface, Paths (8/8); `/w/default/settings` carries Server defaults, Logs,
Notifications, Dynamic DNS (4/4).

**Narrow viewport (390 × 844):** no sideways document scroll on the three text-heaviest pages
(`global/settings`, `w/default/settings`, `proxy`) — 0 px overflow on each.

**Long-language probe:** switched the UI to German through its own selector, then re-checked at 390 px.
Headings render as *Globale Einstellungen*, *Arbeitsbereich-Einstellungen*, *Reverse-Proxy* — the long
compounds — with **0 px** sideways overflow and no console errors.

## Mutating actions (root agent, same pass)

The review task points at these because the page-load pass above could not reach them. Driven with
Playwright against the built panel, `HHOSTED_HOME=/tmp/hh-mut`, port 6994.

**Add a server, end to end — works.** The dialog is a **two-step wizard**: it opens on a preset picker
(Minecraft, Jellyfin, Node, Python, each with a sentence about what to change), and the form is
`v-show="!showPresets"` — `display: none` until a preset is chosen. Two readings of mine were wrong before
that was clear: the first said "dialog has 1 visible field", the second "the form has zero size, it is a
bug". Both were the first step of a working wizard.

After picking **A Node app**, filling `demo` / `Demo app` / port `7985` and submitting:

- the server appears in the list;
- it **survives a reload**;
- and it reached the config file with every field intact —
  `demo  command=node port=7985 label=Demo app`.

**Start — works.** The row control reads `Start`; after clicking, the row reads `running` and the workspace
counter moved `0/1`. No console errors.

**A crash is surfaced, in both places a person looks.** The Node preset pre-fills `args: ["server.js"]`, which
did not exist in my scratch working directory, so it exited 1 and gave up after its retries. The servers page
says `Crashed` / `node server.js` / `Exited`; `/w/default/logs` carries the detail — `exited with code 1 after
1s`, `gave up after 3 retries (code 1)`, `84 lines`. That is correct behaviour for a broken entry, and the
reporting is the useful kind.

**One routing note for the reviewer, not a defect:** there is no per-server logs control on the servers page;
logs are the workspace route `/w/<id>/logs`. If a finding is "I cannot find the logs", look there.

## Global settings save — verified (root agent, same pass)

**A panel-wide setting saves, persists and lands in the file.** Changed *Panel name* (`#v-38`, the last text
field on `/global/settings`) to `Renamed panel`, pressed **Save settings**, reloaded the page: the field reads
`Renamed panel`, and `settings.json` carries `control.label: "Renamed panel"`. No console errors. The page
also marks itself dirty correctly — *Discard changes* appears once a field is edited and *No unsaved changes*
once the save returns.

**One probe of mine was meaningless, and it is the shape to avoid.** My first attempt picked `#v-11` — the
fourth number input, which I *assumed* was the session TTL — filled `1234`, saved, and found `sessionTtlMs`
absent from `settings.json`. That reads exactly like "the save silently dropped my change". It did not:
`sessionTtlMs` lives under `auth`, not `control`, and `#v-11` was some other field entirely. The fields carry
**generated ids** (`v-7`, `v-11`, `v-38`, …) and no `name`, so the only way to know which is which is to read
the label beside it — which is what the last run does, and what any future probe must do first.

## Switch state, error association and dialog focus — verified (root agent, same pass)

Three candidates from the accessibility seam, driven in Chromium. **All three are correct.**

- **Six switches on `/global/settings`** carry `role="switch"`, are named by their own label text through
  `aria-labelledby`, and report an `aria-checked` that matches the setting — and it *updates on click*:
  measured `false → true → false` across two clicks, with no console errors. (`SwitchRoot` from reka-ui
  supplies the role and the state pair; the code only had to name it, which it does.)
- **`aria-labelledby` is used once**, in `ToggleSwitch.vue`, and the id it names exists.
- **Dialog focus** — the add-server dialog moves focus *into* it on open (`activeElement` inside
  `[role="dialog"]`), Escape closes it, and focus returns to the button that opened it (`Add a server`).
  That is the whole focus contract, working.

## Translations are complete and clean (root agent, same pass)

The last candidate on the accessibility axis, and the one most likely to hide a quiet failure: a missing
translation falls back to English, so it *looks* fine to an English reader.

Measured across all 30 stock sheets:

- **1 511 non-plural rows, zero empty cells** — every string present in all 9 languages.
- **Plural rows carry exactly the CLDR categories each language uses** and no more. The 80 "empty cells" a
  naive count reports are `[few]` on German, `[many]` on Japanese — categories those languages do not have.
  Checking each language against its own required set: **zero gaps**.
- **1 349 keys referenced from templates, zero undeclared** — no `t('…')` reaches a key the sheets lack.
- **Zero dead keys.** 36 looked unused on a first pass; all but 9 were referenced as data (`labelKey: …`
  in `src/services/backups.ts`) or built by concatenation (`t(\`job.weekday.${day}\`)`,
  `tc(\`proxy.retry.in${unit}\`)`).

That third point is the one worth repeating: **a literal-only grep for `t('key')` reports 177 dead keys
that are all live.** Check the data-style and template-literal references before deleting a string.

## The i18n guards were already right — my manual scan was the naive one (root agent)

Last round's commit recorded a manual i18n sweep and concluded *"do not delete a string because a literal
grep cannot find it"*. Reading `uis/stock/test/` afterwards: **`i18n-unused.test.ts` already does exactly
that**, and does it better.

- It scans `uis/stock/src` **and** `src` — the same correction I made by hand.
- It extracts the built prefixes from the source itself (`` /`([a-z][\w.]*)\$\{/ ``) instead of hardcoding
  them, so `t(\`job.weekday.${day}\`)` and `tc(\`proxy.retry.in${unit}\`)` are covered when they are written.

Four guards, 39 tests, all green:

| Guard | Tests | Covers |
| --- | --- | --- |
| `i18n-catalog.test.ts` | 22 | every sheet has every locale column, placeholders match, no short rows |
| `i18n.test.ts` | 11 | the runtime catalog itself |
| `untranslated-copy.test.ts` | 5 | copy in `.vue` templates that never reached a sheet at all |
| `i18n-unused.test.ts` | 1 | a catalog row nothing reads |

`noc-console` has no copy guards and does not need them: it is **English-only and inline** by design
(`AGENTS.md`, and it has no `i18n/` directory at all).

So the i18n axis was covered before this audit began. What last round's commit adds is still worth having —
it is a record of the measurements — but it is not a fix, and it should not be read as one.

## The platform-premise audit is clean — one test was the only gap (root agent)

After `nanny.test.ts` went red on Windows for relying on POSIX pipe inheritance, the obvious question was
whether another test carries a platform-sensitive premise without the guard its neighbour has.

Swept every test touching a POSIX-shaped mechanism (`SIGKILL`, `SIGTERM`, `/proc/`, `chmod`, `symlink`,
`detached`, `stdio: 'inherit'`) — ten files. **The nanny test was the only one missing a guard**, and it is
fixed. What the rest actually do:

- `supervisor-survivor.test.ts`, `supervisor.test.ts`, `supervisor-persistent.test.ts` — detached children with
  **`stdio: 'ignore'`**, which inherits no pipes, so the Windows handle-duplication problem does not arise.
  They exercise `processLiveness`, which branches per platform in `src/providers/identity.ts`.
- `supervisor-health.test.ts` — sends a real `SIGTERM`, which on Windows is `TerminateProcess` and works. Its
  own comment records that the exit is **driven from the test rather than by a timer in the child**, because a
  fixed delay raced the first probe on Windows: *"measured on Windows"*.
- `dev-path.test.ts`, `tls.test.ts`, `proxy.test.ts` — already branch on `process.platform`.
- `panel.test.ts` — mentions `SIGKILL` only in comments describing what `stopEntry` returns.

CI history since the fix: every run green on Windows, macOS and Linux.

## `COMPATIBILITY.md` holds, claim by claim (root agent)

The one in-repo doc that had never been read against the code. Every testable claim in it is accurate.

**Migrations** — driven on scratch homes:

- A **restamp** writes `.bak`, needs **no consent**, and succeeds with no TTY (`1 file(s) stamped`, exit 0).
- A **schema step** refuses without consent and names the flag:
  *"1 migration(s) to 1 file(s) and this session cannot ask. re-run with --yes…"* — then with `--yes` folds
  `notifications.telegram` + `webhooks` into `destinations`, bumps `meta.schema` to 2 and keeps the `.bak`.
  The consent distinction the doc describes is real, in both directions.
- An **unreadable config** is refused rather than overwritten, and the message names the file and the parse
  error. The bytes stay untouched.

**The metrics scrape** — `GET /api/metrics` serves six series, **all `gauge`, zero `_total`**:
`hh_control_up`, `hh_servers`, `hh_host_{disk,memory,swap}_used_percent`, `hh_host_load1_per_cpu`.

**The UI frame** — `backups.entries` and `backups.files` are genuinely **absent from `/api/state`** and served
by `GET /api/backups`; both are declared **optional** (`'entries?'`, `'files?'`) so a newer schema parses an
older panel's payload. That is the exact shape the doc says keeps an old-UI pairing from being a defect.

## `READINGS.md` holds; `ARCHITECTURE.md` had one stale count (root agent)

The last two in-repo docs. One stale number found, nothing else.

**`READINGS.md` is accurate**, checked against the code and a live panel:

- **`STALE_INTERVALS = 3`** in `src/services/host-monitor.ts`, and `view` does publish `emptyHostView` past
  it — the "three sampling intervals" the doc names.
- **`enabled: false` and a stale sample both land in `hostReadings`**, not on the wire:
  `sampled = sampledAt !== null && enabled !== false`, and both paths return `NOTHING_SAMPLED` with
  `staleSince` kept, so a surface can say "last sampled 4m ago".
- **`unmeasured`** is populated in `src/providers/host.ts` (`win32` → `load`, plus a null memory or swap
  read) and the **wire value stays `0`** via `?? 0`, so an older UI's `.toFixed()` still works. `hostBreaches`
  skips every one of the three. A live Linux panel carries **no** `unmeasured` key at all, which is right.
- The scrape serves six series, all `gauge`, none ending `_total`.

**`ARCHITECTURE.md` had one stale number.** It said `src/cli.ts`'s static imports "stay node builtins, citty
and the same **two** path-free local modules". There are **seven**: `cli/args`, `cli/io`, `cli/nearest`,
`shared/api-scopes`, `shared/error-message`, `helpers/runtime`, `helpers/version`. The **rule** it states is
intact and enforced — `test/cli/isolation.test.ts` asserts "imports only path-free modules statically" by
rejecting any static `#src/helpers/paths`, `#src/config/*`, `#src/services/*`, `#src/providers/*` or
`#src/api/*` import, and passes. Only the count had drifted, so the sentence now names the seven.

## The published package and the OpenAPI document both validate (root agent, same pass)

Two checks against the **outside world** rather than against the repo itself, which is where the `0.13.1`
divergence was found.

**`npm pack --dry-run`** produces a working tarball: **422 files, 2.6 MB packed / 9.4 MB unpacked**, of which
225 are `dist/types` and 144 are `dist/chunks`. Every entry in `package.json#files` exists on disk, and all
ten `docs/*.md` are listed. The 225-file type tree is what *"typed from the panel's own routes"* costs —
`dist/types/client.d.ts` imports `./app.js` to expose `AppType` — so it is deliberate, not bloat.

**The doc-link check was already right about the tarball**, and its docblock records why: it *was* a second
hand-written copy of the `files` list, drifted when `docs/JOBS.md` was added to neither, and four shipped
documents linked to a file that never reached the package while the checker reported everything fine. It now
derives the shipped set from `package.json#files`. `all relative links resolve in 11 shipped and 8 in-repo
docs`, zero problems.

**The OpenAPI document is valid.** `@redocly/cli lint` on `/openapi/spec.json` answers *"Your API description
is valid"* for OpenAPI **3.1.0**, with seven warnings:

- five `no-ambiguous-paths` on `/_hh/jobs/secrets/{id}` beside `/_hh/jobs/{id}/…`. **Theoretical only**:
  measured, `/_hh/jobs/secrets/log` and `/_hh/jobs/secrets/x` both `404`, so nothing misroutes — and a job
  genuinely named `secrets` is reachable through `/api`, where `POST /api/jobs` accepts it (`201`) and its
  log reads (`200`). Only the `/_hh` CLI alias would be shadowed.
- one `info-license` (no `license` field in `info` — the package has a `LICENSE` file, the spec does not
  declare one).
- one `no-unused-components` on `SseMessage`, exported for the client's `.d.ts` but never `$ref`'d in the
  document, because SSE frames are not response bodies. Correct.

## The README's quick start works, driven command for command (root agent)

The path a new user hits first, run verbatim on a clean home rather than read:

| Step | Result |
| --- | --- |
| `up` | prints `password jjnd-zb8m-zvn8 — the first-run password` and the log path, as documented |
| `add web --port 4000 -- node server.js` | `added web`, then `not started — \`home-hosted --home '/tmp/hh-qs/home' start web\`` |
| `start web` | `started web`; `ls` shows `running  4000  node server.js`, and `http://127.0.0.1:4000` answers `200` |
| `secret set web DATABASE_URL` **before declaring it** | refused: *"DATABASE_URL is not declared in web's secretEnv — add it to the entry's `secretEnv` first (declared: none)"* — which is what the README's parenthetical tells the reader to expect |
| after declaring `secretEnv` | `set DATABASE_URL on web`; the value appears **in `.secrets.json` at mode 600** and **nowhere in `servers.config.json`**, exactly as the sentence claims |

Two notes for the reviewer, neither a defect:

- The `add` hint carries `--home` because `invocation()` supplies it — that fixes the failure mode the command-hint guard exists for, and it reads correctly here.
- A server whose command binds no port stays `starting` rather than `running`, which is right: the readiness probe has nothing to answer it. My first fixture was a bare `setInterval`, so this looked like a stuck state for a moment; a real listener moved it to `running` on the next restart.

## What this pass did NOT cover

- Every action a person takes: add/edit/delete a server, start/stop/restart, the config editor, presets,
  job create/run/secret-env, backup create/list/restore dialogs, proxy route editing, account management,
  the activity feed. The form-save path is covered by `pnpm run smoke` (it saves a settings value and reads
  it back), but nothing else is.
- The other eight stock languages (only German was probed).
- `noc-console`, which `pnpm run smoke` walks in CI but which this pass did not.
- Anything requiring a docker daemon or a public name (compose lifecycle, full ACME issuance).

## Verdict

**Not this file's call.** The mechanical baseline is green; the dispatch still needs an independent
reviewer to walk the actions above and record findings.
