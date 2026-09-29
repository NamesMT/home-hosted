import type { BackupEntry } from '@shared/contracts'

/**
 * The two-level capture model the backup dialog edits.
 *
 * The top level is one selectable entry per archive root: the global settings,
 * secrets and TLS pair, plus one entry per workspace. A workspace's own entry
 * carries several leaves (its settings, servers, secrets and each declared data
 * path), which a nested dialog picks from — a workspace can be captured whole or
 * only in part.
 */

export interface LeafChoice {
  id: string
  label: string
  hint: string
  kind: 'settings' | 'servers' | 'secrets' | 'data'
  selected: boolean
}

export interface EntryChoice {
  id: string
  label: string
  hint: string
  kind: BackupEntry['kind']
  workspaceId?: string
  selected: boolean
  /** Empty for a global entry; the sub-choices for a workspace. */
  leaves: LeafChoice[]
}

/** A readable hint for why a leaf would be captured. */
function leafHint(item: BackupEntry['items'][number]): string {
  if (item.kind === 'settings')
    return 'Server defaults, log retention and notifications'
  if (item.kind === 'servers')
    return 'Every entry in servers.config.json'
  if (item.kind === 'secrets')
    return 'Telegram bot token and DDNS credentials'
  if (item.path === undefined)
    return item.note ?? 'A declared data path'
  return item.origin === undefined ? item.path : `${item.path} — from ${item.origin}`
}

/** True when every leaf of a workspace entry is selected. */
export function allLeavesSelected(entry: EntryChoice): boolean {
  return entry.leaves.length > 0 && entry.leaves.every(leaf => leaf.selected)
}

function entryHint(entry: BackupEntry): string {
  if (entry.note !== null && entry.note.length > 0)
    return entry.note
  if (entry.kind === 'settings')
    return 'Listener, auth, host vitals and the backups policy'
  if (entry.kind === 'secrets')
    return 'Password hash and API token hash'
  if (entry.kind === 'tls')
    return 'The panel\'s own certificate pair'
  return 'Its settings, servers, secrets and declared data paths'
}

/**
 * Builds the editable model from the panel's entries. When `previous` is given,
 * whatever the person already picked is kept for entries that still exist, so a
 * late frame (or a workspace created in another tab) never resets the selection.
 */
export function captureEntries(entries: BackupEntry[], previous: EntryChoice[] = []): EntryChoice[] {
  const before = new Map(previous.map(entry => [entry.id, entry]))
  return entries.map((entry) => {
    const old = before.get(entry.id)
    return {
      id: entry.id,
      label: entry.label,
      hint: entryHint(entry),
      kind: entry.kind,
      ...(entry.workspaceId === undefined ? {} : { workspaceId: entry.workspaceId }),
      selected: old?.selected ?? true,
      leaves: entry.items.map(item => ({
        id: item.id,
        label: item.label,
        hint: leafHint(item),
        kind: item.kind,
        selected: old?.leaves.find(leaf => leaf.id === item.id)?.selected ?? true,
      })),
    }
  })
}

/** A workspace with no selectable leaf left is not captured at all. */
export function effectiveSelected(entry: EntryChoice): boolean {
  if (entry.kind !== 'workspace')
    return entry.selected
  return entry.selected && entry.leaves.some(leaf => leaf.selected)
}

export function selectAll(entries: EntryChoice[], selected: boolean): void {
  for (const entry of entries) {
    entry.selected = selected
    for (const leaf of entry.leaves) leaf.selected = selected
  }
}

/**
 * The `include` list for the create request.
 *
 * `undefined` means "everything is selected", so the request stays unqualified —
 * and it is only ever returned for a non-empty tree, because an empty list must
 * never be read as "capture the whole panel". `[]` therefore means the caller
 * picked nothing, which is a state the dialog disables Create for; the API
 * client rejects it rather than silently widening the request. A fully selected
 * workspace is sent as one `workspace:<id>` id; a partly selected one sends only
 * its picked leaves.
 */
export function includeIds(entries: EntryChoice[]): string[] | undefined {
  const included = entries.filter(entry => effectiveSelected(entry))
  if (entries.length > 0 && included.length === entries.length && included.every(entry => entry.kind !== 'workspace' || allLeavesSelected(entry)))
    return undefined

  const ids: string[] = []
  for (const entry of included) {
    if (entry.kind !== 'workspace') {
      ids.push(entry.id)
      continue
    }
    if (allLeavesSelected(entry))
      ids.push(entry.id)
    else
      ids.push(...entry.leaves.filter(leaf => leaf.selected).map(leaf => leaf.id))
  }
  return ids
}

/** True when the request would capture the whole tree, i.e. `includeIds` returns `undefined`. */
export function capturesEverything(entries: EntryChoice[]): boolean {
  return includeIds(entries) === undefined
}

/** How many top-level entries and workspace leaves the request would capture. */
export function selectionCount(entries: EntryChoice[]): { entries: number, leaves: number } {
  let leaves = 0
  let count = 0
  for (const entry of entries) {
    if (!effectiveSelected(entry))
      continue
    count += 1
    leaves += entry.kind === 'workspace' ? entry.leaves.filter(leaf => leaf.selected).length : 1
  }
  return { entries: count, leaves }
}
