import { spawn } from 'node:child_process'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanups, freePort, httpServerConfig, makeSupervisor, portAccepts, runCleanups, view } from '../support/supervisor-harness'

/**
 * A process that outlives SIGKILL cannot be made on purpose (it takes uninterruptible sleep or a pid
 * this user may not signal), so liveness is the seam: the pids in `immortal` read as alive whatever
 * happened to them. Everything else — the stop, the escalation, the verdict — runs for real.
 *
 * `recycled` is the other half of the same seam: a pid that answers signal 0 but was born *after*
 * the run it is supposed to belong to, which is what the OS does when it hands a dead process's pid
 * to an unrelated one.
 */
const immortal = new Set<number>()
const recycled = new Set<number>()
vi.mock('#src/providers/port', async (importOriginal) => {
  const original = await importOriginal<typeof import('#src/providers/port')>()
  return {
    ...original,
    isProcessAlive: (pid: number) => immortal.has(pid) || original.isProcessAlive(pid),
    // The verdict has to agree with the lie above, and with `recycled` — a real process this test
    // SIGKILLs is a zombie its own parent has not reaped yet, which `processLiveness` correctly
    // calls `'gone'`; the seam is what makes it "one that outlived the stop".
    processLiveness: async (...args: Parameters<typeof original.processLiveness>) => {
      if (recycled.has(args[0]))
        return 'recycled' as const
      if (immortal.has(args[0]))
        return 'live' as const
      return original.processLiveness(...args)
    },
  }
})

afterEach(async () => {
  immortal.clear()
  recycled.clear()
  await runCleanups()
})

/** An entry adopted from a detached successor of its own, the way a panel restart finds one. */
async function adoptedEntry(): Promise<{ supervisor: Awaited<ReturnType<typeof makeSupervisor>>['supervisor'], successorPid: number, history: Awaited<ReturnType<typeof makeSupervisor>>['history'] }> {
  const port = await freePort()
  const harness = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'follow', stop: { graceMs: 200 } })])
  const successor = spawn(process.execPath, httpServerConfig(port).args as string[], {
    env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
    stdio: 'ignore',
  })
  const successorPid = successor.pid!
  cleanups.push(() => {
    try {
      process.kill(successorPid, 'SIGKILL')
    }
    catch {
      // already gone
    }
  })
  while (!(await portAccepts(port)))
    await new Promise(resolve => setTimeout(resolve, 50))
  await harness.supervisor.start('web')
  expect(view(harness.supervisor, 'web').adopted, 'the fixture must be an adopted successor').toBe(true)
  return { supervisor: harness.supervisor, successorPid, history: harness.history }
}

describe('a process that survives its stop', () => {
  /**
   * The survivor check ran for persistent entries only, so a non-persistent pid that outlived SIGKILL
   * was answered `stopped` — and a later start "adopted" it as a fresh detached successor.
   */
  it('is a conflict for a non-persistent entry too, never "stopped"', async () => {
    const { supervisor, successorPid } = await adoptedEntry()
    immortal.add(successorPid)

    const result = await supervisor.stop('web')
    expect(result.ok).toBe(false)
    expect(result.error).toContain(`pid ${successorPid} survived the stop`)
    expect(view(supervisor, 'web').status).toBe('conflict')
  })

  /**
   * `restart()` ignored the stop's answer and started anyway: beside a survivor that is a duplicate
   * server, or the survivor adopted back as if nothing had happened.
   */
  it('ends a restart with the stop\'s refusal, keeping the survivor\'s pid', async () => {
    const { supervisor, successorPid, history } = await adoptedEntry()
    immortal.add(successorPid)
    const starts = history.all().filter(event => event.type === 'start').length

    const result = await supervisor.restart('web')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('survived the stop')
    const after = view(supervisor, 'web')
    expect(after.status).toBe('conflict')
    expect(after.pid, 'the survivor stays this entry\'s, so nothing starts beside it').toBe(successorPid)
    expect(history.all().filter(event => event.type === 'start').length, 'no second process was spawned').toBe(starts)
    expect(supervisor.logLines('web').filter(line => line.text.startsWith('adopted pid')), 'not adopted again').toHaveLength(1)
  })

  /**
   * A pid that answers signal 0 is not a survivor when the OS recycled it.
   *
   * `isProcessAlive` alone decided this verdict, and `AGENTS.md` names the consequence: a dead run's
   * pid, handed to an unrelated process, was reported as `pid N survived the stop`. The entry then
   * kept that pid, published `conflict`, and refused every later start "beside a survivor" that is
   * nobody's — a permanently stuck entry caused by a pid the panel does not own. The birth stamp was
   * already in hand (`entry.startedAt`); this is the verdict that has to read it.
   */
  it('is not a survivor when the pid was recycled to another process', async () => {
    const { supervisor, successorPid } = await adoptedEntry()
    // Alive (signal 0 answers), but born after the run this entry records.
    immortal.add(successorPid)
    recycled.add(successorPid)

    const result = await supervisor.stop('web')
    expect(result.ok, `a stranger holding a recycled pid is not this entry's survivor: ${result.error}`).toBe(true)
    const after = view(supervisor, 'web')
    expect(after.status).toBe('stopped')
    expect(after.pid, 'the recycled pid must not stay on this entry').toBeNull()
    expect(after.lastError).toBeNull()
  })
})
