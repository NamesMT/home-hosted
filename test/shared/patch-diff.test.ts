import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { serverSchema } from '#src/shared/contracts'
import { countLeaves, describeChanges, diffFields, diffServerConfig, flattenLeaves } from '#src/shared/patch-diff'

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

describe('change review', () => {
  it('flattens nested groups into dotted leaf paths', () => {
    expect(flattenLeaves({ a: { b: 1, c: { d: 'x' } }, e: [1, 2] })).toEqual([
      { path: 'a.b', value: 1 },
      { path: 'a.c.d', value: 'x' },
      { path: 'e', value: [1, 2] },
    ])
    expect(flattenLeaves({ health: { http: { path: '/x' } }, enabled: false }))
      .toEqual([{ path: 'health.http.path', value: '/x' }, { path: 'enabled', value: false }])
  })

  it('pairs every changed leaf with what it was', () => {
    const changes = describeChanges(
      { port: 4100, restart: { maxRetries: 9 }, env: { A: '2' } },
      { port: 4000, restart: { maxRetries: 3 }, env: { A: '1' } },
    )

    expect(changes).toEqual([
      { path: 'port', from: 4000, to: 4100 },
      { path: 'restart.maxRetries', from: 3, to: 9 },
      { path: 'env.A', from: '1', to: '2' },
    ])
  })

  it('reports a value the snapshot does not have as undefined', () => {
    expect(describeChanges({ backupIgnoreGenerated: false }, {})).toEqual([
      { path: 'backupIgnoreGenerated', from: undefined, to: false },
    ])
  })

  it('counts leaves, not top-level keys, and treats arrays as one', () => {
    expect(countLeaves({})).toBe(0)
    expect(countLeaves({ port: 1 })).toBe(1)
    expect(countLeaves({ restart: { maxRetries: 9, factor: 3 } })).toBe(2)
    expect(countLeaves({ args: ['a', 'b'], health: { http: { path: '/x' } } })).toBe(2)
  })
})

describe('nested group comparison', () => {
  const current = {
    health: {
      enabled: true,
      http: { path: '/healthz', method: 'GET', expectStatus: null, expectStatusBelow: 400, expectBody: '' },
    },
  }

  it('does not report an object member that is only a different object', () => {
    const next = {
      health: {
        enabled: true,
        http: { path: '/healthz', method: 'GET', expectStatus: null, expectStatusBelow: 400, expectBody: '' },
      },
    }

    expect(diffFields(current, next, ['health'])).toEqual({})
  })

  it('reports a member that really changed, and only that one', () => {
    const next = {
      health: {
        enabled: true,
        http: { path: '/ready', method: 'GET', expectStatus: null, expectStatusBelow: 400, expectBody: '' },
      },
    }

    expect(diffFields(current, next, ['health'])).toEqual({ health: { http: next.health.http } })
  })

  it('treats a null the form carries as the absent key it is', () => {
    const withStatus = { health: { ...current.health, http: { ...current.health.http, expectStatus: 200 } } }
    const withoutStatus = { health: { ...current.health, http: { ...current.health.http } } }

    expect(diffFields(current, withoutStatus, ['health'])).toEqual({})
    // Clearing a value the config does have is still a change.
    expect(diffFields(withStatus, withoutStatus, ['health'])).toEqual({ health: { http: withoutStatus.health.http } })
  })

  it('ignores key order, which a rebuilt form cannot be trusted to keep', () => {
    const a = { health: { enabled: true, http: { path: '/', method: 'GET' } } }
    const b = { health: { enabled: true, http: { method: 'GET', path: '/' } } }

    expect(diffFields(a, b, ['health'])).toEqual({})
  })

  it('ignores a null member inside a group member the form rebuilt', () => {
    // The reported bug: a fresh console editor listed every `health.http.*` row
    // with identical values, because the config has no `expectStatus` key and the
    // form carries `expectStatus: null`.
    const configured = {
      health: {
        enabled: true,
        http: { path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
        intervalMs: 3000,
      },
    }
    const fromForm = {
      health: {
        enabled: true,
        http: { path: '/', method: 'GET', expectStatus: null, expectStatusBelow: 400, expectBody: '' },
        intervalMs: 3000,
      },
    }

    expect(diffFields(configured, fromForm, ['health'])).toEqual({})
    // …and clearing a value the config does have is still a change.
    const withStatus = { health: { ...configured.health, http: { ...configured.health.http, expectStatus: 200 } } }
    expect(diffFields(withStatus, fromForm, ['health']))
      .toEqual({ health: { http: fromForm.health.http } })
  })

  it('keeps a top-level null as the explicit clear it is', () => {
    expect(diffFields({ bootstrap: { command: 'x' } }, { bootstrap: null })).toEqual({ bootstrap: null })
    expect(diffFields({ bootstrap: null }, { bootstrap: null })).toEqual({})
  })
})
