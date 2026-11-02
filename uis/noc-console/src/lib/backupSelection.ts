import type { BackupScheduleConfig, BackupScope, BackupSelection } from '@shared/contracts'
import { sameScope, scopeOf } from '@shared/backup-scope'

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
export function captureItems(view: BackupSelection | null): CaptureItem[] {
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
  // noc-console's list is flat, so every choice carries no sub-leaves; the shared rule then reduces
  // to "all ticked means unqualified, otherwise the ticked ids".
  const outcome = scopeOf(choices.map(choice => ({ id: choice.id, selected: choice.selected, leaves: [] })), 'only')
  if (outcome.kind === 'everything')
    return undefined
  return outcome.kind === 'nothing' ? [] : outcome.scope.ids
}

/**
 * What a saved scope is, in one line, before the scope dialog is opened.
 *
 * The one place the choice is visible on the page — a blank or wrong line hides that a scheduled
 * backup is narrower than "everything", and the next Save keeps it that way.
 */
export function describeScope(scope: BackupScope | null): string {
  if (scope === null)
    return 'everything (the default scope)'
  const count = scope.ids.length
  const items = `${count} item${count === 1 ? '' : 's'}`
  return scope.mode === 'only' ? `only ${items} selected` : `everything except ${items}`
}

/** The schedule fields as the page edits them: hours on screen, milliseconds in the file. */
export interface BackupScheduleForm {
  enabled: boolean
  hours: number
  keep: number
  scope: BackupScope | null
}

/** The schema's own default retention, for a panel that predates the schedule and sends none. */
const DEFAULT_KEEP = 7

/**
 * The `schedule` group of an automatic-backup patch: only the members that actually changed.
 *
 * `stored` and `form` are different types on purpose — swapping them does not compile, and both are
 * plain data, so the rule is testable without mounting the view.
 *
 * Three failures this rules out, all silent on screen:
 *  - the rounded hours field riding along on an unrelated save, turning a 90-minute interval the
 *    API set into 2 hours;
 *  - an untouched dialog re-sending the scope, because the patch merges by key and a rebuilt object
 *    is how a page starts rewriting a config nobody edited;
 *  - a cleared scope travelling as an absent key, which the panel reads as "keep whatever is
 *    stored" — `null` is the only spelling for "back to everything".
 */
export function schedulePatch(stored: BackupScheduleConfig | undefined, form: BackupScheduleForm): Record<string, unknown> {
  const intervalMs = stored?.intervalMs ?? 0
  const hoursOnScreen = Math.max(1, Math.round(intervalMs / 3_600_000) || 1)
  const patch: Record<string, unknown> = {}
  // Compared as the *form* sees it, never the rounded hours against the real milliseconds: a
  // 90-minute interval displays as "2 h", so comparing the two rewrote it to 2 hours on a save that
  // only changed the retention. `0` is the file's spelling for "off", and the switch and the hour
  // count are one field — which is why the enabled flag is compared too.
  if (form.enabled !== (intervalMs > 0) || form.hours !== hoursOnScreen)
    patch.intervalMs = form.enabled ? form.hours * 3_600_000 : 0
  if (form.keep !== (stored?.keep ?? DEFAULT_KEEP))
    patch.keep = form.keep
  // The order the panel wrote the ids in is not part of what a scope means.
  if (!sameScope(form.scope, stored?.scope))
    patch.scope = form.scope
  return patch
}
