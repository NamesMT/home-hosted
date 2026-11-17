import type { BackupEntry } from '@shared/contracts'
import { scopeOf } from '@shared/backup-scope'
import { describe, expect, it } from 'vitest'
import {
  allLeavesSelected,
  captureEntries,
  capturesEverything,
  effectiveSelected,
  includeIds,
  selectAll,
  selectionCount,
} from '../src/components/settings/backupSelection'
import { createBackup } from '../src/lib/api'

/** One leaf as `BackupEntry.items` carries it. */
type BackupEntryItem = BackupEntry['items'][number]

/** One workspace leaf, as the panel's `BackupEntry.items` carries it. */
function leaf(overrides: Partial<BackupEntryItem> = {}): BackupEntryItem {
  return { id: 'workspace:default:settings', label: 'Settings', kind: 'settings', included: true, note: null, ...overrides }
}

/** A data path leaf, whose hint is built from `origin` and `path`. */
function dataLeaf(overrides: Partial<BackupEntryItem> = {}): BackupEntryItem {
  return {
    id: 'data:/srv/app/data',
    label: '/srv/app/data',
    kind: 'data',
    path: '/srv/app/data',
    origin: 'app:DATA_DIR',
    included: true,
    note: null,
    ...overrides,
  }
}

/** One secret leaf of a global or workspace secrets entry. */
function secretLeaf(secret: string, overrides: Partial<BackupEntryItem> = {}): BackupEntryItem {
  return {
    id: `global:secrets:${secret}`,
    label: secret,
    kind: 'secrets',
    secret,
    included: true,
    note: null,
    ...overrides,
  }
}

function globalEntry(kind: BackupEntry['kind'], overrides: Partial<BackupEntry> = {}): BackupEntry {
  return { id: `global:${kind}`, label: kind, kind, note: null, items: [], ...overrides }
}

function workspaceEntry(items: BackupEntryItem[], overrides: Partial<BackupEntry> = {}): BackupEntry {
  return { id: 'workspace:default', label: 'Default', kind: 'workspace', workspaceId: 'default', note: null, items, ...overrides }
}

