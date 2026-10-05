import { ddnsConfigSchema, settingsPatchSchema, workspaceSettingsPatchSchema } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { detachConfig, isLiveConfigChange, repairNumbers } from '../src/lib/forms'

/**
 * `v-model.number` writes an empty **string** when an `<input type="number">` is cleared —
 * not a number and not `null`. The patch schema validates the *whole* body before it is sent,
 * so clearing one box refused an entire save with a raw "must be a number (was a string)" and
 * no field hint. There are 31 such inputs across this UI's views.
 *
 * The repair is central on purpose: the alternative is 31 bindings each needing its own
 * guard, and a newly added field would silently re-open the bug.
 */
const EMPTY = '' as never

describe('repairNumbers', () => {
  it('puts the live value back for an emptied box', () => {
    const form = { port: EMPTY, intervalMs: '15000', diskUsedPercent: 90 }
    repairNumbers(form, { port: 3999, intervalMs: 15000, diskUsedPercent: 90 })

    expect(form.port).toBe(3999)
    // A field the person did type is left exactly as typed.
    expect(form.intervalMs).toBe('15000')
    expect(form.diskUsedPercent).toBe(90)
  })

  it('treats null, undefined and NaN as emptied too', () => {
    const form = { a: null as never, b: undefined as never, c: Number.NaN }
    repairNumbers(form, { a: 1, b: 2, c: 3 })
    expect([form.a, form.b, form.c]).toEqual([1, 2, 3])
  })

  it('leaves non-numeric fields alone', () => {
    const form = { label: '', host: '', enabled: false, host_: '0.0.0.0', openBrowser: true }
    repairNumbers(form, { label: 'home-hosted', host: 'local', enabled: true, host_: '127.0.0.1', openBrowser: false })

    // An emptied *text* field is the person clearing a name, not a box to repair.
    expect(form.label).toBe('')
    expect(form.host).toBe('')
    expect(form.openBrowser).toBe(true)
  })

  it('recurses into the nested groups and their sub-objects', () => {
    const form = {
      restart: { maxRetries: EMPTY, factor: EMPTY },
      health: { intervalMs: EMPTY, http: { expectStatusBelow: EMPTY } },
    }
    repairNumbers(form, {
      restart: { maxRetries: 3, factor: 2 },
      health: { intervalMs: 15000, http: { expectStatusBelow: 400 } },
    })

    expect(form.restart).toEqual({ maxRetries: 3, factor: 2 })
    expect(form.health.intervalMs).toBe(15000)
    // The sub-object one level deeper is the one that shipped broken.
    expect(form.health.http.expectStatusBelow).toBe(400)
  })

  it('leaves a value with no live counterpart alone', () => {
    // A field the running config does not carry has nothing to fall back to.
    const form = { newField: EMPTY }
    repairNumbers(form, {})
    expect(form.newField).toBe('')
  })

  it('does not clobber a boolean or a list against a number', () => {
    const form = { enabled: true, paths: ['.'] }
    repairNumbers(form, { enabled: 1, paths: 0 })
    expect(form.enabled).toBe(true)
    expect(form.paths).toEqual(['.'])
  })

  it('repairs a list of objects element-wise', () => {
    const form = { domains: [{ ttl: EMPTY, host: 'a.example.com' }] }
    repairNumbers(form, { domains: [{ ttl: 3600, host: 'a.example.com' }] })
    expect(form.domains[0]!.ttl).toBe(3600)
    expect(form.domains[0]!.host).toBe('a.example.com')
  })

  it('produces bodies both settings schemas accept', () => {
    // The point of the whole exercise: the client validates these before sending.
    const control = { port: EMPTY, label: 'mine' }
    repairNumbers(control, { port: 3999, label: 'home-hosted' })
    const global = settingsPatchSchema({ control })
    expect(Array.isArray(global), `rejected: ${JSON.stringify(control)}`).toBe(false)

    const logs = { maxBytes: EMPTY, keep: EMPTY }
    repairNumbers(logs, { maxBytes: 10_000_000, keep: 5 })
    const workspace = workspaceSettingsPatchSchema({ logs })
    expect(Array.isArray(workspace), `rejected: ${JSON.stringify(logs)}`).toBe(false)
  })
})

/**
 * The DDNS panel publishes its own patch, and `saveDdns` has no client-side schema to catch a
 * bad value first — the server's `ddnsConfigSchema` is what rejects it. `intervalMs` and `ttl`
 * are required numbers there, so an emptied box (`''` from `v-model.number`) refused the save.
 */
describe('the DDNS draft', () => {
  it('repairs the two required numbers against the live config', () => {
    const draft = {
      enabled: true,
      intervalMs: EMPTY,
      ttl: EMPTY,
      ipv4: { enabled: true, url: '' },
      ipv6: { enabled: false, url: '' },
      accounts: [],
      domains: [],
    }
    const live = { ...draft, intervalMs: 300000, ttl: 1 }
    repairNumbers(draft as unknown as Record<string, unknown>, live as unknown as Record<string, unknown>)

    expect(draft.intervalMs).toBe(300000)
    expect(draft.ttl).toBe(1)
  })

  it('produces a body the server schema accepts', () => {
    const body = { enabled: true, intervalMs: 300000, ttl: 1, ipv4: { enabled: true, url: '' }, ipv6: { enabled: false, url: '' }, accounts: [], domains: [] }
    expect(Array.isArray(ddnsConfigSchema(body)), 'the repaired body was rejected').toBe(false)
  })
})

/**
 * The live-config guard, which `ServerConfigView` uses to decide whether a state frame may
 * replace what the user has typed.
 *
 * `uis/stock`'s editor pins both of its behaviours, but that component takes its config as a
 * prop while this view reads a composable — so noc's guard had no test at all. The logic is
 * extracted here to make it testable without mounting the whole view.
 */
describe('isLiveConfigChange', () => {
  const live = { label: 'web', port: 3000, restart: { maxRetries: 3 } }

  it('treats a re-sent but equal config as no change, so typed edits survive', () => {
    // The control plane re-creates every object each frame: equal by value is not a change.
    expect(isLiveConfigChange({ ...live, restart: { maxRetries: 3 } }, detachConfig(live))).toBe(false)
  })

  it('treats a real server-side change as one', () => {
    expect(isLiveConfigChange({ ...live, label: 'renamed-elsewhere' }, detachConfig(live))).toBe(true)
  })

  it('ignores a null or absent config rather than reloading on it', () => {
    // A frame before the server is known must not clear the form.
    expect(isLiveConfigChange(null, detachConfig(live))).toBe(false)
    expect(isLiveConfigChange(undefined, detachConfig(live))).toBe(false)
  })

  it('compares by value, so mutating the snapshot shape is still detected', () => {
    const snapshot = detachConfig(live)
    expect(isLiveConfigChange({ ...live, port: null }, snapshot)).toBe(true)
  })
})

describe('detachConfig', () => {
  /**
   * The guard's snapshot must not alias live state. If it did, a store that mutated a config in
   * place would move the snapshot with it and `isLiveConfigChange` would answer `false` for a
   * real change — the form would silently stop following the server. `uis/stock` detaches for
   * the same reason, and AGENTS.md records the aliasing trap.
   */
  it('returns a copy that does not move with the original', () => {
    const original = { label: 'web', restart: { maxRetries: 3 } }
    const snapshot = detachConfig(original)
    original.restart.maxRetries = 9
    expect(snapshot.restart.maxRetries).toBe(3)
    expect(isLiveConfigChange(original, snapshot)).toBe(true)
  })
})
