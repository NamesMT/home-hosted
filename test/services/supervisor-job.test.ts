import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSupervisor, runCleanups, view, waitFor } from '../support/supervisor-harness'

afterEach(runCleanups)

/**
 * A real job run: a real child process, its real exit code, its real log lines.
 *
 * The scheduler suite proves *when* a run starts; this one proves what a run **is** — that a job reuses
 * the same spawn resolution, log buffer and history store a service does, and that its exit code is
 * the outcome rather than something the health machinery infers. Nothing here is stubbed, because the
 * whole point of "a run reuses spawn, logs and history" is that the wiring is real.
 *
 * `kind: 'job'` with a `schedule` is the only shape the config accepts, so every fixture carries one.
 */

/** A job that exits with a chosen code and writes one line to each stream. */
function exitJob(id: string, code: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    command: process.execPath,
    args: ['-e', `console.log("out line"); console.error("err line"); process.exitCode = ${code}; process.exit(${code})`],
    kind: 'job',
    schedule: '0 3 * * *',
    ...overrides,
  }
}

describe('running a job', () => {
  it('spawns it, waits, and answers its exit code', async () => {
    const { supervisor } = await makeSupervisor([exitJob('ok', 0)])
    const result = await supervisor.runJob('ok')
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.outcome.exitCode).toBe(0)
    expect(result.outcome.cancelled).toBe(false)
    expect(result.outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a non-zero exit as the run\'s outcome, not as a crash of the panel', async () => {
    const { supervisor } = await makeSupervisor([exitJob('fails', 3)])
    const result = await supervisor.runJob('fails')
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.outcome.exitCode).toBe(3)
  })

  it('puts both streams in the entry\'s own log, which is what a person reads', async () => {
    const { supervisor } = await makeSupervisor([exitJob('logs', 0)])
    await supervisor.runJob('logs')
    // The pipes are drained on `close`, just after `exit`; the run's own promise resolves on the exit.
    const lines = await waitFor(() => {
      const text = supervisor.logLines('logs').map(line => `${line.stream}:${line.text}`)
      return text.some(line => line.includes('out line')) && text.some(line => line.includes('err line')) ? text : undefined
    })
    expect(lines.includes('stdout:out line')).toBe(true)
    expect(lines.includes('stderr:err line')).toBe(true)
  })

  it('records a job-run history event with the exit code and the duration', async () => {
    const { supervisor, history } = await makeSupervisor([exitJob('hist', 0)])
    await supervisor.runJob('hist')
    // Two events for one run: the durable `running` claim written before the spawn, then the
    // outcome. The claim is what stops a panel restarted mid-run starting a second copy.
    const events = await waitFor(() => {
      const recorded = history.all().filter(event => event.serverId === 'hist' && event.type === 'job-run')
      return recorded.some(event => event.outcome !== 'running') ? recorded : undefined
    })
    expect(events.map(event => event.outcome)).toEqual(['running', 'ok'])
    const outcome = events.find(event => event.outcome === 'ok')!
    expect(outcome.detail).toMatch(/exit code 0/)
    expect(outcome.runtimeMs, 'the outcome event carries the duration; the claim does not').toBeGreaterThanOrEqual(0)
  })

  it('refuses a service, names `start`, and tells the caller with a code', async () => {
    const { supervisor } = await makeSupervisor([{ id: 'web', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }])
    const result = await supervisor.runJob('web')
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.code).toBe('NOT_A_JOB')
    expect(result.error).toMatch(/start/)
  })

  it('refuses a second run of the same job rather than stacking two', async () => {
    const { supervisor } = await makeSupervisor([exitJob('slow', 0, { args: ['-e', 'setTimeout(()=>{}, 3000)'] })])
    const first = supervisor.runJob('slow')
    // The first run is in flight: a second call is the same refusal the scheduler records as `overlap`.
    await waitFor(() => supervisor.isJobRunning('slow') ? true : undefined)
    const second = await supervisor.runJob('slow')
    expect(second.ok).toBe(false)
    if (second.ok)
      return
    expect(second.code).toBe('JOB_RUNNING')
    expect((await first).ok).toBe(true)
  })

  it('says a failure in words a person can act on, and notifies like a crash', async () => {
    const { supervisor, notifications } = await makeSupervisor([exitJob('bad', 7)])
    const sent: Array<{ reason: string, serverId: string }> = []
    notifications.notify = ((event: { reason: string, serverId: string }) => {
      sent.push({ reason: event.reason, serverId: event.serverId })
    }) as typeof notifications.notify

    await supervisor.runJob('bad')
    await waitFor(() => sent.length > 0 ? sent : undefined)
    expect(sent[0]!.reason).toBe('job-failed')
    expect(sent[0]!.serverId).toBe('bad')
    // The view carries the same fact, so the card and the chat cannot disagree.
    await waitFor(() => view(supervisor, 'bad').job?.lastExitCode === 7 ? true : undefined)
  })

  it('shows the job block on the view while it runs, and after it ends', async () => {
    const { supervisor } = await makeSupervisor([exitJob('visible', 0, { args: ['-e', 'setTimeout(()=>{}, 2000)'] })])
    const running = supervisor.runJob('visible')
    const during = await waitFor(() => view(supervisor, 'visible').job?.running === true ? view(supervisor, 'visible') : undefined)
    expect(during.job?.running).toBe(true)
    // The harness builds no scheduler, so the honest answer is `null` rather than a number the view
    // made up: "when it next runs" is the scheduler's question. The panel supplies one; a unit
    // harness does not. `test/services/scheduler.test.ts` covers the computed value.
    expect(during.job).toHaveProperty('nextRunAt', null)
    await running
    const after = await waitFor(() => view(supervisor, 'visible').job?.running === false && view(supervisor, 'visible').job?.lastExitCode === 0 ? view(supervisor, 'visible') : undefined)
    expect(after.job?.lastExitCode).toBe(0)
  })

  it('a stop ends the run in flight, and records it as cancelled rather than failed', async () => {
    const { supervisor, history } = await makeSupervisor([exitJob('stoppable', 0, { args: ['-e', 'setTimeout(()=>{}, 30000)'] })])
    const running = supervisor.runJob('stoppable')
    await waitFor(() => supervisor.isJobRunning('stoppable') ? true : undefined)
    await supervisor.stop('stoppable')
    const result = await running
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.outcome.cancelled).toBe(true)
    // The claim is written first and the outcome last, so wait for the one that is not the claim.
    const events = await waitFor(() => {
      const recorded = history.all().filter(event => event.serverId === 'stoppable' && event.type === 'job-run')
      return recorded.some(event => event.outcome !== 'running') ? recorded : undefined
    })
    expect(events.at(-1)!.outcome).toBe('cancelled')
  })

  it('refuses a disabled job', async () => {
    const { supervisor } = await makeSupervisor([exitJob('off', 0, { enabled: false })])
    const result = await supervisor.runJob('off')
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.code).toBe('SERVER_DISABLED')
  })

  it('answers a missing id as a missing id', async () => {
    const { supervisor } = await makeSupervisor([])
    const result = await supervisor.runJob('nope')
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.code).toBe('UNKNOWN_SERVER')
  })
})

