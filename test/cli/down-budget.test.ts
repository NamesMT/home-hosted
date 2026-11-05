import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { stopSchema } from '#src/shared/contracts'

// `#src/cli/down` resolves state paths at import time; keep it off the real home.
process.env.HHOSTED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-down-budget-'))
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
