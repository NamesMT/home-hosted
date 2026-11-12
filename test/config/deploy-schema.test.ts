import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { serverPatchSchema, serverSchema } from '#src/shared/contracts'

/**
 * `deploy` on a server: a list of steps, and whether to restart after them.
 *
 * The shape mirrors `bootstrap`/`dump`, which already describe "run a command with args in the
 * entry's cwd" — the panel has one idea of what a declared command is, and a deploy step is that
 * shape plus a timeout. `restart` **defaults to true**: the point of a deploy is that the running
 * process picks it up, and a default of false would make every deploy a no-op nobody noticed.
 *
 * Steps are ordered and replaced whole, like `args` and `backupPaths` — a deploy is a sequence, and
 * merging two sequences key by key would interleave them.
 */
describe('the deploy schema', () => {
  it('accepts ordered steps, each a command with args, cwd and a timeout', () => {
    const entry = {
      id: 'web',
      command: 'node',
      deploy: {
        steps: [
          { command: 'git', args: ['pull'] },
          { command: 'pnpm', args: ['install'], cwd: '/srv/web', timeoutMs: 60000 },
        ],
      },
    }
    expect(serverSchema(entry) instanceof type.errors).toBe(false)
  })

  it('defaults every step field, and `restart` to true', () => {
    const parsed = serverSchema({ id: 'web', command: 'node', deploy: { steps: [{ command: 'make' }] } }) as {
      deploy: { steps: Array<{ args: string[], timeoutMs: number }>, restart: boolean }
    }
    expect(parsed.deploy.steps[0]!.args).toEqual([])
    expect(parsed.deploy.steps[0]!.timeoutMs).toBeGreaterThan(0)
    // A deploy exists to make the running process pick up the change.
    expect(parsed.deploy.restart).toBe(true)
  })

  it('refuses an empty step list, a missing command, and a too-short timeout', () => {
    expect(serverSchema({ id: 'web', command: 'node', deploy: { steps: [] } }) instanceof type.errors).toBe(true)
    expect(serverSchema({ id: 'web', command: 'node', deploy: { steps: [{ args: ['x'] }] } }) instanceof type.errors).toBe(true)
    expect(serverSchema({ id: 'web', command: 'node', deploy: { steps: [{ command: 'make', timeoutMs: 10 }] } }) instanceof type.errors).toBe(true)
  })

  it('is optional, and absent by default', () => {
    const parsed = serverSchema({ id: 'web', command: 'node' }) as { deploy?: unknown }
    expect(parsed.deploy).toBeUndefined()
  })

  it('carries no defaults in the patch — a patch sends what it means to keep', () => {
    // The group is replaced whole, so defaults here would re-arm a deploy nobody edited.
    const patch = serverPatchSchema({ deploy: { steps: [{ command: 'make' }] } }) as { deploy: { steps: Array<Record<string, unknown>> } }
    expect(patch.deploy.steps[0]).toEqual({ command: 'make' })
    expect(patch.deploy).not.toHaveProperty('restart')
  })

  it('is nulled by the patch, like every other group', () => {
    expect(serverPatchSchema({ deploy: null }) instanceof type.errors).toBe(false)
  })
})
