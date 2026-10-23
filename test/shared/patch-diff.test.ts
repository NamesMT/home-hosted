import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { serverSchema } from '#src/shared/contracts'
import { countLeaves, describeChanges, diffFields, diffServerConfig, flattenLeaves, mergeReplacedList, replacedListConflicts } from '#src/shared/patch-diff'

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

/**
 * A list a patch **replaces** is all-or-nothing on the wire: what a save sends becomes the whole
 * list. So "did this form change it?" must be answered against the list the form was *filled with*,
 * never against live state — live state moving is what another client's save looks like.
 *
 * Measured on the built panel, two clients on one workspace settings page: with the page open on
 * `alpha`, a second client added `beta`, and saving an unrelated policy toggle on the first page
 * removed `beta` from `settings.json`. `destinations` and `routes` are both replaced lists.
 */
describe('mergeReplacedList — a replaced list survives a concurrent save', () => {
  const key = (entry: { id: string }): string => entry.id

  it('sends nothing when the form never touched the list', () => {
    const filled = [{ id: 'alpha' }]
    expect(mergeReplacedList({ filled, draft: [{ id: 'alpha' }], live: [{ id: 'alpha' }, { id: 'beta' }], key }))
      .toBeNull()
  })

  it('keeps an entry that arrived while the form was open', () => {
    // The form added nothing and removed nothing; it must not erase `beta`.
    expect(mergeReplacedList({
      filled: [{ id: 'alpha' }],
      draft: [{ id: 'alpha' }, { id: 'gamma' }],
      live: [{ id: 'alpha' }, { id: 'beta' }],
      key,
    })).toEqual([{ id: 'alpha' }, { id: 'gamma' }, { id: 'beta' }])
  })

  it('honours a removal the form made, and still keeps a concurrent addition', () => {
    expect(mergeReplacedList({
      filled: [{ id: 'alpha' }, { id: 'beta' }],
      draft: [{ id: 'beta' }],
      live: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
      key,
    })).toEqual([{ id: 'beta' }, { id: 'gamma' }])
  })

  it('does not resurrect an entry the form removed and another client also removed', () => {
    expect(mergeReplacedList({
      filled: [{ id: 'alpha' }, { id: 'beta' }],
      draft: [{ id: 'alpha' }],
      live: [{ id: 'alpha' }],
      key,
    })).toEqual([{ id: 'alpha' }])
  })

  it('never sends a list the form was not filled with', () => {
    // A block that was never filled holds `[]`; sending that replaces the list with nothing.
    expect(mergeReplacedList({ filled: undefined, draft: [], live: [{ id: 'alpha' }], key })).toBeNull()
  })
})

/**
 * The half a three-way merge cannot fix: two clients editing the *same* entry.
 *
 * The merge keeps a concurrent addition and honours a removal, but when both sides changed one
 * entry from the same baseline, one value must lose — and it lost silently. Measured with two
 * browser tabs on one workspace settings page: each tab edited the same destination, the later save
 * won, and the earlier edit was gone with nothing said.
 *
 * The predicate names the clash so the save can refuse. Every case below is a *different answer* to
 * "is this a conflict", which is what makes the three-way test worth having rather than a plain
 * "does the draft differ from live".
 */
