import { describe, expect, it } from 'vitest'
import { applyPatch, mergeGroup } from '#src/config/patch'

/**
 * An explicit `null` **removes** a key, at the top level as well as inside a group.
 *
 * The repo rule is stated that way, and `mergeGroup` always did it — but `applyPatch` *set* `null` for a
 * top-level key, so the two paths disagreed. It was reachable all along: `label` is not in
 * `SERVER_MERGE_KEYS`, so `updateServer(id, { label: null })` took the plain-set branch, stored `null`, and
 * the schema that reads the file then refused the whole config:
 * `servers[0]: label must be a string (was null)`.
 *
 * Clearing a label is what makes this matter: every display falls back with `label ?? id`, which fires on
 * `null`/`undefined` and not on `''`, so an absent key is the only spelling that shows the id again.
 */
describe('clearing a key with null', () => {
  it('removes it at the top level, as it already did inside a group', () => {
    const target: Record<string, unknown> = { label: 'Demo', command: 'node', health: { enabled: true, intervalMs: 5000 } }

    applyPatch(target, { label: null }, new Set(['health']))
    expect('label' in target, 'a cleared top-level key must be gone, not null').toBe(false)
    // The value a display would show, which is the point of removing rather than blanking.
    expect(target.label ?? 'web').toBe('web')

    // The group path already behaved this way, and still does.
    applyPatch(target, { health: { intervalMs: null } }, new Set(['health']))
    expect(target.health).toEqual({ enabled: true })
    expect(mergeGroup({ a: 1 }, { a: null })).toEqual({})
  })

  it('still ignores an undefined value, and still sets a real one', () => {
    const target: Record<string, unknown> = { label: 'Demo' }
    applyPatch(target, { label: undefined }, new Set())
    expect(target.label).toBe('Demo')
    applyPatch(target, { label: 'Renamed' }, new Set())
    expect(target.label).toBe('Renamed')
  })
})
