import type { BackupsView } from '@shared/contracts'

/** One thing a backup can capture, as the dialog offers it. */
export interface CaptureItem {
  id: string
  label: string
  hint: string
}

export interface CaptureChoice extends CaptureItem {
  selected: boolean
}

/**
 * The panel's own global slices carry stable ids. A workspace contributes its
 * own leaf ids (`workspace:<id>:servers`, …) and each declared data path as
 * `workspace:<id>:data:<path>` — exactly what `createBackup`'s `include` takes.
 */
const GLOBAL_ITEMS: CaptureItem[] = [
  { id: 'global:settings', label: 'global settings', hint: 'listener, auth, TLS policy, host vitals, backups' },
  { id: 'global:secrets', label: 'global secrets', hint: 'password hash and API token' },
  { id: 'global:tls', label: 'tls/', hint: 'the panel\'s own certificate pair' },
]

/**
 * What a backup would capture, flattened from the view's two levels: the global
 * slices first, then every workspace's own leaves and data paths. A data path
 * the panel reports as not included is left out, exactly as before.
 */
export function captureItems(view: BackupsView | null): CaptureItem[] {
  if (view === null)
    return []

  const items: CaptureItem[] = [...GLOBAL_ITEMS]
  for (const entry of view.entries) {
    for (const item of entry.items) {
      if (item.kind === 'data') {
        if (!item.included)
          continue
        items.push({
          id: item.id,
          label: item.path ?? item.label,
          hint: `from ${item.origin ?? entry.label}`,
        })
        continue
      }
      items.push({
        id: item.id,
        label: item.path ?? item.label,
        hint: `${entry.label} — ${item.label.toLowerCase()}`,
      })
    }
  }
  return items
}

/** `undefined` when everything is selected, so the request stays unqualified. */
export function includeIds(choices: CaptureChoice[]): string[] | undefined {
  const selected = choices.filter(choice => choice.selected)
  return selected.length === choices.length ? undefined : selected.map(choice => choice.id)
}
