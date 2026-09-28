import type { BackupPathEntry } from '@/lib/api'

/** One thing a backup can capture, as the dialog offers it. */
export interface CaptureItem {
  id: string
  label: string
  hint: string
}

export interface CaptureChoice extends CaptureItem {
  selected: boolean
}

/** `data:<path>` for this instance, whether or not the panel names it. */
export function dataId(entry: BackupPathEntry): string {
  return entry.id ?? `data:${entry.path}`
}

/** The panel's own state, then every declared path a backup would capture. */
export function captureItems(paths: BackupPathEntry[]): CaptureItem[] {
  const items: CaptureItem[] = [
    { id: 'config', label: 'config/servers.config.json', hint: 'the panel and its servers' },
    { id: 'secrets', label: 'secrets/control-secrets.json', hint: 'password hash, API token and Telegram credentials' },
    { id: 'tls', label: 'tls/', hint: 'the panel\'s own certificate pair' },
  ]

  for (const entry of paths) {
    if (entry.included)
      items.push({ id: dataId(entry), label: entry.path, hint: `from ${entry.origin}` })
  }

  return items
}

/** `undefined` when everything is selected, so the request stays unqualified. */
export function includeIds(choices: CaptureChoice[]): string[] | undefined {
  const selected = choices.filter(choice => choice.selected)
  return selected.length === choices.length ? undefined : selected.map(choice => choice.id)
}
