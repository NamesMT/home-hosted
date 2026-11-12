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
