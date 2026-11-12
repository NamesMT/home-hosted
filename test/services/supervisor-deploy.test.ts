import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSupervisor, runCleanups, view, waitFor, waitForStatus } from '../support/supervisor-harness'

afterEach(runCleanups)

/**
 * The supervisor's half of a deploy: one at a time, a restart after it, and a failed step that
 * leaves the running process alone.
 *
 * The steps themselves are `test/services/deploy.test.ts`. What matters here is what the supervisor
 * does **around** them — because a deploy that ran twice at once, or that stopped a healthy service
 * on its way to failing, is worse than one that was never offered.
 */
describe('a deploy through the supervisor', () => {
  /** An entry that runs for ever, with a deploy step writing a marker. */
  function deployable(dir: string, steps: Array<{ command: string, args?: string[] }>): Record<string, unknown> {
    return {
      id: 'app',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      port: null,
      restart: { enabled: false },
      health: { enabled: false },
      deploy: { steps, restart: true },
    }
  }

  it('restarts the running entry after a successful deploy', async () => {
    const harness = await makeSupervisor([])
    const marker = path.join(harness.dir, 'deployed.txt')
    harness.store.addServer(deployable(harness.dir, [
      { command: process.execPath, args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes")`] },
    ]) as never)
    await harness.supervisor.start('app')
    await waitForStatus(harness.supervisor, 'app', 'running')
    const before = view(harness.supervisor, 'app').pid

    const result = await harness.supervisor.deploy('app')
    expect(result.ok, result.error).toBe(true)
    expect(fs.readFileSync(marker, 'utf8'), 'the step ran').toBe('yes')

    // A deploy exists to make the process pick the change up, so it restarts by default.
    await waitFor(() => view(harness.supervisor, 'app').pid !== before && view(harness.supervisor, 'app').status === 'running')
    const after = view(harness.supervisor, 'app')
    expect(after.deploy?.lastOutcome).toBe('ok')
    // The restart is recorded, and the deploy's own event is in history.
    expect(harness.history.all().some(event => event.serverId === 'app' && event.type === 'deploy' && event.outcome === 'ok')).toBe(true)
  }, 45_000)

  it('keeps the old process running when a step fails, and notifies', async () => {
    const harness = await makeSupervisor([])
    harness.store.addServer(deployable(harness.dir, [
      { command: process.execPath, args: ['-e', 'process.exitCode = 7'] },
    ]) as never)
    await harness.supervisor.start('app')
    await waitForStatus(harness.supervisor, 'app', 'running')
    const pid = view(harness.supervisor, 'app').pid

    const result = await harness.supervisor.deploy('app')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('code 7')

    // Half-deployed is the state this exists to avoid: the old process is what a person still has.
    expect(view(harness.supervisor, 'app').pid, 'the running process was not restarted').toBe(pid)
    expect(view(harness.supervisor, 'app').status).toBe('running')
    expect(view(harness.supervisor, 'app').deploy?.lastOutcome).toBe('failed')

    const events = harness.history.all().filter(event => event.serverId === 'app' && event.type === 'deploy')
    expect(events).toHaveLength(1)
    expect(events[0]!.outcome).toBe('failed')
  }, 45_000)

  it('refuses a second deploy while one is running', async () => {
    const harness = await makeSupervisor([])
    harness.store.addServer(deployable(harness.dir, [
      // Long enough that the second call lands inside the first.
      { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'] },
    ]) as never)

    const first = harness.supervisor.deploy('app')
    // Let the first one take the flag before the second asks.
    await waitFor(() => view(harness.supervisor, 'app').deploy?.running === true, 10_000)
    const second = await harness.supervisor.deploy('app')
    expect(second.ok).toBe(false)
    expect(second.code).toBe('DEPLOY_RUNNING')

    expect((await first).ok, 'the first deploy still finished').toBe(true)
  }, 45_000)

  it('refuses an entry with no deploy steps', async () => {
    const harness = await makeSupervisor([{ id: 'plain', command: process.execPath, args: ['-e', ''], port: null }])
    const result = await harness.supervisor.deploy('plain')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('NO_DEPLOY')
    void view
  })
})

/**
 * A deploy step sees the **entry's own environment**, not a subset of it.
 *
 * The review measured `PLAIN=from-config` present but `envFile` and `secretEnv` both empty, which
 * contradicted both the code's comment and `docs/SERVERS.md` — a deploy needing a registry token
 * silently ran without it. The step below writes what it sees to a file, so the assertion is about
 * the child's real environment rather than the panel's intent.
 */
describe('the environment a step runs with', () => {
  it('carries env, envFile and a declared secret', async () => {
    const harness = await makeSupervisor([])
    const out = path.join(harness.dir, 'env.json')
    harness.secrets.setServerEnv('app', { REGISTRY_TOKEN: 'from-secret' })
    const envFile = path.join(harness.dir, 'app.env')
    fs.writeFileSync(envFile, 'FROM_FILE=from-file\n')

    harness.store.addServer({
      id: 'app',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      port: null,
      restart: { enabled: false },
      health: { enabled: false },
      env: { PLAIN: 'from-config' },
      envFile,
      secretEnv: ['REGISTRY_TOKEN'],
      deploy: {
        steps: [{
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ plain: process.env.PLAIN, file: process.env.FROM_FILE, secret: process.env.REGISTRY_TOKEN }))`],
        }],
        restart: false,
      },
    } as never)

    const result = await harness.supervisor.deploy('app')
    expect(result.ok, result.error).toBe(true)
    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, string | undefined>
    expect(seen.plain, 'the tracked env').toBe('from-config')
    expect(seen.file, 'envFile is part of the entry\'s environment').toBe('from-file')
    expect(seen.secret, 'and so is a declared secret').toBe('from-secret')
  }, 45_000)
})

/**
 * A stop during a deploy is **not** a failed deploy.
 *
 * A stopped deploy used to take the same `outcome.ok === false` branch as a broken step, so it
 * notified the crash channel and recorded `outcome: failed` — telling a person something broke when
 * they were the one who stopped it. The job path already draws this distinction (`cancelled`), and
 * the deploy path now does too.
 */
describe('a deploy that a stop interrupts', () => {
  it('records and reports it as stopped, not as failed', async () => {
    const harness = await makeSupervisor([])
    harness.store.addServer({
      id: 'app',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      port: null,
      restart: { enabled: false },
      health: { enabled: false },
      deploy: {
        steps: [{ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 25_000 }],
        restart: false,
      },
    } as never)
    await harness.supervisor.start('app')
    await waitForStatus(harness.supervisor, 'app', 'running')

    const deploying = harness.supervisor.deploy('app')
    await waitFor(() => view(harness.supervisor, 'app').deploy?.running === true, 10_000)
    await harness.supervisor.stop('app')
    const result = await deploying

    expect(result.ok).toBe(false)
    expect(result.error, 'the sentence says it was stopped').toMatch(/stopped/i)
    expect(result.error).not.toMatch(/timed out|exit code/)
    void waitForStatus
  }, 45_000)
})
