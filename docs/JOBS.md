# Jobs

A **job** is a short-lived command on a cron schedule. It starts, it runs, it exits, and **its exit
code is the outcome** — `0` succeeded, anything else failed.

That is a different thing from a [server](./SERVERS.md), which stays up and is supervised: health
probes, readiness on its port, a restart policy, a nanny. A job has none of those, because there is
nothing to probe and nothing to restart.

Jobs are stored per workspace in `jobs.config.json`, beside `servers.config.json`.

```json
{
  "meta": { "writtenBy": "home-hosted", "schema": 1 },
  "jobs": [
    {
      "id": "nightly-backup",
      "schedule": "0 3 * * *",
      "command": "./scripts/backup.sh",
      "args": ["--full"],
      "cwd": ".",
      "env": { "KEEP_DAYS": "14" }
    }
  ]
}
```

## The fields

| field | default | what it is |
| --- | --- | --- |
| `id` | required | names the job, its log and its history. Lowercase, digits, `-` and `_` |
| `label` | the id | what a page shows beside the id |
| `enabled` | `true` | off means it does not run on its schedule; a run in flight still finishes |
| `command` | required | resolved against the **panel's** `PATH`, like a server's |
| `args` | `[]` | one array entry per argument — no shell parsing |
| `cwd` | `.` | relative to the project the panel was started from |
| `env` | `{}` | extra environment for the run |
| `secretEnv` | `[]` | the **names** of secrets to export; the values live in the workspace secrets file |
| `schedule` | required | 5-field cron, host local time. A job with no schedule would never run |
| `timeoutMs` | `3600000` | how long one run may take before the panel ends it |

**There is no `port`, `health`, `restart` or `persistent`**, and that is the point: a job declares
none of them because it has no lifecycle to supervise. Removing the fields is a better answer than
refusing them, because a refusal needs explaining and the explanation was the noise.

`{id}`, `{label}`, `{cwd}`, `{projectDir}`, `{dataRoot}` and `{home}` expand in `args` and `env`,
exactly as they do on a server.

### A job's secret environment

`secretEnv` names variables whose **values** are kept in the workspace secrets file (0600) instead of
in `jobs.config.json`, where they would be in every backup, every `git diff` and every screen share.

```json
{ "id": "nightly-backup", "schedule": "0 3 * * *", "command": "./backup.sh", "secretEnv": ["BACKUP_TOKEN"] }
```

Declaring the name is **consent**: the run receives a value only for a name the job declares, so a
value left behind by a renamed job never reaches its process. Declare the name first, then set the
value — a value for an undeclared name is refused, and the refusal names the name and the fix.

```bash
home-hosted secret set nightly-backup BACKUP_TOKEN --stdin   # prompts without echo
home-hosted secret ls nightly-backup                        # the names, and which have a value
```

The panel never sends a value back — only which names have one (`secretEnvSet` on the job view).
A job's values live in the **same file** as a server's but under their own key (`jobEnv`, beside
`serverEnv`): a job and a server may share an id, and one key space meant a job's value reached the
server of that id and the server's reached the job. They are two domains, so they are two maps. **A
changed `secretEnv` takes effect on the next run**; a run in flight keeps the environment it started
with.

## Editing one

Both UIs create a job and edit it in the same sheet — the fields are the same ones, so a second
form would be a copy that drifts. One field it will not change: **`id`**. The id names the job's log
file, its run history and its stored secret values, so renaming it in place would orphan all three
under a name nothing points at any more. The box is read-only with that reason beside it; the way to
a different id is to remove the job and declare it again.

`PATCH /api/jobs/:id` is what the sheet sends. It carries no `id`, and it carries **every field the
sheet shows**, not only the changed ones — a patch is whole-field, so omitting one means "keep
whatever is stored", which is what the form displayed.

A job's **secret values** are set from the same sheet, in the block directly under the names that
declare them: one masked box per declared name, a "needs saving" marker on a name typed but not yet
stored, and a remove that confirms. The panel never sends a value back, so a box is always empty and
a stored name reads only as *set*. A value cannot be set from a sheet that is still creating the job —
the store is keyed by the job id — so the block says so until the job exists.

## Running one

Three ways, and all three are the same run — same spawn, same log lines, same history event, same
notification:

- **Run now** on the Jobs page,
- `home-hosted job run <id>`,
- `POST /api/jobs/:id/run`.

All of them **wait for the exit code**, because that is the answer. `?wait=false` answers `202` for a
caller that will watch the log instead. A run already in flight is `409 JOB_RUNNING` rather than a
queue: two copies of a backup writing the same files is the failure a schedule exists to avoid.

