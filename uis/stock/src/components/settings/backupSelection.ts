import type { BackupEntry } from '@shared/contracts'
import { scopeOf } from '@shared/backup-scope'
import { t } from '@/i18n'
import { panelNote, panelText } from '@/lib/panel-text'

/**
 * The two-level capture model the backup dialog edits.
 *
 * The top level is one selectable entry per archive root: the global settings,
 * secrets and TLS pair, plus one entry per workspace. A workspace's own entry
 * carries several leaves (its settings, servers, secrets and each declared data
 * path), which a nested dialog picks from — a workspace can be captured whole or
 * only in part. The global secrets entry carries one leaf per secret the same way.
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
  /** Empty for an entry that has no sub-choices; the leaves otherwise. */
  leaves: LeafChoice[]
}

/** Per-secret hints, keyed by the leaf's `secret`; the aggregate hint covers a key with none. */
const SECRET_HINTS: Record<string, string> = {
  password: 'settings.backup.secretPasswordHint',
  apiToken: 'settings.backup.secretApiTokenHint',
  telegram: 'settings.backup.secretTelegramHint',
  ddns: 'settings.backup.secretDdnsHint',
}

/** A readable hint for why a leaf would be captured. */
function leafHint(item: BackupEntry['items'][number]): string {
  // A note from the panel explains why this leaf is excluded, so it outranks the kind's hint.
  const note = panelNote(item)
  if (note !== null && note.length > 0)
    return note
  if (item.kind === 'settings')
    return t('settings.backup.leafSettingsHint')
  if (item.kind === 'servers')
    return t('settings.backup.leafServersHint')
  if (item.kind === 'secrets') {
    const key = item.secret === undefined ? undefined : SECRET_HINTS[item.secret]
    return key === undefined ? t('settings.backup.leafSecretsHint') : t(key)
  }
  if (item.path === undefined)
    return t('settings.backup.leafDataHint')
  return item.origin === undefined ? item.path : t('settings.backup.pathFromOrigin', { path: item.path, origin: item.origin })
}

/** True when every leaf of an entry is selected; an entry with no leaves has none to select. */
export function allLeavesSelected(entry: EntryChoice): boolean {
  return entry.leaves.length > 0 && entry.leaves.every(leaf => leaf.selected)
}

function entryHint(entry: BackupEntry): string {
  const note = panelNote(entry)
  if (note !== null && note.length > 0)
    return note
  if (entry.kind === 'settings')
    return t('settings.backup.entrySettingsHint')
  if (entry.kind === 'secrets')
    return t('settings.backup.entrySecretsHint')
  if (entry.kind === 'tls')
    return t('settings.backup.entryTlsHint')
  return t('settings.backup.entryWorkspaceHint')
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
      label: panelText(entry),
      hint: entryHint(entry),
      kind: entry.kind,
      ...(entry.workspaceId === undefined ? {} : { workspaceId: entry.workspaceId }),
      selected: old?.selected ?? true,
      leaves: entry.items.map(item => ({
        id: item.id,
        label: panelText(item),
        hint: leafHint(item),
        kind: item.kind,
        selected: old?.leaves.find(leaf => leaf.id === item.id)?.selected ?? true,
      })),
    }
  })
}

/** An entry with no leaf left selected is not captured at all, whoever it belongs to. */
export function effectiveSelected(entry: EntryChoice): boolean {
  if (entry.leaves.length === 0)
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
 * `undefined` means "everything is selected", so the request stays unqualified, and it is only ever
 * returned for a non-empty tree, because an empty list must never be read as "capture the whole
 * panel". `[]` therefore means the caller picked nothing, which is a state the dialog disables
 * Create for; the API client rejects it rather than silently widening the request.
 */
export function includeIds(entries: EntryChoice[]): string[] | undefined {
  // The collapse rule lives in `@shared/backup-scope` now: the schedule's scope editor writes the
  // same ids down, and a second copy of "a wholly picked entry travels as its own id" is how the
  // dialog and the schedule would come to disagree about what a tick means.
  const outcome = scopeOf(entries, 'only')
  if (outcome.kind === 'everything')
    return undefined
  return outcome.kind === 'nothing' ? [] : outcome.scope.ids
}

/** True when the request would capture the whole tree, i.e. `includeIds` returns `undefined`. */
export function capturesEverything(entries: EntryChoice[]): boolean {
  return scopeOf(entries, 'only').kind === 'everything'
}

/** How many top-level entries and leaves the request would capture; an entry with no leaves counts as one. */
export function selectionCount(entries: EntryChoice[]): { entries: number, leaves: number } {
  let leaves = 0
  let count = 0
  for (const entry of entries) {
    if (!effectiveSelected(entry))
      continue
    count += 1
    leaves += entry.leaves.length === 0 ? 1 : entry.leaves.filter(leaf => leaf.selected).length
  }
  return { entries: count, leaves }
}
