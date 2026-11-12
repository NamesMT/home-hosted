# QA review 4 — deploy + scheduled jobs

**Scope:** `git diff 446139f~2..HEAD`, i.e. `173a7c0` (feat: deploy + scheduled jobs) and `446139f`
(its docs), plus the branch tip as I found it.

**Important:** the branch moved **while this review was running**. When I started, `HEAD` was
`446139f`. It is now `0554fe1` (`docs(cron): the comment claimed a DST behaviour the code never
had`), a third commit that is not in the range I was asked to review. I read both. Everything below
is stated against the tree I actually measured, and I say which commit each finding applies to.
`446139f` is the range in the brief; `0554fe1` is a partial fix of one finding, and it is incomplete
(see BUG-1).

**Verdict: DO NOT SHIP.**

Two of the headline behavioural claims are false in code that is now on the branch: a job scheduled
in the autumn repeated hour **runs twice**, and "a stop during a deploy kills the step's whole
process group" **does not kill anything** — the step runs to completion. Neither is a doc typo; both
are observable wrong behaviour with a plausible blast radius (a nightly backup running twice, a
`git pull`/`pnpm build` sequence still mutating a tree under a service whose owner just asked it to
stop).

What is genuinely good: the cron **parser** is correct. I checked it against an independently
written brute-force oracle over 21,024,000 minutes and 1,760 `next`/`prev` calls and found **zero**
mismatches in UTC. The schema rules are enforced at every write door. Those are real and I say so
below.

---

## BLOCKER

### BLOCKER-1 — A job in the autumn repeated hour runs **twice** for one wall-clock occurrence

`src/shared/cron.ts:284-313` (`previousCronRun`) + `src/services/scheduler.ts:133-141`.

**What I did.** Ticked a real `JobScheduler` once per second across a DST fall-back in two zones,
with the schedule a person actually writes:

```
TZ=Europe/Berlin   schedule "30 2 * * *", ticks 2026-10-25T00:00Z..03:30Z
TZ=America/New_York schedule "30 1 * * *", ticks 2026-11-01T04:00Z..08:00Z
```

**What I observed.** Three runs, two of them for the same wall-clock minute:

```
New_York, "30 1 * * *" -> 3 runs:
  2026-10-31T05:30Z (01:30 EDT)
  2026-11-01T05:30Z (01:30 EDT)   <- first 01:30
  2026-11-01T06:30Z (01:30 EST)   <- second 01:30, one real hour later
Berlin, "30 2 * * *" -> 3 runs: 02:30, 02:30, 02:30
"0 2 * * *"  -> 2 runs: 02:00, 02:00
```

**Why it matters.** This directly falsifies the claim in the commit message, `docs/SERVERS.md`
("One run per occurrence"), and `src/shared/cron.ts`'s own header ("runs on the **first** only").
For a nightly backup, `0 2 * * *` means the backup runs twice on the autumn transition night — two
copies writing the same files, which is exactly the failure the overlap rule says it exists to
prevent (and the overlap rule does **not** catch it, because each run had already finished before
the next occurrence arrived). Worse, the *preceding* day's occurrence is also replayed: in the
Berlin trace the first run fired at `00:00Z` for the **previous day's** 02:30, because the search
walked backwards out of the fold.

**Root cause (measured, not guessed).** `previousCronRun` decrements with `setSeconds`/`setMinutes`
on a local-time `Date`. In the repeated hour, a local setter resolves an ambiguous wall time to the
**earlier** offset, so stepping back one minute from `02:31 CET` lands on `02:31 CEST` — an hour
backwards in absolute time. Measured directly:

```
2026-10-25T01:31:00.000Z 02:31 CET --setSeconds--> 2026-10-25T00:31:00.000Z 02:31 CEST  backwards=true
```

So `previousCronRun` is **non-monotonic** exactly once per year: at the fold it jumps backwards by an
hour (`2026-10-25T00:30Z` → `2026-10-24T00:30Z`), and the scheduler's `due <= lastStartedFor` guard
then sees a *smaller* occurrence and starts a second run. I measured 1 non-monotonic transition in
the window and confirmed the mechanism; it is not accidental.

The same defect makes `nextCronRun` return a time **at or before `from`** for the whole repeated
hour: 1800 of 10801 sampled seconds in Berlin (`00:30Z <= from` for `from` in `01:00Z..01:29:59Z`).
That is the "strictly after" contract at `src/shared/cron.ts:247-252` being violated, and it means
the **UI's next-run preview understates** — on the autumn night it shows a next run that has already
happened.

