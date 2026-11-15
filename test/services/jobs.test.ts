import type { JobsService } from '#src/services/jobs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Running a job: the exit code is the whole answer.
 *
 * A job is a short-lived command, so what a person needs to know is whether it worked — not a status,
 * a port or a health probe. These tests use real child processes: a run that only works because
 * something is stubbed is not a run.
 */

const dirs: string[] = []
const originalHome = process.env.HHOSTED_HOME

afterEach(() => {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * A workspace with `jobs.config.json` already holding these jobs.
 *
 * `vi.resetModules()` before the import is load-bearing: `dataRoot` in `src/helpers/paths.ts` is a
 * module-level constant, so the path graph is resolved once at import — before a test can set
 * `HHOSTED_HOME`. Every case re-imports so it reads **its own** home.
 */
async function workspace(jobs: Array<Record<string, unknown>>): Promise<{ service: JobsService, dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-jobsrun-'))
  dirs.push(dir)
  // Before `new JobsService`: the store resolves its file path in the constructor.
  process.env.HHOSTED_HOME = dir
  const hh = path.join(dir, '.hh', 'default')
  fs.mkdirSync(hh, { recursive: true })
  fs.writeFileSync(path.join(hh, 'jobs.config.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: 1 },
    jobs: jobs.map(job => ({ enabled: true, command: 'true', args: [], cwd: '.', env: {}, secretEnv: [], timeoutMs: 30_000, schedule: '0 3 * * *', ...job })),
  }))
  vi.resetModules()
  const { JobsService: Fresh } = await import('#src/services/jobs')
  return { service: new Fresh({ workspaceId: 'default' }), dir }
}

describe('running a job', () => {
  it('answers the exit code of a successful run', async () => {
    const { service } = await workspace([{ id: 'ok', command: process.execPath, args: ['-e', 'process.exitCode = 0'] }])
    const record = await service.run('ok')
    expect(record?.exitCode).toBe(0)
    expect(record?.cancelled).toBe(false)
    expect(record?.endedAt).toBeTypeOf('number')
    service.dispose()
  })

  it('answers a non-zero code as a fact, not an exception', async () => {
    const { service } = await workspace([{ id: 'bad', command: process.execPath, args: ['-e', 'process.exitCode = 7'] }])
    const record = await service.run('bad')
    expect(record?.exitCode).toBe(7)
    service.dispose()
  })

  it('records the run, so the next listing shows when it last ran', async () => {
    const { service } = await workspace([{ id: 'ok', command: process.execPath, args: ['-e', ''] }])
    await service.run('ok')
    const [listed] = service.list()
    expect(listed?.lastRunAt).toBeTypeOf('number')
    expect(listed?.lastExitCode).toBe(0)
    expect(listed?.running).toBe(false)
    service.dispose()
  })

  it('answers null for an unknown job, and for one already running', async () => {
    const { service } = await workspace([{ id: 'slow', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'] }])
    expect(await service.run('ghost')).toBeNull()

    const first = service.run('slow')
    // The second call lands inside the first.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await service.run('slow'), 'one run per job at a time').toBeNull()
    await service.stop('slow')
    await first
    service.dispose()
  })

  /**
   * A stop ends the run and marks it **cancelled**, so its non-zero status is not read as a failure.
   * The distinction matters: a person who stopped a job did not learn that the job is broken.
   */
  it('marks a stopped run cancelled rather than failed', async () => {
    const { service } = await workspace([{ id: 'slow', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }])
    const running = service.run('slow')
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(await service.stop('slow')).toBe(true)
    const record = await running
    expect(record?.cancelled).toBe(true)
    service.dispose()
  })

  it('reports a command that cannot start as a failed run', async () => {
    const { service } = await workspace([{ id: 'nope', command: 'hh-no-such-program-anywhere' }])
    const record = await service.run('nope')
    expect(record?.exitCode).toBeNull()
    expect(await service.stop('nope'), 'nothing to stop afterwards').toBe(false)
    service.dispose()
  })

  it('answers the next run from the schedule, so a page can say when', async () => {
    const { service } = await workspace([{ id: 'nightly', schedule: '0 3 * * *' }])
    const [listed] = service.list()
    expect(listed?.nextRunAt).toBeTypeOf('number')
    // A job whose schedule is in the future answers a future instant, not `null`.
    expect((listed?.nextRunAt ?? 0) > Date.now()).toBe(true)
    service.dispose()
  })

  /**
   * A run's own output goes to its **own** log file.
   *
   * It went to the panel log at DEBUG, which nobody enables — so a failed backup's own output, the one
   * thing needed to debug it, was readable nowhere. The view advertised a `logPath` nothing served.
   */
  it('writes a run\'s output to the job\'s own log, and reads it back', async () => {
    const { service } = await workspace([{ id: 'noisy', command: process.execPath, args: ['-e', 'console.log("hello from the run")'] }])
    await service.run('noisy')

    const lines = await service.readLog('noisy', 100)
    expect(lines.map(line => line.text)).toContain('hello from the run')
    // The summary line is in it too, so a log read on its own says how the run ended.
    expect(lines.some(line => /finished in \d+s/.test(line.text))).toBe(true)
    service.dispose()
  })

  it('keeps job logs apart by id, and away from each other', async () => {
    const { service } = await workspace([
      { id: 'first', command: process.execPath, args: ['-e', 'console.log("from first")'] },
      { id: 'second', command: process.execPath, args: ['-e', 'console.log("from second")'] },
    ])
    await service.run('first')
    await service.run('second')

    expect((await service.readLog('first', 100)).map(line => line.text)).not.toContain('from second')
    expect((await service.readLog('second', 100)).map(line => line.text)).toContain('from second')
    service.dispose()
  })

  /**
   * The log is served the moment the run resolves, not on a later timer.
   *
   * `LogFiles` batches writes on a 250 ms timer, so a caller that runs a job and then reads its log —
   * the API's wait-for-exit, the CLI, a page that ran and refreshed — was answered with a log that did
   * not contain the run it had just watched finish.
   */
  it('has the run\'s lines on disk when `run` resolves, with no wait', async () => {
    const { service } = await workspace([{ id: 'prompt', command: process.execPath, args: ['-e', 'console.log("immediate")'] }])
    await service.run('prompt')
    // No delay, no poll: the answer must already be there.
    expect((await service.readLog('prompt', 100)).map(line => line.text)).toContain('immediate')
    service.dispose()
  })

  /**
   * A removed job's log goes with it, so a re-declared id starts clean.
   *
   * A job id is unique only among the jobs in one file: re-declaring one under an id it used to have is
   * an ordinary edit, and inheriting a dead run's output under it is the bug the supervisor already
   * fixed for servers.
   */
  it('drops the log when the job does, so a re-declared id starts clean', async () => {
    const { service } = await workspace([{ id: 'gone', command: process.execPath, args: ['-e', 'console.log("old run")'] }])
    await service.run('gone')
    expect((await service.readLog('gone', 100)).map(line => line.text)).toContain('old run')

    service.clearLog('gone')
    expect(await service.readLog('gone', 100)).toEqual([])
    service.dispose()
  })

  it('tells a page where the log is, on the view it lists', async () => {
    const { service } = await workspace([{ id: 'located' }])
    const [listed] = service.list()
    expect(listed?.logPath).toBeTypeOf('string')
    expect(listed?.logPath?.endsWith('located.log')).toBe(true)
    service.dispose()
  })
})