describe('backup selection', () => {
  it('offers the panel state, then each workspace with its leaves', () => {
    const entries = captureEntries([
      globalEntry('settings'),
      globalEntry('secrets'),
      globalEntry('tls'),
      workspaceEntry([leaf(), dataLeaf()]),
    ])

    expect(entries.map(entry => entry.id)).toEqual([
      'global:settings',
      'global:secrets',
      'global:tls',
      'workspace:default',
    ])
    // Every entry starts selected, leaves included.
    expect(entries.every(entry => entry.selected)).toBe(true)

    const workspace = entries.at(-1)!
    expect(workspace.leaves.map(choice => choice.id)).toEqual(['workspace:default:settings', 'data:/srv/app/data'])
    expect(workspace.leaves.at(-1)).toMatchObject({ label: '/srv/app/data', hint: '/srv/app/data — from app:DATA_DIR' })
  })

  it('keeps what was already picked when a late frame re-sends the entries', () => {
    const first = captureEntries([globalEntry('settings'), workspaceEntry([leaf(), dataLeaf()])])
    first[0]!.selected = false
    first[1]!.leaves[1]!.selected = false

    const again = captureEntries(
      [globalEntry('settings', { label: 'Panel settings' }), workspaceEntry([leaf(), dataLeaf()])],
      first,
    )

    // The frame refreshed the label, but the two ticks survived.
    expect(again[0]).toMatchObject({ id: 'global:settings', label: 'Panel settings', selected: false })
    expect(again[1]!.leaves.find(choice => choice.id === 'data:/srv/app/data')?.selected).toBe(false)
  })

  it('omits the selection when everything is checked, so the request stays unqualified', () => {
    const entries = captureEntries([globalEntry('settings'), globalEntry('secrets'), globalEntry('tls'), workspaceEntry([leaf()])])
    expect(includeIds(entries)).toBeUndefined()

    entries[0]!.selected = false
    expect(includeIds(entries)).toEqual(['global:secrets', 'global:tls', 'workspace:default'])
  })

  it('sends a workspace whole when every leaf is picked, and only the picked leaves otherwise', () => {
    const entries = captureEntries([globalEntry('settings'), workspaceEntry([leaf(), dataLeaf()])])

    expect(includeIds(entries)).toBeUndefined()

    entries[1]!.leaves[0]!.selected = false
    expect(allLeavesSelected(entries[1]!)).toBe(false)
    expect(includeIds(entries)).toEqual(['global:settings', 'data:/srv/app/data'])
  })

  it('does not capture a workspace whose every leaf was unticked', () => {
    const entries = captureEntries([workspaceEntry([leaf(), dataLeaf()])])
    entries[0]!.leaves.forEach((choice) => { choice.selected = false })

    expect(effectiveSelected(entries[0]!)).toBe(false)
    expect(includeIds(entries)).toEqual([])
    expect(selectionCount(entries)).toEqual({ entries: 0, leaves: 0 })
  })

  it('sends a non-workspace entry whole when every one of its leaves is picked', () => {
    const secrets = [secretLeaf('password'), secretLeaf('apiToken')]
    const entries = captureEntries([globalEntry('settings'), globalEntry('secrets', { items: secrets })])

    // Everything is picked, so the request stays unqualified even though `global:secrets` now has leaves.
    expect(allLeavesSelected(entries[1]!)).toBe(true)
    expect(includeIds(entries)).toBeUndefined()
    expect(capturesEverything(entries)).toBe(true)

    // With a sibling unticked, the fully picked secrets entry travels as its aggregate id.
    entries[0]!.selected = false
    expect(includeIds(entries)).toEqual(['global:secrets'])
  })

  it('sends only the picked secret leaves of a non-workspace entry', () => {
    const items = [secretLeaf('password'), secretLeaf('apiToken'), secretLeaf('futureKey')]
    const entries = captureEntries([globalEntry('settings'), globalEntry('secrets', { items })])

    entries[1]!.leaves.find(choice => choice.id === 'global:secrets:apiToken')!.selected = false
    expect(allLeavesSelected(entries[1]!)).toBe(false)
    expect(includeIds(entries)).toEqual(['global:settings', 'global:secrets:password', 'global:secrets:futureKey'])
    expect(selectionCount(entries)).toEqual({ entries: 2, leaves: 3 })
  })

  it('does not capture a non-workspace entry whose every secret leaf was unticked', () => {
    const entries = captureEntries([globalEntry('secrets', { items: [secretLeaf('password'), secretLeaf('apiToken')] })])
    entries[0]!.leaves.forEach((choice) => { choice.selected = false })

    expect(effectiveSelected(entries[0]!)).toBe(false)
    expect(includeIds(entries)).toEqual([])
    expect(selectionCount(entries)).toEqual({ entries: 0, leaves: 0 })
  })

  it('leaves an entry with no leaves untouched by the leaf logic', () => {
    const entries = captureEntries([globalEntry('settings'), globalEntry('tls')])

    // No leaves to consult: the entry's own tick still decides, and a count of one leaf each.
    expect(allLeavesSelected(entries[0]!)).toBe(false)
    expect(effectiveSelected(entries[0]!)).toBe(true)
    expect(includeIds(entries)).toBeUndefined()

    entries[1]!.selected = false
    expect(includeIds(entries)).toEqual(['global:settings'])
    expect(selectionCount(entries)).toEqual({ entries: 1, leaves: 1 })

    entries[0]!.selected = false
    expect(includeIds(entries)).toEqual([])
  })

  it('sends only the picked leaves of a workspace whose secrets leaves are partly picked', () => {
    const secrets = [
      secretLeaf('telegram', { id: 'workspace:default:secrets:telegram' }),
      secretLeaf('ddns', { id: 'workspace:default:secrets:ddns' }),
    ]
    const entries = captureEntries([workspaceEntry([leaf(), ...secrets])])

    entries[0]!.leaves.find(choice => choice.id === 'workspace:default:secrets:ddns')!.selected = false
    expect(allLeavesSelected(entries[0]!)).toBe(false)
    expect(includeIds(entries)).toEqual(['workspace:default:settings', 'workspace:default:secrets:telegram'])
    expect(selectionCount(entries)).toEqual({ entries: 1, leaves: 2 })
  })

  it('sends an empty list only when nothing at all is checked', () => {
    const picked = captureEntries([globalEntry('settings')])
    selectAll(picked, false)
    expect(includeIds(picked)).toEqual([])
  })

  it('keeps an empty selection distinct from "capture everything"', () => {
    // `undefined` means "everything", `[]` means "nothing" — never the same thing.
    const nothing = captureEntries([])
    expect(includeIds(nothing)).toEqual([])
    expect(capturesEverything(nothing)).toBe(false)

    const everything = captureEntries([globalEntry('settings'), globalEntry('secrets'), globalEntry('tls')])
    expect(includeIds(everything)).toBeUndefined()
    expect(capturesEverything(everything)).toBe(true)
  })

  it('refuses to send an empty selection instead of widening it to everything', () => {
    // The dialog's own guard blocks this today, but no caller may turn "capture
    // nothing" into "capture everything" by omitting the key.
    expect(() => createBackup({ include: [] })).toThrow('nothing is selected')
  })

  it('counts the entries and the leaves the request would capture', () => {
    const entries = captureEntries([globalEntry('settings'), globalEntry('secrets'), workspaceEntry([leaf(), dataLeaf()])])

    // Two global entries (one leaf each) plus a whole workspace (its two leaves).
    expect(selectionCount(entries)).toEqual({ entries: 3, leaves: 4 })

    entries[2]!.leaves[1]!.selected = false
    expect(selectionCount(entries)).toEqual({ entries: 3, leaves: 3 })
  })
})

