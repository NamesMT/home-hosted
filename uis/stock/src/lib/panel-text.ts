import { t } from '@/i18n'

/**
 * Text the panel formatted itself, rendered in the reader's language.
 *
 * The panel knows *which* string this is ("Global settings", "covered by …"); only the UI knows the
 * language. So it sends a catalog key beside the English, as `STATUS_META` does with `labelKey`.
 *
 * The English is the fallback on purpose: a UI can be newer than its panel, and one that predates
 * these keys sends only the text — which beats a raw key or an empty cell.
 */
export interface PanelText {
  label: string
  labelKey?: string
  labelParams?: Record<string, string>
}

export interface PanelNote {
  note: string | null
  noteKey?: string
  noteParams?: Record<string, string>
}

/** The panel's text, in the reader's language when it named the string, else as it wrote it. */
export function panelText(source: PanelText): string {
  if (source.labelKey === undefined)
    return source.label
  return t(source.labelKey, source.labelParams, source.label)
}

/** The same for a note: `null` stays `null`, so "no note" never becomes an empty line. */
export function panelNote(source: PanelNote): string | null {
  if (source.note === null)
    return null
  if (source.noteKey === undefined)
    return source.note
  return t(source.noteKey, source.noteParams, source.note)
}

/**
 * The badge word for an archive root's kind. One map for both surfaces, because the dialog printed
 * the raw kind while the section showed a word. An unknown kind reads as itself.
 */
const KIND_KEY: Record<string, string> = {
  settings: 'settings.backups.kindSettings',
  servers: 'settings.backups.kindServers',
  secrets: 'settings.backups.kindSecrets',
  tls: 'settings.backups.kindTls',
  data: 'settings.backups.kindData',
  workspace: 'settings.backups.kindWorkspace',
}

export function kindLabel(kind: string): string {
  const key = KIND_KEY[kind]
  return key === undefined ? kind : t(key)
}