/**
 * A job whose program does not exist is a **failed run**, not a claim with no outcome.
 *
 * Measured: `spawnJobRun` does not throw for a missing program — it returns a handle with `pid: null`
 * and an outcome of `exitCode: null`, so the run completes as a failure and both records are written.
 * That is the honest shape: something was attempted and it failed, which is different from an
 * occurrence that was claimed and then silently forgotten.
 *
 * The claim is written after the process exists rather than before the spawn, so a spawn that *does*
 * throw (an unusable cwd, a NUL in the command) leaves no claim and the occurrence stays owed.
 */
describe('a job whose program does not exist', () => {
  it('records a failed run rather than a bare claim', async () => {
    const { supervisor, history } = await makeSupervisor([
      { id: 'broken', command: 'hh-no-such-program-anywhere', args: [], port: null, kind: 'job', schedule: '0 3 * * *', enabled: true } as never,
    ])

    await supervisor.runJob('broken')

    const events = history.all().filter(event => event.serverId === 'broken' && event.type === 'job-run')
    // The claim and the outcome, both written — and the outcome says it failed. Sorted rather than
    // ordered: a spawn that errors before the claim reaches the file can land the two either way, and
    // that is a timing detail of the host, not a rule.
    expect(events.map(event => event.outcome).sort()).toEqual(['failed', 'running'])
  }, 30_000)
})