/**
 * A job is its own leaf, and the scope ids have to be able to name it.
 *
 * The backup captured no `jobs.config.json` at all, so a restored host ran none of its scheduled
 * work while its secrets file still held every job's credential. The panel now offers the leaf; these
 * cases pin that ticking it (or only it) produces the ids the API's selection actually honours.
 */
describe('the jobs leaf', () => {
  /** The workspace's jobs file, as the panel's tree carries it. */
  function jobsLeaf(overrides: Partial<BackupEntryItem> = {}): BackupEntryItem {
    return { id: 'workspace:default:jobs', label: 'Jobs', kind: 'jobs', included: true, note: null, ...overrides }
  }

  it('travels as its own id when its siblings are unticked', () => {
    const entries = captureEntries([workspaceEntry([leaf(), jobsLeaf()])])
    entries[0]!.leaves.find(choice => choice.id === 'workspace:default:settings')!.selected = false

    expect(includeIds(entries)).toEqual(['workspace:default:jobs'])
    expect(selectionCount(entries)).toEqual({ entries: 1, leaves: 1 })
  })

  it('is named by the complement when it is the one thing left out', () => {
    const entries = captureEntries([workspaceEntry([leaf(), jobsLeaf(), dataLeaf()])])
    expect(capturesEverything(entries)).toBe(true)

    entries[0]!.leaves.find(choice => choice.id === 'workspace:default:jobs')!.selected = false
    // The stored scope is written as the complement: "everything except this one leaf" — which is
    // the spelling the docs recommend, and the one `--exclude workspace:<id>:jobs` round-trips.
    expect(scopeOf(entries, 'except')).toEqual({ kind: 'scope', scope: { mode: 'except', ids: ['workspace:default:jobs'] } })
  })
})
