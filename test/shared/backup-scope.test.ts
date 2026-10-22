import { describe, expect, it } from 'vitest'
import {
  capturedIds,
  excludedIds,
  sameScope,
  scopeOf,
  scopeSelection,
  selectionOf,
  unknownBackupIds,
} from '#src/shared/backup-scope'

/** One entry of the capture tree, wholly ticked unless a test says otherwise. */
function entry(id: string, leaves: Array<[string, boolean]> = [], selected = true) {
  return { id, selected, leaves: leaves.map(([leafId, ticked]) => ({ id: leafId, selected: ticked })) }
}

const TREE = [
  entry('global:settings'),
  entry('global:tls'),
  entry('workspace:default', [
    ['workspace:default:settings', true],
    ['workspace:default:servers', true],
  ]),
]

describe('the configured scope', () => {
  it('is the CLI\'s own two flags, so a schedule and a typed command mean the same thing', () => {
    expect(scopeSelection(undefined)).toEqual({})
    expect(scopeSelection({ mode: 'only', ids: ['global:settings'] })).toEqual({ include: ['global:settings'] })
    expect(scopeSelection({ mode: 'except', ids: ['global:secrets'] })).toEqual({ exclude: ['global:secrets'] })
  })
})

describe('the selection a scope and a flag share', () => {
  it('covers the leaves under a coarse id, and never the parent of a named leaf', () => {
    const only = selectionOf({ include: ['workspace:default'] })
    expect(only('workspace:default:servers')).toBe(true)
    expect(only('global:settings')).toBe(false)

    const leaf = selectionOf({ include: ['workspace:default:servers'] })
    expect(leaf('workspace:default'), 'a named leaf must not select its whole entry').toBe(false)
  })

  it('applies an exclusion after the inclusion, and to the leaves underneath', () => {
    const selects = selectionOf({ exclude: ['global:secrets'] })
    expect(selects('global:secrets:password')).toBe(false)
    expect(selects.isExcluded('global:secrets:password')).toBe(true)
    expect(selects('global:settings')).toBe(true)
  })
})

describe('the ids a ticked tree stands for', () => {
  it('names a wholly ticked entry whole, and a partial one by leaf', () => {
    expect(capturedIds(TREE)).toEqual(['global:settings', 'global:tls', 'workspace:default'])
    expect(capturedIds([entry('workspace:default', [['workspace:default:settings', true], ['workspace:default:servers', false]])]))
      .toEqual(['workspace:default:settings'])
  })

  it('spells the complement the same way, for a scope written as an exclusion', () => {
    expect(excludedIds(TREE)).toEqual([])
    expect(excludedIds([entry('workspace:default', [['workspace:default:settings', true], ['workspace:default:servers', false]])]))
      .toEqual(['workspace:default:servers'])
    // An entry no leaf of which is ticked is named whole: its id already covers them all.
    expect(excludedIds([entry('global:tls', [], false), entry('global:settings')])).toEqual(['global:tls'])
  })
})

describe('what a ticked tree is stored as', () => {
  it('stores "everything ticked" as no scope at all, whatever the mode', () => {
    // The two capture the same thing today, and only the empty setting also covers a workspace
    // declared tomorrow — storing the id list would silently narrow every future pass.
    expect(scopeOf(TREE, 'only')).toEqual({ kind: 'everything' })
    expect(scopeOf(TREE, 'except')).toEqual({ kind: 'everything' })
  })

  it('refuses an empty tick rather than reading it as "everything"', () => {
    // An empty `include` means "all of it" to the API, which is the opposite of what was picked.
    expect(scopeOf([entry('global:settings', [], false)], 'only')).toEqual({ kind: 'nothing' })
    expect(scopeOf([entry('global:settings', [], false)], 'except')).toEqual({ kind: 'nothing' })
    expect(scopeOf([], 'only')).toEqual({ kind: 'nothing' })
  })

  it('writes the picked ids in the mode the person chose', () => {
    const partial = [entry('global:settings'), entry('global:tls', [], false), entry('workspace:default')]
    expect(scopeOf(partial, 'only')).toEqual({ kind: 'scope', scope: { mode: 'only', ids: ['global:settings', 'workspace:default'] } })
    expect(scopeOf(partial, 'except')).toEqual({ kind: 'scope', scope: { mode: 'except', ids: ['global:tls'] } })
  })
})

describe('unknownBackupIds', () => {
  const entries = [
    // A leaf-less entry (global:tls) carries no `items` at all: a whole-file slice has no sub-items.
    { id: 'global:tls' },
    { id: 'global:settings', items: [] },
    { id: 'workspace:default', items: [{ id: 'workspace:default:servers' }, { id: 'workspace:default:data:/srv/a' }] },
  ]

  it('accepts an entry, a leaf, and a prefix that covers leaves', () => {
    expect(unknownBackupIds(['global:tls', 'global:settings', 'workspace:default:servers', 'workspace:default:data:/srv/a'], entries)).toEqual([])
    // A coarse id is enough when every leaf under it is named: the CLI accepts the same shorthand.
    expect(unknownBackupIds(['workspace:default:data'], entries)).toEqual([])
  })

  it('names a typo, which is the failure a scheduled pass would otherwise swallow', () => {
    expect(unknownBackupIds(['global:secret'], entries)).toEqual(['global:secret'])
    expect(unknownBackupIds(['workspace:ghost'], entries)).toEqual(['workspace:ghost'])
  })
})

describe('sameScope', () => {
  it('ignores the order the panel wrote the ids in, and compares modes', () => {
    expect(sameScope({ mode: 'only', ids: ['a', 'b'] }, { mode: 'only', ids: ['b', 'a'] })).toBe(true)
    expect(sameScope({ mode: 'only', ids: ['a'] }, { mode: 'except', ids: ['a'] })).toBe(false)
    expect(sameScope(null, undefined), 'both mean the default scope').toBe(true)
    expect(sameScope(null, { mode: 'only', ids: ['a'] })).toBe(false)
  })
})
