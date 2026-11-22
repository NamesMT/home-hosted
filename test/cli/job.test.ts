import { describe, expect, it } from 'vitest'
import { lsLines } from '#src/cli/ls'
import { cliPanelFixture } from '../support/cli-panel-fixture'

/**
 * `home-hosted run <id>` against a real listener: the CLI reads the token from `run.json`, speaks
 * `/_hh`, and turns the panel's answer into one line and one exit code.
 *
 * The run itself — a real child, its exit code, its log — is `test/services/supervisor-job.test.ts`,
 * and the schedule is `test/services/scheduler.test.ts`. What this file pins is the **command**: which
 * route it reaches, that it waits (so its exit code is the job's), that a refusal is a refusal on
 * stderr, and that `--json` stays one document.
 *
 * `spawn`, never `spawnSync`: the panel is a listener in *this* process, and a synchronous wait would
 * freeze the event loop that has to answer it.
 */
const { runCli, panel, writeRuntime } = await cliPanelFixture()

const SUCCESS = { ok: true, exitCode: 0, signal: null, durationMs: 2500, cancelled: false }

describe('run, a job now', () => {
  it('posts to the job route and reports the exit code', async () => {
    const created = await panel(200, JSON.stringify(SUCCESS))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'nightly'])
    expect(result.status, result.stderr).toBe(0)
    expect(created.seen.path).toBe('/_hh/jobs/nightly/run')
    expect(result.stdout).toContain('ran nightly')
    // The outcome line carries the exit code, which is the whole answer for a job.
    expect(result.stdout).toContain('exit code 0')
  })

  it('carries the workspace through', async () => {
    const created = await panel(200, JSON.stringify(SUCCESS))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'nightly', '--workspace', 'staging'])
    expect(result.status, result.stderr).toBe(0)
    expect(created.seen.path).toBe('/_hh/jobs/nightly/run?workspace=staging')
  })

  it('exits 1 on a failed run, and keeps the panel\'s sentence', async () => {
    const created = await panel(409, JSON.stringify({ code: 'JOB_FAILED', message: 'the run failed (exit code 3)', exitCode: 3 }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'nightly'])
    expect(result.status).toBe(1)
    // One refusal, on stderr, and nothing on stdout — the CLI's own rule.
    expect(result.stderr).toContain('exit code 3')
    expect(result.stdout).toBe('')
  })

  it('prints the panel\'s own sentence when a run is refused', async () => {
    /**
     * The panel names the fix and the CLI repeats it rather than inventing wording.
     *
     * This used `NOT_A_JOB`, which the jobs domain made unreachable — a `job run` can no longer land on a
     * service, because the id is looked up among jobs. `JOB_RUNNING` is a refusal the panel still sends, so
     * the test now exercises the path a person can actually reach.
     */
    const created = await panel(409, JSON.stringify({ code: 'JOB_RUNNING', message: 'job "web" is already running — stop it, or read `job log web`' }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already running')
  })

  it('exits 1 when the job itself exited non-zero, though the request succeeded', async () => {
    // The run happened and the panel answered 200; the *job* is what failed. `job run` promises to
    // exit 1 on failure, and a backup script reads exactly that, so the command must not report
    // success just because the transport did.
    const created = await panel(200, JSON.stringify({ ok: false, exitCode: 3, signal: null, durationMs: 1200, cancelled: false }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'nightly'])
    expect(result.status, result.stdout).toBe(1)
    expect(result.stdout).toContain('exit code 3')
  })

  it('says the run failed in its --json document, and still exits 1', async () => {
    const created = await panel(200, JSON.stringify({ ok: false, exitCode: 3, signal: null, durationMs: 1200, cancelled: false }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'nightly', '--json'])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ job: 'nightly', ok: false, exitCode: 3 })
  })

  it('exits 1 for a run that was cancelled, whatever its exit code', async () => {
    const created = await panel(200, JSON.stringify({ ok: false, exitCode: 0, signal: null, durationMs: 900, cancelled: true }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'nightly'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('stopped')
  })

  it('prints one document with --json, so a script reads the exit code', async () => {
    const created = await panel(200, JSON.stringify(SUCCESS))
    writeRuntime(created.url)

    const result = await runCli(['job', 'run', 'nightly', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    expect(body).toMatchObject({ job: 'nightly', ok: true, exitCode: 0, cancelled: false })
  })

  it('needs an id, and says where to find one', async () => {
    const result = await runCli(['job', 'run'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('needs a job id')
    expect(result.stderr).toContain('ls')
  })

  it('refuses without a panel rather than running the job unsupervised', async () => {
    // No run.json: nothing is listening, so there is no supervisor, log file or history to record a
    // run against — and a second implementation would be one a person believed was the panel's.
    const result = await runCli(['job', 'run', 'nightly'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is not running')
    expect(result.stderr).toContain('up')
  })
})

describe('ls lists the workspace\'s jobs', () => {
  /**
   * `job ls` had no test at all, and it did not work: it called the **browser** client's `listJobs`,
   * whose `/api/jobs` is a relative URL, so it died with "Failed to parse URL from /api/jobs" before
   * it ever reached a panel. It reads `/_hh/jobs` now, like every other CLI read.
   */
  it('reads the jobs over the local channel, not the browser client', async () => {
    const created = await panel(200, JSON.stringify({
      jobs: [
        { id: 'nightly', schedule: '0 3 * * *', enabled: true, running: false, command: '/bin/echo', args: [] },
        { id: 'hourly', schedule: '0 * * * *', enabled: false, running: false, command: '/bin/echo', args: [] },
      ],
    }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'ls'])
    expect(result.status, result.stderr).toBe(0)
    expect(created.seen.path).toBe('/_hh/jobs')
    expect(result.stdout).toContain('nightly')
    expect(result.stdout).toContain('scheduled')
    expect(result.stdout).toContain('disabled')
  })

  /**
   * `NEXT` is part of the answer, and `docs/CLI.md` says so.
   *
   * The table carried id, expression and state — everything except when the thing is due, which is
   * the question a person at a terminal is asking. `docs/CLI.md` justified dropping the servers'
   * `NEXT RUN` column by pointing here: "`home-hosted job ls` answers that question now". It did not.
   */
  it('says when each job is next due, and labels the columns', async () => {
    const created = await panel(200, JSON.stringify({
      jobs: [
        { id: 'soon', schedule: '0 3 * * *', enabled: true, running: false, nextRunAt: Date.now() + 90 * 60_000, command: '/bin/echo', args: [] },
        { id: 'never', schedule: '0 0 31 4 *', enabled: true, running: false, nextRunAt: null, command: '/bin/echo', args: [] },
        { id: 'off', schedule: '0 3 * * *', enabled: false, running: false, nextRunAt: Date.now() + 90 * 60_000, command: '/bin/echo', args: [] },
      ],
    }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'ls'])
    expect(result.status, result.stderr).toBe(0)
    const [header, soon, never, off] = result.stdout.trim().split('\n')
    expect(header).toMatch(/ID\s+SCHEDULE\s+NEXT\s+STATE/)

    // A real occurrence reads as a relative time, not a wall clock the reader has to subtract.
    expect(soon).toContain('in 2 hours')
    // An expression that cannot come due says so; a dash would read as "still loading".
    expect(never).toContain('never')
    // A disabled job is not due at all, whatever the expression says.
    expect(off).toContain('—')
    expect(off).toContain('disabled')
  })

  it('carries the workspace through', async () => {
    const created = await panel(200, JSON.stringify({ jobs: [] }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'ls', '--workspace', 'staging'])
    expect(result.status, result.stderr).toBe(0)
    expect(created.seen.path).toBe('/_hh/jobs?workspace=staging')
  })

  it('prints one document with --json', async () => {
    const jobs = [{ id: 'nightly', schedule: '0 3 * * *', enabled: true, running: false, command: '/bin/echo', args: [] }]
    const created = await panel(200, JSON.stringify({ jobs }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'ls', '--json'])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({ jobs })
  })

  it('says there are none, rather than printing an empty table', async () => {
    const created = await panel(200, JSON.stringify({ jobs: [] }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'ls'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('no jobs declared')
  })

  it('refuses without a panel, since jobs live in the scheduler', async () => {
    const result = await runCli(['job', 'ls'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is not running')
  })
})

describe('ls lists services, and only services', () => {
  /**
   * The table has four columns, always.
   *
   * It used to grow a `NEXT RUN` column whenever a job was listed, which meant half the rows carried a
   * dash for a port they never had. Jobs are `home-hosted job ls` now — the separation is the reason
   * this table has one shape.
   */
  it('has the same four columns whether or not the workspace also has jobs', () => {
    const lines = lsLines([
      { id: 'web', status: null, port: 4000, command: 'node', args: [], autostart: false, persistent: false, enabled: true },
    ])
    expect(lines[0]).toMatch(/^ID +STATUS +PORT +COMMAND$/)
    expect(lines[0]).not.toContain('NEXT RUN')
    expect(lines[1]).toContain('web')
  })
})

describe('log reads a job\'s own output', () => {
  /**
   * `job log <id>` reads the job's **own** file, over `/_hh`.
   *
   * A run's output is no longer in the panel log — it goes to a JSONL file per job id — so `job run`
   * used to send a person to a file their script's output was not in. This is the way in.
   */
  it('reads the job\'s own log over the local channel', async () => {
    const created = await panel(200, JSON.stringify({
      jobId: 'nightly',
      enabled: true,
      sizeBytes: 120,
      files: ['nightly.log'],
      lines: [
        { ts: 1_700_000_000_000, stream: 'stdout', text: 'backup starting' },
        { ts: 1_700_000_000_500, stream: 'stderr', text: 'disk full' },
      ],
    }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'log', 'nightly'])
    expect(result.status, result.stderr).toBe(0)
    expect(created.seen.path).toBe('/_hh/jobs/nightly/log')
    expect(result.stdout).toContain('backup starting')
    expect(result.stdout).toContain('disk full')
    // The stream is named on every line, so `err` is not just a colour.
    expect(result.stdout).toContain('stderr')
  })

  it('prints one document with --json, and an empty log is an empty list rather than silence', async () => {
    const created = await panel(200, JSON.stringify({ jobId: 'idle', enabled: true, sizeBytes: 0, files: [], lines: [] }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'log', 'idle', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout.trim()) as { job: string, lines: unknown[] }
    expect(body.job).toBe('idle')
    // `--json` prints one document on stdout or nothing, and "no output yet" is a document.
    expect(body.lines).toEqual([])
  })

  it('says the panel keeps nothing when persistence is off, instead of showing an empty log', async () => {
    const created = await panel(200, JSON.stringify({ jobId: 'nightly', enabled: false, sizeBytes: 0, files: [], lines: [] }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'log', 'nightly'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('persist')
  })

  it('needs an id, and refuses without a panel', async () => {
    const noId = await runCli(['job', 'log'])
    expect(noId.status).toBe(1)
    expect(noId.stderr).toContain('needs a job id')

    const noPanel = await runCli(['job', 'log', 'nightly'])
    expect(noPanel.status).toBe(1)
    expect(noPanel.stderr).toContain('is not running')
  })

  /**
   * A flag the command does not take is refused, at the group level too.
   *
   * `cli.ts` validated the flags against `COMMANDS['job']`, whose `args` is `undefined` — the
   * spelling that means "this command parses its own argv". Every subcommand flag was therefore
   * accepted and dropped: `job ls --jsn` printed the human table and exited 0 (so a script parsing
   * it as JSON found prose), `job run nightly --jsn` **ran the job**, and a stray word went nowhere.
   * Measured against a real listener, all three exited 0 before `flagTarget`.
   */
  it('refuses a flag its subcommand does not take', async () => {
    const created = await panel(200, JSON.stringify({ jobs: [] }))
    writeRuntime(created.url)

    // `--jsn` and not `--bogus`: the one-edit typo is the case that actually happens, and refusing
    // it must not have reached the panel at all.
    for (const argv of [['job', 'ls', '--jsn'], ['job', 'run', 'nightly', '--jsn'], ['job', 'log', 'nightly', '--jsn']]) {
      const result = await runCli(argv)
      expect(result.status, `${argv.join(' ')} — ${result.stdout}${result.stderr}`).toBe(1)
      expect(result.stderr).toContain('Unknown option')
      // The near miss names the flag it meant, as every other command's does.
      expect(result.stderr, argv.join(' ')).toContain('did you mean `--json`?')
    }
    // Nothing was sent: the refusal happens before any command runs.
    expect(created.seen.path).toBeUndefined()
  })

  it('refuses a stray word its subcommand cannot take', async () => {
    const created = await panel(200, JSON.stringify({ jobs: [] }))
    writeRuntime(created.url)

    const result = await runCli(['job', 'ls', 'extra'])
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1)
    expect(result.stderr).toContain('Unexpected argument')
    expect(created.seen.path).toBeUndefined()
  })
})
