import { describe, expect, it } from 'vitest'
import {
  capturedIds,
  excludedIds,
  GLOBAL_RESTORE_ITEMS,
  sameScope,
  scopeOf,
  scopeSelection,
  selectedBy,
  selectionOf,
  selectionTouches,
  selectionWritesCredentials,
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

/**
 * The credential guard and the restore's own item selection must answer "did you pick this item"
 * identically, and they did not.
 *
 * The restore's `addItem` selected an item through its id **or any of its aliases**, while
 * `selectionWritesCredentials` tested only the exact ids `global:secrets` / `global:secrets:<field>`.
 * The credential item's alias is `secrets`, so `include: ["secrets"]` selected `.control-secrets.json`
 * for writing and skipped the session bar: a token-only restore could replace the panel's password and
 * API-token hashes — the exact takeover the guard exists to refuse.
 *
 * Pinned as a property, not as two literals: for the same selection, the alias spelling and the id
 * spelling must produce the same verdict, whichever way the answer goes.
 */
describe('the credential guard and the restore selection agree', () => {
  const credentials = GLOBAL_RESTORE_ITEMS.credentials
  const verdict = (include: string[]): boolean => selectionWritesCredentials({ include })

  it('treats the alias exactly as the id — the measured bypass', () => {
    expect(verdict(['global:secrets'])).toBe(true)
    // This was `false` while the restore still selected the same item: the bypass.
    expect(verdict(['secrets']), 'the alias selects the file, so the guard has to see it too').toBe(true)
  })

  it('agrees on the leaves, and on the field a person actually asked for', () => {
    for (const field of ['password', 'apiToken']) {
      expect(verdict([`global:secrets:${field}`]), field).toBe(true)
      // The alias spelling of a leaf names the same field, and the restore writes it: the leaf items
      // carry `${alias}:${key}` for exactly this reason. A guard that answered false here while the
      // restore wrote the password hash was the bypass, not a strictness worth keeping.
      expect(verdict([`secrets:${field}`]), `${field} under the alias`).toBe(true)
    }
  })

  it('agrees on the exclusions, which are what the docs recommend', () => {
    // No `include` at all is "everything", credentials included.
    expect(selectionWritesCredentials({})).toBe(true)
    // `--all --exclude global:secrets` is the documented way for a token to restore everything else.
    expect(selectionWritesCredentials({ exclude: ['global:secrets'] })).toBe(false)
    expect(selectionWritesCredentials({ exclude: ['secrets'] }), 'the alias excludes it too').toBe(false)
    // An exclusion still beats the other spelling selecting it back in.
    expect(selectionWritesCredentials({ include: ['secrets'], exclude: ['global:secrets'] })).toBe(false)
    expect(selectionWritesCredentials({ include: ['global:secrets'], exclude: ['secrets'] })).toBe(false)
  })

  it('names only the credential file, never its neighbours', () => {
    // A guard that fired on the whole panel would make the alias fix meaningless by refusing
    // every restore a token is allowed to make.
    for (const include of [['global:settings'], ['config'], ['global:tls'], ['tls'], ['workspace:default']])
      expect(verdict(include), include.join()).toBe(false)
    expect(selectionWritesCredentials({ exclude: ['global:settings'] })).toBe(true)
  })

  /**
   * The exclusion the docs recommend must actually leave the credentials behind.
   *
   * Measured against the real `addItem` rule, `{"exclude":["secrets"]}` used to select the *leaf*
   * items (`global:secrets:password`, `…:apiToken`) while the guard answered "the store is not
   * touched" — the alias excluded the parent entry and nothing reached the leaves, so a token-only
   * restore re-implemented the very lockout this guard exists to prevent. Every credential the
   * restore can write must be covered by the same verdict, or the guard is decorative.
   */
  it('treats an alias exclusion as covering the leaves it selects', () => {
    for (const exclude of [['secrets'], ['global:secrets']]) {
      // Both spellings name the same file, so no field of it may be written. The leaf items carry
      // their own alias spelling (`secrets:password`) for exactly this: without it the parent was
      // excluded while `addItem` still selected the leaf, and the password hash was rewritten.
      const selects = selectionOf({ exclude })
      for (const field of ['password', 'apiToken']) {
        const leaf = {
          id: `${GLOBAL_RESTORE_ITEMS.credentials.id}:${field}`,
          aliases: GLOBAL_RESTORE_ITEMS.credentials.aliases.map(alias => `${alias}:${field}`),
        }
        expect(selectedBy(selects, leaf), `${exclude[0]} excludes ${field}`).toBe(false)
      }
      expect(selectionWritesCredentials({ exclude }), exclude.join()).toBe(false)
    }
    // And an explicit include of one field is still exactly that one field, not the whole file.
    expect(selectionWritesCredentials({ include: ['global:secrets:password'] })).toBe(true)
    expect(selectionWritesCredentials({ include: ['global:secrets:password'], exclude: ['global:secrets:password'] })).toBe(false)
  })

  /**
   * The class, stated once: the guard is `selectionTouches` against the declared item, and `addItem`
   * is `selectedBy` against the same declaration. A change to either — a new alias, a new item — has
   * to move both, because there is only one place that knows.
   */
  it('shares one declaration of the item, aliases included', () => {
    const selectsSecretsById = selectedBy(selectionOf({ include: ['secrets'] }), credentials)
    expect(selectsSecretsById, 'the restore selects it').toBe(true)
    expect(selectionTouches({ include: ['secrets'] }, credentials), 'and the guard agrees').toBe(true)
    // Every alias the item declares is honoured by both, whatever it is called.
    for (const alias of credentials.aliases) {
      expect(selectedBy(selectionOf({ include: [alias] }), credentials), alias).toBe(true)
      expect(selectionTouches({ include: [alias] }, credentials), alias).toBe(true)
    }
  })
})
