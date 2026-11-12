import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { runDeploy } from '#src/services/deploy'

/**
 * A deploy runs its steps in order, in the entry's cwd, and **stops at the first failure**.
 *
 * The last half is the one that matters: a half-deployed service is worse than an unchanged one, so
 * a failed step ends the sequence, says which step it was, and leaves the running process alone. A
 * deploy that carried on would install the second half of something nobody chose.
 *
 * The steps are real child processes — the panel's own `spawnManaged` — so this exercises the same
 * path a deploy takes in production, including its process group.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-deploy-'))
  dirs.push(dir)
  return dir
}

/** A config with these steps, and the log lines they produced. */
function configWith(dir: string, steps: Array<{ command: string, args?: string[], cwd?: string, timeoutMs?: number }>, restart = true) {
  const lines: string[] = []
  return {
    lines,
    config: {
      id: 'app',
      command: process.execPath,
      args: [],
      cwd: dir,
      env: {},
      dataEnvs: {},
      deploy: { steps: steps.map(step => ({ args: [], timeoutMs: 15_000, ...step })), restart },
    } as never,
    context: {
      log: (_stream: string, text: string) => {
        lines.push(text)
      },
      // The entry's own environment, as the supervisor supplies it. Empty here because these steps
      // need none; the environment itself is `test/services/supervisor-deploy.test.ts`.
      env: () => ({}),
    },
  }
}

describe('running a deploy', () => {
  it('runs every step in order and reports success', async () => {
    const dir = await scratch()
    const out = path.join(dir, 'order.txt')
    const { config, context } = configWith(dir, [
      { command: process.execPath, args: ['-e', `require("node:fs").appendFileSync(${JSON.stringify(out)}, "one\\n")`] },
      { command: process.execPath, args: ['-e', `require("node:fs").appendFileSync(${JSON.stringify(out)}, "two\\n")`] },
    ])

    const outcome = await runDeploy(config as never, { cancelled: () => false }, context)

    expect(outcome.ok).toBe(true)
    expect(outcome.failedStep).toBeUndefined()
    expect(fs.readFileSync(out, 'utf8'), 'the steps ran in order').toBe('one\ntwo\n')
    // Every step is named in the log, so a person can see what a deploy did.
    expect(context.log).toBeDefined()
  })

  it('stops at the first failure and names the step', async () => {
    const dir = await scratch()
    const out = path.join(dir, 'after.txt')
    const { config } = configWith(dir, [
      { command: process.execPath, args: ['-e', 'process.exitCode = 3'] },
      // This one must never run: the deploy failed before it.
      { command: process.execPath, args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(out)}, "ran")`] },
    ])
    const lines: string[] = []

    const outcome = await runDeploy(config as never, { cancelled: () => false }, { log: (_s, text) => lines.push(text), env: () => ({}) })

    expect(outcome.ok).toBe(false)
    expect(outcome.failedStep).toBe(1)
    expect(outcome.error).toContain('code 3')
    expect(fs.existsSync(out), 'a failed deploy must not run the rest').toBe(false)
    expect(lines.join('\n')).toContain('deploy failed')
  })

  it('reports a step that cannot start, rather than throwing', async () => {
    const dir = await scratch()
    const { config } = configWith(dir, [{ command: 'hh-definitely-not-a-program' }])
    const outcome = await runDeploy(config as never, { cancelled: () => false }, { log: () => {}, env: () => ({}) })
    expect(outcome.ok).toBe(false)
    expect(outcome.failedStep).toBe(1)
    // The message names the program, so a person knows what to fix.
    expect(outcome.error).toMatch(/hh-definitely-not-a-program|ENOENT|not found/i)
  })

  it('stops when the deploy is cancelled, even between steps', async () => {
    const dir = await scratch()
    const out = path.join(dir, 'never.txt')
    let cancels = 0
    const { config } = configWith(dir, [
      { command: process.execPath, args: ['-e', 'process.exitCode = 0'] },
      { command: process.execPath, args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(out)}, "ran")`] },
    ])

    // Cancelled after the first step, which is the stop that lands mid-deploy.
    const outcome = await runDeploy(config as never, { cancelled: () => cancels++ >= 2 }, { log: () => {}, env: () => ({}) })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('stopped')
    expect(fs.existsSync(out)).toBe(false)
  })

  it('refuses an entry with no steps', async () => {
    const dir = await scratch()
    const outcome = await runDeploy({ id: 'app', command: 'node', deploy: null } as never, { cancelled: () => false }, { log: () => {}, env: () => ({}) })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('no deploy steps')
    void dir
  })

  it('kills a step that outruns its timeout', async () => {
    const dir = await scratch()
    const { config } = configWith(dir, [
      // Ignores SIGTERM-free exits: it just sleeps past the timeout.
      { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 1000 },
    ])
    const started = Date.now()
    const outcome = await runDeploy(config as never, { cancelled: () => false }, { log: () => {}, env: () => ({}) })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('timed out')
    // And it actually ended the process rather than waiting out the sleep.
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

/**
 * A stop **interrupts a step in flight**, rather than waiting out its timeout.
 *
 * The shipped test only cancelled *between* steps, which already worked, so it never exercised this.
 * Measured before the fix: cancelling 200 ms into a 30-second step returned after 30,011 ms with the
 * child still exiting 0 — a `pnpm install` kept writing to the tree long after someone stopped the
 * service, and `POST /stop` appeared to hang for minutes.
 *
 * The step here is a real sleeping child, so this is the process the supervisor would have to kill.
 */
describe('a stop during a step', () => {
  it('ends the step promptly instead of waiting for its timeout', async () => {
    const dir = await scratch()
    const { config } = configWith(dir, [
      { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 55_000 },
    ])

    let cancelled = false
    const started = Date.now()
    // Cancel shortly after the step has spawned.
    const timer = setTimeout(() => {
      cancelled = true
    }, 200)
    const outcome = await runDeploy(config, { cancelled: () => cancelled }, { log: () => {}, env: () => ({}) })
    clearTimeout(timer)
    const elapsed = Date.now() - started

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('stopped')
    // The point of the fix: it returns in the region of the poll, not in the region of the timeout.
    expect(elapsed, `took ${elapsed}ms — a stop must not wait out the step`).toBeLessThan(5_000)
  })

  it('still reports the step that failed when nothing cancelled it', async () => {
    const dir = await scratch()
    const { config } = configWith(dir, [{ command: process.execPath, args: ['-e', 'process.exitCode = 9'] }])
    const outcome = await runDeploy(config, { cancelled: () => false }, { log: () => {}, env: () => ({}) })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('code 9')
    void dir
  })
})
