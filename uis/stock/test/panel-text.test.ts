// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { __resetLocaleForTests, setLocale } from '@/i18n'
import { kindLabel, panelNote, panelText } from '@/lib/panel-text'

/**
 * The panel composes some display text itself — a backup entry's name, a data path's verdict, why a
 * restore skipped a row. i18n in the UI cannot reach a string the panel already formatted, so the
 * panel sends a catalog key beside its English and `panelText`/`panelNote` resolve it.
 *
 * The bug this exists for: a Vietnamese panel read "Global settings / Global secrets / does not
 * exist yet / workspace" in the backup dialog, because those four strings came from the panel.
 */
describe('panelText', () => {
  afterEach(() => __resetLocaleForTests())

  it('renders the panel’s label in the reader’s language', async () => {
    const entry = { label: 'Global settings', labelKey: 'settings.backup.entryGlobalSettings' }
    const expected = {
      'en': 'Global settings',
      'vi': 'Cài đặt toàn cục',
      'zh-CN': '全局设置',
      'ja': '全体設定',
      'es': 'Ajustes globales',
      'ko': '전역 설정',
      'ru': 'Общие настройки',
      'fr': 'Paramètres globaux',
      'de': 'Globale Einstellungen',
    } as const
    for (const [locale, text] of Object.entries(expected)) {
      await setLocale(locale)
      expect(panelText(entry), locale).toBe(text)
    }
  })

  it('renders a note in the reader’s language, and keeps "no note" as null', async () => {
    const missing = { note: 'not set', noteKey: 'settings.backup.noteMissing' }
    await setLocale('vi')
    expect(panelNote(missing)).toBe('chưa đặt')
    expect(panelNote({ note: null })).toBeNull()
  })

  it('falls back to the panel’s English when it named no key', async () => {
    // A UI newer than its panel: those fields did not exist, so the text is all there is.
    await setLocale('ja')
    expect(panelText({ label: 'my-workspace' })).toBe('my-workspace')
    expect(panelNote({ note: 'covered by /srv/data' })).toBe('covered by /srv/data')
  })

  it('translates the kind badge, including a workspace', async () => {
    // `workspace` was missing from the map, so both surfaces showed the raw internal word.
    await setLocale('de')
    expect(kindLabel('workspace')).toBe('Arbeitsbereich')
    // The badge keeps the catalog's own lower-case convention rather than title-casing a code.
    expect(kindLabel('tls')).toBe('tls')
    // An unknown kind reads as itself, which is what a newer panel's new kind should look like.
    expect(kindLabel('brand-new')).toBe('brand-new')
  })
})