`home-hosted job ls` lists them; `POST /api/jobs/:id/stop` ends a run in flight, and the record marks
it **cancelled** so its non-zero status is not reported as a failure.

## The expression

Five fields — `minute hour day-of-month month day-of-week` — in the **host's local timezone** (this
is a home server; its owner thinks in that machine's time).

```text
0 3 * * *        every day at 03:00
*/15 * * * *     every 15 minutes
30 9 * * mon-fri weekdays at 09:30
0 0 1 * *        the first of every month
```

Ranges (`1-5`), steps (`*/5`, `1-10/2`), lists (`1,3,5`) and names (`jan`, `mon`, case-insensitive)
all work. Sunday is both `0` and `7`. When **both** day fields are restricted, a day matching
*either* is due (`0 0 1 * mon` is the first of the month *and* every Monday) — cron's own rule.

**Six-field expressions and `@daily`-style macros are refused by name.** A 6-field expression read as
5 would run on a schedule nobody typed: the seconds field would be taken as the minutes.

## How a run is scheduled

- **One run per occurrence.** The due occurrence is derived from the clock, not from how often the
  panel ticks, so a late tick or a busy loop still starts exactly one run for that minute — **never
  two**. What it does not promise is that nothing is *missed*: a tick stalled across several
  occurrences runs only the one due when it resumes (stalling from 10:00 to 10:17 on `*/5 * * * *`
  runs 10:00 and 10:15, never 10:05 or 10:10). Replaying them would turn one stall into a burst.
- **An overlap is skipped and recorded.** A job still running when its next occurrence arrives is not
  queued behind itself. The skip is logged, and its history event carries `overlap`.
- **A missed occurrence runs once, at boot.** A panel that was down across 03:00 starts that run when
  it comes back — **one** run, for the most recent occurrence, not one per missed day. A panel
  restarted in a loop does not replay an occurrence it already ran, because the durable `job-run`
  record is what decides whether one is owed.
- **Declaring a job does not run it.** A job added while the panel is up waits for its next
  occurrence, because it did not exist when the earlier one went by. Creating a nightly backup means
  it waits until 03:00, not that it runs the moment you press save. Use **Run now** (or
  `home-hosted job run`) when you want one immediately.
- **A schedule that can never come due is reported once.** A mistyped expression (`0 0 31 4 *` for
  31 April) is logged when it appears and again only if it changes — never every second.
- **Across a clock change, a job runs once per wall-clock time.** On the autumn change the wall clock
  reaches 01:30 twice — once on daylight time and once on standard — and `30 1 * * *` runs **once**,
  at the first. On the spring change, a time the clock skips (`02:30`) does not exist that day, so that
  day's run does not happen; the next one does. The rule is derived from the clock, not from how often
  the scheduler ticks, so an hour of real time passing twice cannot start two runs.

## Where a run's result goes

**A run's own output goes to that job's own log file**, one JSONL file per job id under the
workspace's `.logs/jobs/`. It is the same format, rotation and retention a server's log has (`logs.
persist`, `maxBytes`, `keep`), read by the same tailer — a job log is not a second kind of log.

It used to go to the panel log at **DEBUG**, which nobody runs a home panel at, so a failed backup's
own output was in practice unreadable: the one thing needed to debug the run was the one thing not
written anywhere a person would look. The panel log now keeps only the summary lines (started,
finished, stopped, failed), and the run's stdout and stderr go to the file.

```bash
home-hosted job log nightly-backup          # what the last runs wrote, newest last
home-hosted job log nightly-backup --json   # one document, `{ job, lines }`
```

The Jobs page has a **log** button per row for the same content, with a stream filter. Both read
`GET /api/jobs/:id/log`, which takes a server log's `tail`/`search`/`stream`/`since`/`before`
unchanged. A job that has not run answers an empty list, not a `404`; a workspace with
`logs.persist` off answers `enabled: false`, and both UIs say the panel keeps nothing rather than
showing an empty log as "the run printed nothing".

A removed job's log is deleted with it, so re-declaring the same id does not inherit a dead run's
output.

Each run also records a **`job-run`** history event carrying its exit code and how long it took, and
a **failed run notifies like a crash** — a backup that did not run is the same news to a reader as a
service that stopped.

The Jobs page shows the expression, the next run, the last run and the last exit code.

## Coming from 0.14

A `servers.config.json` that still declares a job is **refused**, with the instruction to fix it:

```text
nightly-backup: this entry is a `job`, which now lives in jobs.config.json — run `home-hosted migrate`
to move it, then remove `kind`/`schedule` here
```

That refusal is deliberate. The dangerous outcome is not an error — it is that a `kind: "job"` entry
would be read as a service and its schedule would stop firing with nothing to say so. Run
`home-hosted migrate` and the entries move.
