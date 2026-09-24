import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { serverSchema } from '#src/shared/contracts'
import { diffServerConfig } from '#src/shared/patch-diff'

function config(overrides: Record<string, unknown> = {}) {
  const parsed = serverSchema({ id: 'web', command: 'node', port: 4000, ...overrides })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return { ...parsed, port: parsed.port ?? null }
}

describe('diffServerConfig', () => {
  it('returns an empty patch when nothing changed', () => {
    const current = config()
    const patch = diffServerConfig(current, {
      label: '',
      command: 'node',
      args: [],
      cwd: '.',
      env: {},
      port: 4000,
      bind: 'local',
      onPortConflict: 'block',
      logBufferLines: 500,
      enabled: true,
      autostart: false,
      restart: { enabled: true, maxRetries: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 30000, resetAfterMs: 60000 },
      health: { enabled: true, intervalMs: 5000, timeoutMs: 1500, unhealthyThreshold: 3, forceRestartAfterMs: 0, startTimeoutMs: 20000 },
      stop: { signal: 'SIGTERM', killGroup: true, graceMs: 5000, killPortHolders: false },
      bootstrap: null,
    })
    expect(patch).toEqual({})
  })

  it('keeps only the nested sub-keys that changed', () => {
    const current = config()
    const patch = diffServerConfig(current, { restart: { maxRetries: 9 } })
    expect(patch).toEqual({ restart: { maxRetries: 9 } })
  })

  it('does not freeze inherited defaults into the file', () => {
    const current = config({ restart: { maxRetries: 5 } })
    // Form echoes the effective value back for an untouched field.
    const patch = diffServerConfig(current, { restart: { maxRetries: 5 } })
    expect(patch).toEqual({})
  })

  it('treats an absent label and an empty label as the same', () => {
    expect(diffServerConfig(config(), { label: '' })).toEqual({})
    expect(diffServerConfig(config({ label: 'Web' }), { label: '' })).toEqual({ label: '' })
  })

  it('reports scalar, array and record changes', () => {
    const current = config({ args: ['--one'], env: { A: '1' } })
    expect(diffServerConfig(current, { port: 4100 })).toEqual({ port: 4100 })
    expect(diffServerConfig(current, { args: ['--two'] })).toEqual({ args: ['--two'] })
    expect(diffServerConfig(current, { env: { A: '2' } })).toEqual({ env: { A: '2' } })
    expect(diffServerConfig(current, { port: null })).toEqual({ port: null })
  })

  it('round-trips a bootstrap add and removal', () => {
    const withoutBootstrap = config()
    const added = { command: 'mkdir', args: ['-p', 'x'], env: {}, timeoutMs: 10000, runOnce: true }
    expect(diffServerConfig(withoutBootstrap, { bootstrap: added })).toEqual({ bootstrap: added })

    const withBootstrap = config({ bootstrap: added })
    expect(diffServerConfig(withBootstrap, { bootstrap: added })).toEqual({})
    expect(diffServerConfig(withBootstrap, { bootstrap: null })).toEqual({ bootstrap: null })
  })
})
