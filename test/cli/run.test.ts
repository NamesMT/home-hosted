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

    const result = await runCli(['run', 'nightly'])
    expect(result.status, result.stderr).toBe(0)
    expect(created.seen.path).toBe('/_hh/servers/nightly/run')
    expect(result.stdout).toContain('ran nightly')
    // The outcome line carries the exit code, which is the whole answer for a job.
    expect(result.stdout).toContain('exit code 0')
  })

  it('carries the workspace through', async () => {
    const created = await panel(200, JSON.stringify(SUCCESS))
    writeRuntime(created.url)

    const result = await runCli(['run', 'nightly', '--workspace', 'staging'])
    expect(result.status, result.stderr).toBe(0)
    expect(created.seen.path).toBe('/_hh/servers/nightly/run?workspace=staging')
  })

  it('exits 1 on a failed run, and keeps the panel\'s sentence', async () => {
    const created = await panel(409, JSON.stringify({ code: 'JOB_FAILED', message: 'the run failed (exit code 3)', exitCode: 3 }))
    writeRuntime(created.url)

    const result = await runCli(['run', 'nightly'])
    expect(result.status).toBe(1)
    // One refusal, on stderr, and nothing on stdout — the CLI's own rule.
    expect(result.stderr).toContain('exit code 3')
    expect(result.stdout).toBe('')
  })

  it('refuses a service, naming the command that does start it', async () => {
    const created = await panel(409, JSON.stringify({ code: 'NOT_A_JOB', message: 'server "web" is a service — `start` supervises it' }))
    writeRuntime(created.url)

    const result = await runCli(['run', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('start')
  })

  it('prints one document with --json, so a script reads the exit code', async () => {
    const created = await panel(200, JSON.stringify(SUCCESS))
    writeRuntime(created.url)

    const result = await runCli(['run', 'nightly', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    expect(body).toMatchObject({ server: 'nightly', ok: true, exitCode: 0, cancelled: false })
  })

  it('needs an id, and says where to find one', async () => {
    const result = await runCli(['run'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('needs a job id')
    expect(result.stderr).toContain('ls')
  })

  it('refuses without a panel rather than running the job unsupervised', async () => {
    // No run.json: nothing is listening, so there is no supervisor, log file or history to record a
    // run against — and a second implementation would be one a person believed was the panel's.
    const result = await runCli(['run', 'nightly'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is not running')
    expect(result.stderr).toContain('up')
  })
})

describe('ls, with a job in the workspace', () => {
  it('adds a NEXT RUN column, and marks the row as a job', () => {
    // No panel: the file alone. `kind`/`schedule` come from the config, and `nextRunAt` is the honest
    // `—` a config cannot compute.
    const lines = lsLines([
      { id: 'nightly', status: null, port: null, command: 'node', args: ['backup.js'], autostart: false, persistent: false, enabled: true, kind: 'job', schedule: '0 3 * * *', nextRunAt: null },
      { id: 'web', status: null, port: 4000, command: 'node', args: [], autostart: false, persistent: false, enabled: true, kind: 'service', nextRunAt: null },
    ])
    expect(lines[0]).toMatch(/^ID +STATUS +PORT +COMMAND +NEXT RUN$/)
    expect(lines[1]).toContain('nightly')
    expect(lines[1]).toContain('(job)')
    // A service's cell in a table that has the column is a dash, not a blank.
    expect(lines[2]).toMatch(/—$/)
  })

  it('keeps the four columns when the workspace has no job', () => {
    const lines = lsLines([{ id: 'web', status: null, port: 4000, command: 'node', args: [], autostart: false, persistent: false, enabled: true, kind: 'service', nextRunAt: null }])
    expect(lines[0]).toMatch(/^ID +STATUS +PORT +COMMAND$/)
    expect(lines[0]).not.toContain('NEXT RUN')
  })

  it('shows the next run as a countdown, and `running` while one is in flight', () => {
    const now = new Date(2026, 2, 10, 0, 0, 0, 0).getTime()
    const row = (overrides: Record<string, unknown>) => ({
      id: 'nightly',
      status: null,
      port: null,
      command: 'node',
      args: [],
      autostart: false,
      persistent: false,
      enabled: true,
      kind: 'job' as const,
      schedule: '0 3 * * *',
      nextRunAt: null,
      ...overrides,
    })
    expect(lsLines([row({ nextRunAt: now + 3 * 60 * 60_000 })], now)[1]).toContain('in 3h 0m')
    expect(lsLines([row({ nextRunAt: now + 90_000 })], now)[1]).toContain('in 2m')
    expect(lsLines([row({ status: 'running', nextRunAt: now + 60_000 })], now)[1]).toContain('running')
    expect(lsLines([row({ nextRunAt: now - 60_000 })], now)[1]).toContain('due')
  })
})
