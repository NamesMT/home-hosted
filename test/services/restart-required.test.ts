import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSupervisor, runCleanups, view, waitForStatus } from '../support/supervisor-harness'

afterEach(runCleanups)

/**
 * A config change that needs a restart says so, instead of being silently inert.
 *
 * `PUT`/`PATCH /api/servers/:id` writes config only — the running process keeps the command, args,
 * cwd, env and port it was started with. So a person renames the program, saves, sees "saved", and
 * the entry keeps serving the old one with nothing anywhere saying the change is not in effect. The
 * view carries `restartRequired` now: true when the running process was started from a config that
 * differs in a field a restart actually re-reads.
 *
 * The comparison is against the config **the run started from**, recorded at spawn/adopt — not
 * against the previous config file, which a second edit would move out from under it.
 */
/**
 * `restartRequired` is **absent** when false — an optional response field the board omits rather
 * than sends as `false`, the same way `adopted` and `stoppedByPanel` are. The helper keeps the
 * assertions readable and states that reading.
 */
function requiresRestart(supervisor: Parameters<typeof view>[0], id = 'web'): boolean {
  return view(supervisor, id).restartRequired ?? false
}

describe('restartRequired', () => {
  const base = (): Record<string, unknown> => ({
    id: 'web',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    port: null,
    restart: { enabled: false },
    health: { enabled: false },
  })

  it('is false while the running config is the current one', async () => {
    const harness = await makeSupervisor([base()])
    await harness.supervisor.start('web')
    await waitForStatus(harness.supervisor, 'web', 'running')

    expect(requiresRestart(harness.supervisor)).toBe(false)
  })

  it('is true once a field that needs a restart changes', async () => {
    const harness = await makeSupervisor([base()])
    await harness.supervisor.start('web')
    await waitForStatus(harness.supervisor, 'web', 'running')

    // The store's own change event is what runs `sync()`, so this is the real path a save takes.
    harness.store.updateServer('web', { args: ['-e', 'setInterval(() => {}, 2000)'] })

    expect(requiresRestart(harness.supervisor), 'the running process still has the old args').toBe(true)
  })

  it('is false again after the restart it asked for', async () => {
    const harness = await makeSupervisor([base()])
    await harness.supervisor.start('web')
    await waitForStatus(harness.supervisor, 'web', 'running')

    // The store's own change event is what runs `sync()`, so this is the real path a save takes.
    harness.store.updateServer('web', { args: ['-e', 'setInterval(() => {}, 2000)'] })
    expect(requiresRestart(harness.supervisor)).toBe(true)

    await harness.supervisor.restart('web')
    await waitForStatus(harness.supervisor, 'web', 'running')
    expect(requiresRestart(harness.supervisor)).toBe(false)
  })

  /** A label is not a reason to restart: it changes nothing the process reads. */
  it('ignores a change that does not need a restart', async () => {
    const harness = await makeSupervisor([base()])
    await harness.supervisor.start('web')
    await waitForStatus(harness.supervisor, 'web', 'running')

    harness.store.updateServer('web', { label: 'my web app' })

    expect(requiresRestart(harness.supervisor)).toBe(false)
  })

  it('is false for an entry that is not running', async () => {
    const harness = await makeSupervisor([base()])
    expect(requiresRestart(harness.supervisor)).toBe(false)
  })
})
