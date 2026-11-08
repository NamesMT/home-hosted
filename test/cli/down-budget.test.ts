import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { stopSchema } from '#src/shared/contracts'

// `#src/cli/down` resolves state paths at import time; keep it off the real home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-down-budget-'))
process.env.HHOSTED_HOME = home
// Swept, not leaked: a full run leaves one of these per execution.
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const { forceStopCommand, shutdownBudgetMs } = await import('#src/cli/down')

/**
 * `down` forces the panel once its wait runs out, so that wait has to cover the stops the panel is
 * still doing: a fixed 20s SIGKILLed a panel whose entry had a 30s grace, mid-shutdown.
 */
function entry(overrides: { command?: string, args?: string[], persistent?: boolean, stop?: Record<string, unknown> } = {}) {
  return {
    command: overrides.command ?? 'node',
    args: overrides.args ?? ['server.js'],
    persistent: overrides.persistent ?? false,
    stop: stopSchema.assert(overrides.stop ?? {}),
  }
}

describe('the time down gives the panel to stop', () => {
  it('keeps the old 20s as a floor', () => {
    expect(shutdownBudgetMs([], false)).toBe(20_000)
    expect(shutdownBudgetMs([entry()], false)).toBe(20_000)
  })

  it('outlasts the slowest grace, since the panel stops entries concurrently', () => {
    const budget = shutdownBudgetMs([entry({ stop: { graceMs: 30_000 } }), entry({ stop: { graceMs: 1000 } })], false)
    expect(budget).toBeGreaterThan(32_000)
    expect(budget).toBeLessThan(60_000)
  })

  it('allows for a compose stack’s docker stop', () => {
    expect(shutdownBudgetMs([entry({ command: 'docker', args: ['compose', 'up'] })], false)).toBeGreaterThan(120_000)
  })

  it('counts a persistent entry only when the panel is asked to stop it', () => {
    const slow = entry({ persistent: true, stop: { graceMs: 60_000 } })
    expect(shutdownBudgetMs([slow], false)).toBe(20_000)
    expect(shutdownBudgetMs([slow], true)).toBeGreaterThan(62_000)
  })

  it('is bounded', () => {
    expect(shutdownBudgetMs([entry({ stop: { graceMs: 24 * 3600_000 } })], false)).toBe(10 * 60_000)
  })
})

describe('the forced stop', () => {
  it('ends only the panel on Windows, not the tree its persistent nannies hang off', () => {
    const command = forceStopCommand(4242, 'win32')
    expect(command?.[0]).toBe('taskkill')
    expect(command?.[1]).toContain('/F')
    expect(command?.[1]).not.toContain('/T')
  })

  it('is a signal elsewhere', () => {
    expect(forceStopCommand(4242, 'linux')).toBeNull()
  })
})

/**
 * A config `down` cannot read makes the stop budget *unknowable*, not empty.
 *
 * `WorkspaceStore.load()` reports a broken `servers.config.json` in `configError` rather than
 * throwing, so a reader built on it returned `servers: []` — and `shutdownBudgetMs([])` is the 20 s
 * floor. That reinstated, through a different door, the fixed 20 s wait this whole change replaced:
 * an entry with a 120 s grace was SIGKILLed mid-shutdown whenever its file happened to be malformed.
 * The widened wait is the safe direction: too long costs a slower `down`, too short kills a panel
 * still inside a grace the person configured.
 */
describe('a config the CLI cannot read', () => {
  it('widens the budget to the ceiling instead of collapsing to the floor', async () => {
    const { serversReader } = await import('#src/cli/down') as unknown as {
      serversReader: () => Promise<(id: string) => { servers: unknown[], complete: boolean }>
    }
    const read = await serversReader()
    // The scratch home has no config at all: nothing declared is a real answer, so this is complete.
    expect(read('default')).toEqual({ servers: [], complete: true })
  })

  it('reports a broken servers file as incomplete rather than empty', async () => {
    const broken = path.join(home, '.hh', 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'servers.config.json'), '{ not json')
    const { serversReader } = await import('#src/cli/down') as unknown as {
      serversReader: () => Promise<(id: string) => { servers: unknown[], complete: boolean }>
    }
    const read = await serversReader()
    const result = read('broken')
    expect(result.complete, 'a file that does not parse is not "no servers"').toBe(false)
    expect(result.servers).toEqual([])
  })
})

/**
 * The other door to the same SIGKILL: a **valid** config whose grace lives in the workspace's
 * `defaults` block.
 *
 * The panel resolves a `servers.config.json` through `WorkspaceStore`, which passes the workspace
 * settings' `defaults` into `parseServersFile`. `down` passed `{}`, so it saw only each entry's own
 * `stop` — a workspace declaring `defaults.stop.graceMs: 120000` with an entry that spells none
 * measured a 20 s budget against the 132 s the panel needed. Same failure as the malformed case
 * above, reached through a config that is perfectly good.
 */
describe('a grace declared in the workspace defaults', () => {
  it('reaches the budget, so down does not SIGKILL a panel mid-grace', async () => {
    const id = 'defaults-grace'
    const dir = path.join(home, '.hh', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      meta: { writtenBy: 'test', schema: 2 },
      defaults: { stop: { graceMs: 120_000 } },
    }))
    fs.writeFileSync(path.join(dir, 'servers.config.json'), JSON.stringify({
      meta: { writtenBy: 'test', schema: 2 },
      servers: [{ id: 'web', command: 'node', args: ['server.js'] }],
    }))

    const { serversReader } = await import('#src/cli/down') as unknown as {
      serversReader: () => Promise<(id: string) => { servers: ReturnType<typeof entry>[], complete: boolean }>
    }
    const read = await serversReader()
    const result = read(id)
    expect(result.complete, 'the fixture parses').toBe(true)
    expect(result.servers, 'the fixture declares one entry').toHaveLength(1)
    expect(result.servers[0]!.stop.graceMs, 'the defaults grace is resolved, as the panel resolves it').toBe(120_000)
    expect(shutdownBudgetMs(result.servers, false), 'and the budget covers it').toBeGreaterThan(120_000)
  })
})