describe('replacedListConflicts — a same-entry clash is named, not silently resolved', () => {
  const key = (entry: { id: string, label?: string }): string => entry.id

  it('names an entry both sides changed from the same baseline', () => {
    expect(replacedListConflicts({
      filled: [{ id: 'alpha', label: 'A' }],
      draft: [{ id: 'alpha', label: 'mine' }],
      live: [{ id: 'alpha', label: 'theirs' }],
      key,
    })).toEqual(['alpha'])
  })

  it('says nothing when only this form changed the entry', () => {
    // The ordinary edit: the panel still holds the baseline.
    expect(replacedListConflicts({
      filled: [{ id: 'alpha', label: 'A' }],
      draft: [{ id: 'alpha', label: 'mine' }],
      live: [{ id: 'alpha', label: 'A' }],
      key,
    })).toEqual([])
  })

  it('says nothing when only another client changed it', () => {
    // Their save landed before this form was touched, so the form is simply stale — merging the
    // form's unchanged entry is the right answer, not a refusal.
    expect(replacedListConflicts({
      filled: [{ id: 'alpha', label: 'A' }],
      draft: [{ id: 'alpha', label: 'A' }],
      live: [{ id: 'alpha', label: 'theirs' }],
      key,
    })).toEqual([])
  })

  it('does not call a concurrent removal or addition a conflict', () => {
    // Removed here: this form's intent, and the merge keeps it removed.
    expect(replacedListConflicts({
      filled: [{ id: 'alpha' }, { id: 'beta' }],
      draft: [{ id: 'beta' }],
      live: [{ id: 'alpha' }, { id: 'beta' }],
      key,
    })).toEqual([])
    // Removed elsewhere: nothing left to clash with.
    expect(replacedListConflicts({
      filled: [{ id: 'alpha' }, { id: 'beta' }],
      draft: [{ id: 'alpha', label: 'mine' }, { id: 'beta' }],
      live: [{ id: 'beta' }],
      key,
    })).toEqual([])
    // Added elsewhere while this form edited the list: the merge keeps both.
    expect(replacedListConflicts({
      filled: [{ id: 'alpha' }],
      draft: [{ id: 'alpha', label: 'mine' }],
      live: [{ id: 'alpha' }, { id: 'gamma' }],
      key,
    })).toEqual([])
  })

  it('reports every clashing entry, not just the first', () => {
    expect(replacedListConflicts({
      filled: [{ id: 'alpha', label: 'A' }, { id: 'beta', label: 'B' }],
      draft: [{ id: 'alpha', label: 'm1' }, { id: 'beta', label: 'm2' }],
      live: [{ id: 'alpha', label: 't1' }, { id: 'beta', label: 't2' }],
      key,
    })).toEqual(['alpha', 'beta'])
  })

  it('never reports a conflict for a list the form was never filled with', () => {
    expect(replacedListConflicts({ filled: undefined, draft: [], live: [{ id: 'alpha' }], key })).toEqual([])
  })

  it('treats an unset field as equal to one the panel omits', () => {
    // `same()` normalizes away null/undefined members, so a form that carries `label: undefined`
    // and a config that omits `label` are the same value — not a change on either side.
    expect(replacedListConflicts({
      filled: [{ id: 'alpha' }],
      draft: [{ id: 'alpha', label: undefined }],
      live: [{ id: 'alpha' }],
      key,
    })).toEqual([])
  })
})

/**
 * `routeConflicts` is the same rule over the proxy's route table.
 *
 * The proxy page replaces its routes the same way the destinations list is replaced, so it has the
 * same unreconcilable case. This pins that it is the *shared* predicate and not a second rule that
 * will drift: the cases mirror `replacedListConflicts` through the route shape.
 */
describe('routeConflicts', () => {
  /** The route shape the proxy form edits; `key` is what the draft adds on top. */
  const route = (id: string, host: string) => ({
    id,
    host,
    enabled: true,
    target: 'server' as const,
    workspace: 'default',
    server: 'web',
    url: '',
    path: '',
    tls: 'auto' as const,
    dnsAccount: '',
  })
  const draft = (id: string, host: string) => ({ ...route(id, host), key: id })

  it('names a route both sides moved, through the wire form', async () => {
    const { routeConflicts } = await import('#src/shared/proxy-form')
    expect(routeConflicts([route('site', 'theirs.example.com')], [draft('site', 'mine.example.com')], [route('site', 'a.example.com')]))
      .toEqual(['site'])
  })

  it('says nothing for a route only this form changed', async () => {
    const { routeConflicts } = await import('#src/shared/proxy-form')
    const base = [route('site', 'a.example.com')]
    expect(routeConflicts(base, [draft('site', 'mine.example.com')], base)).toEqual([])
  })

  it('says nothing when the form was never filled, because nothing is comparable', async () => {
    const { routeConflicts } = await import('#src/shared/proxy-form')
    expect(routeConflicts([route('site', 'a.example.com')], [], undefined)).toEqual([])
  })
})