**Smallest fix.** Make the two searches operate on absolute time, not local field arithmetic: step
with `candidate = new Date(candidate.getTime() ± 60_000)` (and for the day/month jumps, re-derive the
boundary in local terms *after* the shift), then test local fields only for the match. That alone
restores monotonicity. Then pin it with the test that is missing: tick a scheduler across a fold and
assert one run per wall-clock time, in both zones. `test/shared/cron.test.ts:304` ("runs on the first
of the two autumn occurrences") tests only `nextCronRun` from *before* the fold, which is the easy
direction — the bug is on the `from`-inside / `previous` side.

**Note on the already-pushed partial fix.** `0554fe1` corrected the header prose to "skipped for that
day" (correct) and "runs on the **first** only" (still wrong, as measured above). So the new test
`test/shared/cron.test.ts:304-317` now enshrines an assertion that passes for the wrong reason: it
tests `nextCronRun` from 24 October, which does return the first 02:30 — but it never exercises the
scheduler path that runs it twice. **A green DST test that does not test the failing path is worse
than none**, because it is the evidence the claim rests on.

### BLOCKER-2 — A stop during a deploy does **not** kill the step; the step runs to completion

`src/services/supervisor.ts:455-470, 510` + `src/services/deploy.ts:110-132`.

**What I did.** Ran the real `runDeploy` with a step that sleeps, cancelled it 200 ms in, and timed
the return. Then the same through the supervisor's own cancel predicate.

**What I observed.** The step was **not** killed. `runDeploy` blocks until the child exits on its
own, and only then notices the cancellation:

```
[system] deploy 1/2: sh -c sleep 30
[probe] cancel signalled at +200ms
  [system] deploy stopped
[probe] runDeploy returned after 30011ms -> {"ok":false,"failedStep":1,"error":"the deploy was stopped"}
[probe] child exitCode=0 signalCode=null
```

**Why it matters.** The brief, the commit message, `docs/SERVERS.md:147-149` and
`src/services/deploy.ts:46-48` all claim "a stop cancels it — the step's whole process group is
killed". It is not. Concretely:

- `supervisor.deploy` stores the child in `entry.deployChild` (`supervisor.ts:468`) and **nothing ever
  kills it**. `grep -n deployChild src/` returns only the three assignments in `supervisor.ts` and the
  two declarations in `entry.ts` — there is no `forceKillTree(entry.deployChild)` anywhere.
  `runStop` bumps `runToken` and calls `killBootstrap(entry)`, which kills `bootstrapChild`, not
  `deployChild`.
- Because `runDeploy` awaits the child to exit *before* it re-checks `cancelled()`
  (`deploy.ts:110-132`), a `docker build`, a `pnpm install` or a `git pull` that holds a lock keeps
  running for its full `timeoutMs` (default **5 minutes**, or as long as the step takes) after the
  service was told to stop. The deploy sequence then correctly refuses to continue — so the "sequence
  stops" half of the claim is true — but the step itself is not stopped, and the entry reports
  `deploying: true` (via `deploy.running` on the card) until the orphaned step finally exits.
- A `POST /api/servers/:id/stop` therefore returns only after the step ends, so a stop can appear to
  hang for minutes.

**Smallest fix.** Two lines, both already half-present: call `forceKillTree(entry.deployChild)` in
`runStop` beside `killBootstrap(entry)` (the child handle and the helper both exist), and in
`runDeploy` pass `cancel.onChild` the ability to be re-invoked — simplest is to race the exit promise
against a cancellation poll, or to have the supervisor's `cancelled()` path kill the child and let the
existing `exit` handler resolve. Then assert it: a test that cancels a 30 s sleep and requires
`runDeploy` to return in < 2 s. `test/services/deploy.test.ts:100` ("stops when the deploy is
cancelled, even between steps") only cancels *between* steps, which is the path that already works.

---

## BUG

### BUG-1 — Deploy steps do not get the entry's environment; `envFile` and `secretEnv` are missing

`src/services/deploy.ts:89-92`.

The code comment says "The entry's own environment, so a step sees what the service sees — including
`dataEnvs`. Declared secrets are merged by the supervisor, which holds the store". The supervisor does
**not** merge them; `runDeploy` builds its env as `{ ...config.env, ...config.dataEnvs }` only.

Measured with an entry declaring all four layers:

```
PLAIN=from-config     <- present
FILEVAR=              <- envFile MISSING
TOKEN=                <- secretEnv MISSING
```

**Why it matters.** A deploy step is exactly the thing that needs a registry token (`pnpm install`
against a private registry, `docker login`). It silently gets an empty variable instead of an
authentication failure that names the cause, and the documented precedence
(`docs/SERVERS.md:276`: `env` < `envFile` < `dataEnvs` < `secretEnv`) is not honoured. This also
contradicts `docs/SERVERS.md:118` ("run in its working directory with its environment") — the doc is
part of the reviewed diff, so this is a doc-vs-code mismatch introduced here, not a pre-existing one.
`envFile` is additionally not even read, so `resolveTemplates`/`expandEnvRecord` cannot see it either.

**Smallest fix.** Route the step's env through the same resolution the service uses
(`resolveSpawn`'s env-building, or a shared helper) so all four layers and the template expansion are
identical; `runDeploy` already receives `config`, and the supervisor already holds `serverEnv`. Until
then, delete the claim from the comment and from `docs/SERVERS.md:118`.

### BUG-2 — "A missed occurrence runs once at boot" is false across a restart that happens *during* a run

`src/services/scheduler.ts:153-160` + `src/services/supervisor.ts:604,622`.

The catch-up rule compares the due occurrence against `history.lastEventAt(id, 'job-run')`. But a run
writes a `start` event when it begins and a `job-run` event only when it *ends*. A panel that
restarts while a long job is in flight therefore sees no `job-run` event for the current occurrence,
concludes the occurrence is owed, and starts a second copy — while the first is still running. I
modelled the exact input the panel would compute:

```
restart at 03:30 while the 03:00 run is still in flight (its start event exists, no job-run yet)
-> started runs: 1, occurrence 2026-06-10T03:00Z
```

**Why it matters.** This is the double-run the overlap rule exists to prevent, and `job-run.ts:9-14`
explicitly says a job has "no adoption — a job that outlived the panel is a stranded process". The
stranded process is exactly why the durable check is insufficient: its `start` event proves the
occurrence ran, but the code only reads `job-run`. Two backups, same files, same night.

**Smallest fix.** Consult the newest of `start` **and** `job-run` (or record a `job-run` event with
`outcome: 'running'` at start and update it at exit), i.e. `lastEventAt` over both types, taking the
max. Also worth stating honestly in the docs that a restart mid-run can duplicate the run, because a
job has no adoption.

### BUG-3 — `cronSummary` can silently drop a restricted day field, so the preview can lie

`src/shared/cron.ts:363-387`.

`cronSummary` requires `weekdayWide = !dowRestricted && daysOfWeek.size === ALL_WEEKDAYS` for the
`daily`/`monthly` branches and `!weekdayWide` for `weekly`. I probed every both-fields-restricted
form: all fall to `custom`, which is the safe answer and I confirm it is what happens for
`0 0 1 * 1`, `0 0 1,15 * mon`, `0 0 13 * 5`, `0 0 */2 * 1`. So no *wrong* sentence is produced
today — **but** the guard is only "did the field say `*`", and the `domRestricted`/`dowRestricted`
flags are computed from the raw text at `cron.ts:184-185`. That means the summary's correctness
depends on a field-level string test rather than the semantic sets, and `0 0 * * 0-6`
(`dowRestricted: true`, size 7) is reported as `weekly days:[0,1,2,3,4,5,6]` — "every Sun, Mon, Tue,
Wed, Thu, Fri, Sat", which is a seven-day week described as a list. Cosmetic, but it is the one place
a preview is generated from a string test rather than the sets, and a future `*/1`-style widening
would silently mis-summarise. Rate: BUG-adjacent; the smallest fix is to treat a full set as wide
regardless of how it was spelled (and drop the `!dowRestricted` conjunct in favour of the set test).

### BUG-4 — The Vixie OR rule is applied where Vixie does not apply it

`src/shared/cron.ts:184-185, 202-208`.

Vixie sets `DOM_STAR`/`DOW_STAR` when the field **begins with `*`**, and ORs only when *neither* is a
star. This code sets `restricted = field !== '*'`, so `*/2` counts as restricted and switches OR on:

```
0 0 */2 * 1   domRestricted=true dowRestricted=true -> rule is OR
              due Fri Jan 2 = false, Sat Jan 3 = true, Sun Jan 4 = false, Mon Jan 5 = true
```

Under Vixie, `0 0 */2 * 1` is `*/2` (a star field) OR is off, so it means **AND**: the 1st, 3rd, 5th…
only when they are Mondays. This code runs it on *every odd day*. The doc line
`docs/SERVERS.md:208` ("When **both** day fields are restricted … cron's own rule") is true for
`1`/`mon` and false for `*/2`/`1`.

**Why it matters.** `*/2` in the day field is a thing people write. It runs a job on roughly twice
the days it should, and the error is invisible until it fires. **Smallest fix:** `domRestricted =
fields[2] !== '*' && !fields[2].startsWith('*')`, same for day-of-week; or better, derive
"restrictedness" from the parsed set (`size < 31`) and document it, since a step-based day field that
widens to everything is arguably unrestricted.

### BUG-5 — The scheduler's own doc says "never two, and never none"; a stalled tick gives "none"

`src/services/scheduler.ts:17-21`.

The comment: "A tick that lands a few hundred ms late, or a panel whose loop was busy for ten
seconds, still starts exactly one run for that minute — never two, and never none."

**What I did.** Ticked at minute 0, stalled 5 minutes (which is realistic: `panel.ts:756` awaits
`hostMonitor.tick`, and `proxy.sync()` is awaited in the same loop), then resumed.

**What I observed.** The four occurrences in the gap never ran; only the current one did:

```
runs: 4 -> 00:00, 00:05, 00:06, 00:07
occurrences 00:01..00:04 skipped entirely
```

**Why it matters.** This is arguably the right behaviour (catch up one, not five — the same rule the
boot path follows), so the *code* is defensible; the **claim is not**. It is also the same shape as
the boot rule but is not what the comment promises, and a person reading the comment will not add a
guard for a stalled loop. **Smallest fix:** correct the comment to say a stall longer than one
interval skips the intermediate occurrences, exactly as a restart does; the doc sentence
`docs/SERVERS.md:218-220` ("a late tick or a busy loop still starts exactly one run for that minute —
never two") is fine within one minute but should not imply completeness.

### BUG-6 — `nextCronRun`'s `null` is a *limit*, not "never", and the message says "never"

`src/shared/cron.ts:241-276, 133-137`.

`0 0 29 2 *` is a valid leap-day expression, but the search gives up after 4 years. From 2097-03-01
the next 29 February is 2104 (a leap year after 2100, which is *not* one) — 7 years away:

```
next Feb29 from 2097-03-01 = null      (expected 2104-02-29)
next Feb29 from 2099-03-01 = null      (expected 2104-02-29)
```

The scheduler turns `null` into the standing log line "the schedule never comes due"
(`scheduler.ts:136`), and the card shows `—` for next run. For `0 0 31 4 *` the `null` is correct;
for a leap-day job near a century boundary it is wrong and the reported reason is wrong.
**Smallest fix:** either widen the limit to 8 years (cheap — the search jumps by month), or word the
message as "no run within the next four years" so it does not assert "never".

---

## RISK

- **RISK-1 — Deploy restart is outside the 409 guard.** `supervisor.ts:495-500` sets
  `entry.deploying = false` *before* awaiting `this.restart(id)`, so a second `POST /deploy` arriving
  during the post-deploy restart is accepted and starts a second sequence. The window is the whole
  restart (health-check wait included). Smallest fix: keep `deploying` true across the restart.
- **RISK-2 — A failed *restart* after a successful deploy reports the deploy as failed.**
  `supervisor.ts:498` returns `{ ok: ...restarted }`, so a deploy whose steps all succeeded but whose
  restart was refused reports `ok: false` → `DEPLOY_FAILED`, and the history event already written at
  line 477 says `outcome: ok`. Two records disagree about the same action.
- **RISK-3 — `deploy.lastOutcome` is only ever set after a run.** A deploy that is cancelled by a
  stop (`cancelled()` true) takes the `outcome.ok === false` branch and is recorded/notified as a
  **failed deploy** — the same notification class as a genuine step failure. A stop the person asked
  for is not "a failed deploy", which is the distinction the job path deliberately makes
  (`outcome: 'cancelled'`). Worth mirroring.
- **RISK-4 — `previousCronRun`'s `null` handling.** `scheduler.ts:134` treats `null` from
  `previousCronRun` as "never comes due", but `previousCronRun` also returns `null` when the *only*
  matching occurrence is more than 4 years back — and, in the fold, it returns a *stale* answer
  (measured above). The `null` branch is doing two jobs.
- **RISK-5 — History is capped at 5000 events and `lastEventAt` reads only that window.**
  `history.ts:5,36,47`. A workspace busy enough to roll the cap between two occurrences of a rare job
  loses the boot-catch-up evidence and replays. Bounded and unlikely at home, but it is the same
  "durable record" the design leans on.
- **RISK-6 — `noteJobOverlap` writes a history event per occurrence while the run is in flight.**
  A job that hangs for a day with a `*/5` schedule writes 288 `overlap` events, pushing the cap
  (RISK-5) faster. Correct-but-noisy; consider one event per busy period.

---

## NIT

- **NIT-1** `src/services/scheduler.ts:188` comment says "ends Node 24"; the toolchain here is v26.
- **NIT-2** `uis/noc-console/src/components/ServerDetail.vue:384-425`: a job still renders the `pid`,
  `uptime`, `restarts`, `port` and `probe` metric tiles (they are outside the `v-if` that adds the
  schedule row). The comment at :347 says "no pid between runs, no uptime, no probe", but the tiles
  remain and read `—` / `100%` / a sparkline. The stock card does this correctly (it *returns* a job
  row list, replacing the service rows). The noc-console did not.
- **NIT-3** `uis/stock/src/components/server/ServerCard.vue:533-546`: `jobError` and `deployError`
  are never reset when the entry changes (`runDeploy` sets `deployError` but `runJobNow` does not
  clear `deployError` and vice versa), so a stale refusal from the last press can sit under the
  buttons after a successful one. Minor, but two `<p>`s whose `v-if`/`v-else-if` interact means a
  deploy failure message and a job error can both be evaluated in one render.
- **NIT-4** `uis/stock/src/lib/format.ts:100` / `src/shared/ui-format.ts:78-85`: `relativeFrom` clamps
  a past timestamp to "now", so a stale/backwards `nextRunAt` (which BLOCKER-1 can produce) renders as
  "now" rather than "overdue". Cosmetic, but it hides the very state that matters.
- **NIT-5** `src/cli/run-deploy.ts:55-57` has a redundant double `fail(...)`: both branches of the
  `if` call `fail` with the same expression, so the first is dead code.
- **NIT-6** `docs/CLI.md:117` says offline `deploy` "runs the same steps and says nothing was
  restarted" — true, but it does **not** warn that the offline path skips the `409 DEPLOY_RUNNING`
  guard entirely, so two shells can run two deploys concurrently with the panel down.

---

## What I verified and found correct

- **The cron parser is correct in absolute time.** I wrote an independent oracle (my own field
  expansion + my own OR/AND day rule, sharing no code with `cron.ts`) and compared it to
  `cronDueAt` over **21,024,000 minutes** (2026-01-01 → 2027-12-31) for 20 expressions, plus 1,760
  randomised `nextCronRun`/`previousCronRun` calls: **0 mismatches** (`nextBad=0, prevBad=0`).
  `0 0 * * *`, `*/15 * * * *`, `0 0 29 2 *`, `0 0 31 4 *` → `null`, `30 2 * * 0`, `0 0 1 * 1` (OR,
  correct), `0 0 * * 7` ≡ `0`, `0 * * * *`, `23 0-20/2 * *`, `0 0 * jan-mar/2 mon` (→ months {1,3}),
  `5/20` → {5,25,45}, `*/7`, `0-59/60`, `1-12/2` all agree with hand computation.
- **Sunday 7 folds to 0** (`cron.test.ts:58`; measured `[0]` for `0 0 * * 7`).
- **6-field and `@macro` are refused by name**, with the count in the message
  (`"0 0 3 * * *" has 6`), and `serverKindProblems` surfaces that sentence.
- **`serverKindProblems` is enforced at every write door.** Verified by reading the call sites *and*
  by probing: `store.validateServer` (`store.ts:501`) is the single funnel for `addServer`,
  `updateServer`, `putServer`; `parse.ts:293` covers load/import; `cli/add.ts:83` and
  `cli/import.ts:117` both go through `serverCreateSchema` and then `addServerEntry` →
  `store.addServer`. A job with a `port`, a `service` with a `schedule`, a job with no `schedule`, a
  job declaring `persistent`, and a 6-field expression are each refused with a sentence naming the
  field. No door bypasses it that I could find.
- **Patch parity holds.** `serverSchema` and `serverPatchSchema` have the same key set apart from
  `id` (base-only, by design); `deploy`, `kind` and `schedule` are in both. A patch that omits `kind`
  leaves an existing job a job (`kind` stays `job` after a `cwd`-only patch) — `patch-guard.test.ts`
  is satisfied, and the "job defaults to service on a patch that omits kind" worry does not
  materialise for an existing entry.
- **The once-per-occurrence rule works at any tick rate** for ordinary schedules: `*/15` over 2 h
  gave 9 runs at a 1 s tick and 9 at a 15 m tick; a 7-day outage with a daily 03:00 job replayed
  **once** (for the most recent occurrence), not once per missed day; a restart 30 s *after* the
  occurrence did not replay it.
- **The overlap rule never queues**: `noteOverlap` records `outcome: 'overlap'` and sets
  `lastStartedFor` so the next tick is silent; a non-overlapping run finishing between ticks does not
  duplicate.
- **`restart` defaults to true** (`contracts.ts:155`), and `restart: false` skips it
  (`supervisor.ts:494`).
- **The 409 `DEPLOY_RUNNING` guard** is real for the duration of the step sequence
  (`supervisor.ts:451`), with the caveat of RISK-1.
- **A failed step does stop the sequence** (`deploy.ts:142-146` returns immediately; verified with a
  two-step probe where step 2 never ran).
- **A failed deploy leaves the running process alone** — the failure path never touches
  `entry.child`/`destroy`, and `restart` is only reached under `outcome.ok`.
- **A job may not declare `port`/`health`/`restart`/`persistent`; a service may not declare a
  `schedule`** — both refused at save, at parse, and at the CLI door.
- **`POST /api/servers/:id/run` refuses a service** with `NOT_A_JOB`, a disabled entry with
  `SERVER_DISABLED`, and an in-flight run with `JOB_RUNNING`; a non-zero exit is `409 JOB_FAILED`
  with `exitCode` in the body.
- **The `job` view block is only built for `kind === 'job'`** and the stock card *replaces* the
  service rows with schedule/next/last/exit — the stock UI does the "a job is not a service" job
  correctly.
- **`ls` NEXT RUN** is present only when a job exists in the table, and `—` without a panel (it does
  not guess).
- **History/notification wiring**: a failed run records `outcome: 'failed'` and notifies via
  `job-failed`; a stopped run records `'cancelled'` and does not notify (`supervisor.ts:610-625`).

## Three doc claims checked against the source

1. `docs/SERVERS.md:144` "A failed deploy leaves the running process alone … the card says 'this is
   still the previous version'." — **holds** for the process; **the card does not say that.** The
   card shows `serverCard.lastDeployFailed` (`ServerCard.vue:544`), which the i18n sheet renders as a
   generic failure sentence, not "still the previous version". The claim overstates the UI.
2. `docs/SERVERS.md:218` "One run per occurrence … never two." — **falsified**, BLOCKER-1.
3. `docs/SERVERS.md:118` "run in its working directory with its environment" — **falsified** for
   `envFile`/`secretEnv`, BUG-1.

Also: `docs/SERVERS.md:147-149` "the step's whole process group is killed" — **falsified**,
BLOCKER-2. `.agentDocs/UPGRADING.md:124-141` repeats the deploy/job claims; the deploy-stop claim and
"one run per occurrence" are the two it overstates. It is otherwise careful and correctly flags
`400 NO_DEPLOY` and the 6-field refusal.

## What I could not verify

- **The end-to-end HTTP path with a live panel.** I did not start the panel, bind a port, run the
  Caddy engine, or touch a real home. `POST /api/servers/:id/deploy` and `.../run` were reviewed by
  source and exercised only through `runDeploy`/`JobScheduler`/supervisor-shaped harnesses.
- **The real supervisor's deploy cancellation**, because constructing a `Supervisor` needs a store,
  hub and secrets; I established the defect by proving `deployChild` is never killed (grep) and that
  `runDeploy` does not terminate the child on cancel (measurement). The two together are conclusive
  but I did not drive `supervisor.deploy` itself.
- **The Vue components' rendered behaviour.** I read them and reviewed the logic; I did not run the
  component suites or a browser. The noc-console metric tiles (NIT-2) are a reading of markup, not a
  screenshot.
- **Windows-specific behaviour** (the repo supports it): local-time `Date` arithmetic differs in
  detail on Windows, and I could not test on Windows. The DST defect is likely *worse* there.
- **Whether `0554fe1` is intended to be in this review.** It landed mid-review; I treated it as
  context and flagged that it only partially fixes BLOCKER-1.

---

## QA review 4 — part 2: the fixes

**Scope:** `git diff 446139f..HEAD`. The brief listed nine commits; there are **ten**.
`74f41ed` ("the durable claim is written once the process exists, not before it") is the tenth. It
also commits this file. I reviewed all ten.

**Verdict: DO NOT SHIP — but much closer, and the two blockers are genuinely closed.**

Five of the eight claimed fixes are real and I could not break them. Two regressions were
*introduced by the fixes* — one of them worse than the original defect — and one fix is only applied
on one of two code paths.

I want to be explicit about the shape of the problem, because it is the interesting part: **all 823
tests pass, and the branch is still not shippable.** Every regression below is in a case the new
tests do not enumerate. The tests were written from the same mental model that wrote the fix, so they
confirm the model rather than test it. That is why I re-derived each behaviour from an independent
model (a hand-written Python Vixie evaluator and my own cron oracle) instead of reading the new tests.

- **FIXED and verified:** BLOCKER-1 (the common case), BLOCKER-2, BUG-1 (panel path only), BUG-2,
  BUG-6, RISK-1, RISK-2, RISK-3, BUG-3, BUG-5's prose.
- **REGRESSED:** BUG-4's fix broke ordinary day-of-month steps (**BLOCKER-3**); BLOCKER-1's fix is
  incomplete for a two-hour fold (**BUG-7**).
- **PARTIAL:** BUG-1 is not applied on the offline CLI path (**BUG-8**).
- **NEW, from the rewrite:** `previousCronRun` became a linear minute scan (**RISK-7**), and the
  next/previous budgets now disagree (**BUG-9**).

---

## BLOCKER

### BLOCKER-3 (NEW, introduced by the BUG-4 fix) — `*/N` in the day-of-month now runs **every day**

`src/shared/cron.ts:218-228` (`dayMatches`), reached from `parseCron` at `:193-196`.

**What I did.** The BUG-4 fix made a `*`-leading day field "not filter" as well as "not restrict":

```ts
const dom = spec.domRestricted ? spec.daysOfMonth.has(date.getDate()) : true
const dow = spec.dowRestricted ? spec.daysOfWeek.has(date.getDay()) : true
```

I then ran the plainest schedules a person writes and counted the days they fire on, and modelled
real Vixie in Python independently.

**What I observed.** The step is parsed into the set and then never consulted:

```
0 0 */2 * *      domRestricted=false  domSize=16  -> runs 30/30 days   (intended ~15)
0 0 */10 * *     -> runs 30/30 days                                     (intended 3)
0 0 * * */2      -> runs 28/28 days                                     (intended ~16)
0 0 */10 * 1     -> Jan 2026: 5,12,19,26   (identical to "0 0 * * 1")
```

Independent Vixie model, January 2026:

| expression | real Vixie | this branch | agrees? |
| --- | --- | --- | --- |
| `0 0 */2 * *` | 1,3,5,…,31 | every day | **no — 15 days wrong** |
| `0 0 */10 * *` | 1,11,21,31 | every day | **no — 27 days wrong** |
| `0 0 */2 * 1` | odd-day Mondays (none in Jan) | every Monday | **no** |
| `0 0 1-31/2 * 1` | 19 days | 19 days | yes |
| `0 0 1 * 1` | 5 days | 5 days | yes |
| `0 0 * * 1` | 5,12,19,26 | same | yes |

**Why the fix is wrong, not merely different.** Vixie's `DOM_STAR`/`DOW_STAR` flags decide **only
which boolean combination is used** — `daymatch = dom_match && dow_match` when either field is a
star, `dom_match || dow_match` when neither is. `dom_match` is *always* "is today in the parsed
element set", stars included. A `*` field's set is all 31 days, so its `dom_match` is trivially true
and drops out — which is *why* a star looks like it stops filtering. But `*/10` starts with a star
**and still has a three-element set**, so under Vixie's AND it restricts to the 1st, 11th, 21st and
31st. This code reads the star as "ignore the set", which converts `*/10` into `*`.

So the original BUG-4 was real (the OR rule was switched on by `*/2`), but the correct repair was to
keep filtering with the set and only change the OR/AND *combination*. Both halves of Vixie matter, and
the fix took one and dropped the other.

**Why it matters.** `0 0 */2 * *` is a common way to write "every other day" — a container prune, a
log rotation, a `pg_dump` alternation. It now runs **every single day**, silently, with no error, on
a panel whose whole job is to run things when it said it would. This is worse than the pre-existing
BUG-4: BUG-4 fired a job on roughly twice the intended days for an unusual `*/2`+weekday combination;
this fires a job on **twice the intended days for the ordinary, single-field form**, and also
silently widens `*/N` on day-of-week (`0 0 * * */2` → every day instead of Sun/Tue/Thu/Sat).

**Why the suite missed it.** The new tests at `test/shared/cron.test.ts:331-352` only ever pair a
star-step day field with a **weekday**, which is the one shape where "ignore the set" and "filter by
the set" both look plausible. No test covers `*/N` in the day-of-month with a wildcard weekday, which
is the shape that actually breaks. The summary test (`:379-392`) covers `0 0 * * 0-6` — a full set —
so it passes for the same reason the bug exists: a full set is indistinguishable from a star.

**Smallest fix.** Restore the set test in `dayMatches` and keep only the OR/AND choice from the
star flag:

```ts
const dom = spec.daysOfMonth.has(date.getDate()) // always filter
const dow = spec.daysOfWeek.has(date.getDay())
return (spec.domRestricted && spec.dowRestricted) ? dom || dow : dom && dow
```

This is exactly the pre-fix `dayMatches` body, with `domRestricted`/`dowRestricted` now meaning
"Vixie would OR" (`!startsWith('*')`, which the branch already computes correctly) rather than
"should I filter" — those are two different questions and the fix conflated them. Then add the
missing test: `*/N` in the day-of-month against a wildcard weekday, asserted day by day.

---

## BUG

### BUG-7 (NEW) — BLOCKER-1's fix is incomplete: a **two-hour** fold still double-runs

`src/shared/cron.ts:283-303` (`firstInstantOfMinute`, probing only `[60, 30]`).

**What I did.** You asked me to re-measure with my own scheduler tick in zones your tests do not
cover. I swept IANA zones for non-hour DST shifts and found exactly two in 2026:
`Australia/Lord_Howe` (30 min) and `Antarctica/Troll` (**120 min**). Lord Howe is correct — I confirm
it below. Troll is not.

**What I observed.** Ticking once per second across Troll's 2026-10-25 fall-back (local 03:00 → 01:00,
a two-hour repeat):

```
30 1 * * *  -> 3 runs
  2026-10-23T23:30Z  01:30 GMT+2   (the 24th)
  2026-10-24T23:30Z  01:30 GMT+2   (first 01:30 on the 25th)
  2026-10-25T01:30Z  01:30 GMT+0   (SECOND 01:30, two hours later)
```

**Why.** `firstInstantOfMinute` probes 60 and then 30 minutes back and compares local fields. For the
second `01:30` (at `01:30Z`), `-60m` is `00:30Z` which locally reads `02:30`, and `-30m` is `01:00Z`
which reads `01:00`; neither matches `01:30`, so the function returns the *later* instant and the
dedup guard sees a new occurrence. The comment at `:296-298` asserts "a wall minute can repeat at most
once, and the shift is never more than an hour" — the first clause is true, the second is false and it
is the load-bearing one.

**Why it matters.** Same class as BLOCKER-1: a job runs twice for one wall-clock time. It is much
rarer (Troll is a research station; almost no home server sets it), which is why I rate it BUG and not
BLOCKER — **but the fix is advertised as principled and it is hard-coded to two magic numbers**, so it
will silently miss the next zone that changes. I would rather you fixed the shape than the instance.

**Smallest fix.** Do not guess the shift. Ask the platform: for a candidate minute, compute the offset
at that instant and at that instant minus the maximum plausible shift, and take the earliest instant
whose local fields match — or simply search backwards in whole minutes for up to, say, 4 hours
(the search is already a linear scan, so this is a handful of extra comparisons and removes the magic
numbers entirely). A `firstInstantOfMinute` built on "the earliest instant with these local fields in
a bounded window" is correct for any shift, including a future one-off (the EU has discussed
abolishing DST; a zone may change its base offset).

### BUG-8 (fix partially applied) — BUG-1 is fixed for the panel, still broken for the offline CLI

`src/cli/run-deploy.ts:74-76` vs `src/services/supervisor.ts:465-476`.

`DeployContext.env` was added and the supervisor supplies it. The offline CLI call site does not, and
it is the *second* of only two production call sites:

```ts
// src/cli/run-deploy.ts:74 — no `env`
const outcome = await runDeploy(entry, { cancelled: () => false }, {
  log: (stream, text) => process.stdout.write(`${dim(`[${stream}]`)} ${text}\n`),
})
```

Measured on the default path (no `context.env`): `PLAIN=from-config`, `FILEVAR=` (empty),
`TOKEN=` (empty). With `context.env` supplied: all three present.

**Why it matters.** `home-hosted deploy <id>` with the panel down is documented (`docs/CLI.md:115-117`)
as running "the same steps", and it is precisely the path someone uses to deploy *because* the panel
is down — often a private-registry `pnpm install` that needs the token. It fails the same silent way
the original BUG-1 did. Also note the fallback at `deploy.ts:101` still uses the old subset
(`{ ...config.env, ...config.dataEnvs }`), so the parameter being optional means the bug survives
whenever a caller forgets — a default that reproduces the defect is a footgun.

**Smallest fix.** Pass `env` from the CLI too (the offline path already has the store, so
`resolveSpawn`'s env logic or an equivalent is reachable), and consider making `env` required so a new
call site cannot silently regress. A cheap guard: have `runDeploy` log a system line when it falls
back to the subset, so the degraded path is visible rather than silent.

### BUG-9 (NEW, from the BLOCKER-1 rewrite) — the two searches now disagree, and the panel reports a valid schedule as having no occurrence

`src/shared/cron.ts:308` (`LOOK_BACK_MS`, one year) vs `:326` (`SEARCH_LIMIT_MS`, eight years).

`previousCronRun` was rewritten as a linear minute scan with a **one-year** look-back; `nextCronRun`
keeps the **eight-year** budget. For a leap-day job this splits the two searches:

```
0 0 29 2 * from 2026-06-01:  next = 2028-02-29   prev = null
               from 2027-06-01:  next = 2028-02-29   prev = null
               from 2028-06-01:  next = 2032-02-29   prev = 2028-02-29
```

`previousCronRun` returning `null` is what the scheduler treats as "the schedule does not come due"
(`scheduler.ts:139-145`), so a leap-day job logs, on every boot for years:

```
WARN  job "leap": the schedule has no occurrence within eight years (0 0 29 2 *)
```

which is false — `nextCronRun`, in the same module, says 2028-02-29. The message you fixed in BUG-6
is now accurate about the *limit* but wrong about *this* schedule, because the limit it is describing
is no longer the one that produced the `null`. The view also shows `—` for next run only via
`nextCronRun`, so the card and the log contradict each other.

**Smallest fix.** Make the look-back consistent with the forward budget (both eight years), or better:
have `previousCronRun`'s `null` mean only "no occurrence in the look-back window" and let the
scheduler word its message as such ("no occurrence in the last year"), since the scheduler's actual
question — "which occurrence is due now" — never needs a year of history. The yearly look-back is
defensible *for the scheduler*; it is wrong as a general public function returning `null` with an
8-year sibling.

### BUG-10 (NEW) — the `*/N` regression also defeats the new summary tests for the shapes they don't enumerate

`src/shared/cron.ts:454-478` (`cronSummary`).

Verified as *correct* for what it claims: `0 0 */2 * *` → `custom` (safe), `0 0 * * 0-6` → `daily`
(now right), `0 0 * * 1-5` → `weekly [1,2,3,4,5]`, `0 0 1 * 1` → `custom`. BUG-3 is fixed and I could
not make the preview lie again. Recorded only so the BUG-3 closure is on the record with evidence —
no action needed.

---

## RISK

- **RISK-7 (NEW, perf) — `previousCronRun` is now a linear minute scan, called once per job per tick.**
  Measured per call: `0 0 31 4 *` **37 ms**, `0 0 29 2 *` **38 ms**, `0 0 1 1 *` **16 ms**,
  `0 0 * * *` 0.01 ms. For a never-due or rare schedule this is ~3.7 % of a 1 Hz tick *per such job*,
  and it runs on the panel's tick loop beside health probes and backup scheduling. Ten jobs with a
  rare schedule is ~370 ms of the 1000 ms budget. The old code jumped a month at a time; this walks
  every minute of a year. The monotonicity argument is sound and the correctness is now good, but the
  cost went up by four orders of magnitude for the worst case. Cheapest improvement that keeps the
  fix: when a candidate fails on month/day, skip to the previous day boundary **in absolute time**
  (`floor(t/86400000)*86400000 - 60000`), which is monotonic and cannot walk backwards, and keep the
  minute scan only within a day. Worth a benchmark test either way, since nothing currently stops a
  future edit from making this worse.
- **RISK-5 (still open — and worse than I first said, please re-read).** You left this deliberately; my
  re-assessment is that BUG-2's fix makes it *sharper*. Each run now writes a `running` claim **plus**
  a completion, and the catch-up's entire defence against a double start is that the claim is still
  inside the 5000-event window when the panel reboots. The cap is workspace-wide across all servers
  (`history.ts:5`), not per-server. So the failure mode is: a busy workspace, a long run, a restart,
  and the claim has rolled off — and BUG-2 re-opens silently. It is no longer "old evidence may be
  lost"; it is "the fix for a double-run depends on an eviction policy that does not preserve it".
  Smallest fix: keep `MAX_EVENTS` entries *plus* the newest `job-run`/`start` event per server id
  (a small pinned set), or read the claim from a per-server state file rather than the shared log.
- **RISK-6 (still open — agree with your call).** `overlap` per occurrence while a job hangs. With
  RISK-5 above, this is now also an *availability* issue for the fix, not just noise: 288 events/day
  from one hung job is 6 % of the cap per day. Lower priority than RISK-5 but same root.
- **RISK-8 (NEW, minor) — `deploying` now spans the restart, which spans a health wait.** Closing
  RISK-1 correctly keeps `deploying` true across `restart()`, so `POST /deploy` stays refused for the
  whole restart including `health.startTimeoutMs`. That is the right trade; noting it so nobody
  "fixes" it back. The `finally` clears it on every path, which I checked.

## What I verified as genuinely FIXED

- **BLOCKER-1 — fixed for 1 h and 30 min folds.** Berlin and New_York: one run per wall-clock time,
  the earlier (DST) instant, monotonic occurrence sequence, **no duplicate wall minutes**. Lord Howe
  (30 min): correct, including `*/15` and the `01:45` boundary case. Auckland (southern hemisphere):
  correct. Spring-forward still skips the day. My independent oracle is unchanged: **1361 randomised
  next/prev calls, 0 mismatches**, and `cronDueAt` still matches my brute-force model over the full
  2026–2027 minute range. The `setSeconds(0, 0)` diagnosis was exactly right and the truncation in
  absolute time is the correct repair.
- **BLOCKER-2 — fixed, and I checked the process is actually dead**, not merely that the call
  returned: cancel 250 ms into a 55 s step returns in **307 ms** (was 30,011 ms), the child is `GONE`
  by `ps` at +0/+300/+1200 ms, and **no `sleep` survivors remain** — including a step that forks two
  background grandchildren (`sleep 40 & sleep 40 & wait` → both gone). The timeout path also kills the
  group. `killDeployStep` in `stopEntry` plus the 100 ms poll is the right shape.
- **BUG-1 — fixed on the panel path.** `context.env` carries `env`, `envFile` and `secretEnv`; measured
  through the real `runDeploy`. (Incomplete on the CLI path — BUG-8.)
- **BUG-2 — fixed, and the hole you asked about is already closed by `74f41ed`.** The claim is written
  **after** the spawn returns, so a throwing spawn leaves no record. Modelled both directions:
  restart mid-run with a claim → **0** runs (no double start); genuine outage across 03:00 → **1**
  run; restart loop → **0** replays. Your own note that `spawnJobRun` returns `pid: null` rather than
  throwing for a missing program is correct, and asserting `['running','failed']` is the honest shape.
- **BUG-6 — fixed.** 2096→**2104**, 2099→**2104**, 2100 correctly skipped (2104/2108/2112/2116
  sequence), `0 0 31 4 *` still `null`. Message no longer says "never". (The wording is now wrong for
  leap-day jobs for a different reason — BUG-9.)
- **RISK-1/2/3 — fixed.** A refused restart no longer re-labels a successful deploy; `deploying` spans
  the restart; a cancelled deploy logs "deploy stopped — the old process is still what runs" and does
  not notify as a failure. The new supervisor tests exercise each and pass.
- **BUG-3 — fixed.** Summary is built from sets; `0 0 * * 0-6` → `daily`; ambiguous shapes → `custom`.
- **BUG-5 — prose corrected**, and the replacement doc claim is *accurate*: I reproduced your exact
  example (`*/5`, tick at 10:00 then 10:17 → runs 10:00 and 10:15, never 10:05/10:10). Thank you for
  measuring it rather than asserting it.

## What I could not verify

- **The Vue/UI halves.** Unchanged by these commits as far as I can see, and I still have not driven
  either UI in a browser. My part-1 NIT-2 (noc-console renders service-only pid/uptime/restart/port/
  probe tiles for a job) and NIT-3 (stale `jobError`/`deployError` under the buttons) are **open and
  unverified as fixed** — they need a rendered check, so please either do it or record them as
  unverified rather than fixed.
- **Windows.** The DST reasoning depends on local `Date` semantics; I could not test on Windows.
- **A live panel** (no port binding, no Caddy, no real home), as before. `supervisor.deploy` was
  exercised through the shipped harness only.
- **Whether `*/N` day-of-month regressions have bitten any real config** — I can only show the
  behaviour, not the blast radius.

## Commit messages — what is overstated

1. `081eed2` "a repeated wall-clock minute is one occurrence, not two" — true for 1 h and 30 min
   folds, **not** for the two-hour fold (BUG-7). The message and the `firstInstantOfMinute` comment
   both assert "the shift is never more than an hour", which is false for `Antarctica/Troll`.
2. `45b679c` "a day field that begins with a star is a wildcard, as Vixie means it" — half of Vixie.
   The star decides the *combination*, not whether the field filters. As shipped this makes `*/10` in
   the day-of-month mean `*` (BLOCKER-3), which Vixie never does.
3. `51e3e2e` "a step runs with the entry's own environment" — true through the panel, **not** through
   `home-hosted deploy` with the panel down (BUG-8).
4. `1608df4` "a leap day seven years out is not 'never'" — correct in `nextCronRun`; the paired
   `previousCronRun` still answers `null` within a year and the scheduler still warns that such a
   schedule has no occurrence (BUG-9).
5. To your credit: `74f41ed`'s message is honest about its own author getting the first test wrong and
   about `spawnJobRun` not throwing. That is the kind of commit message the rest should match, and it
   is why I trusted the BUG-2 fix enough to model it rather than just read it.
