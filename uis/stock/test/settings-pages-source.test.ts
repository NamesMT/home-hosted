import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The chrome lives in one file, and neither page may carry its own copy again.
 *
 * The mounted tests beside it can only see what a mount renders; this one fails on a *re-introduced
 * copy* even in a branch a mount never reaches — the way the duplication came back the first time.
 * It matches the markup itself, not a comment, so a cosmetic rename does not hide it.
 */
describe('the chrome has one definition', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const page = (name: string): string => fs.readFileSync(path.join(root, 'src/views', name), 'utf8')

  it('keeps the save/discard footer, the rail and the changes list out of both pages', () => {
    for (const name of ['GlobalSettingsView.vue', 'SettingsView.vue']) {
      const source = page(name)
      expect(source, `${name} re-declares the footer`).not.toContain('Discard changes')
      expect(source, `${name} re-declares the rail`).not.toContain('\'sticky top-6 space-y-0.5')
      expect(source, `${name} re-declares the changes list`).not.toContain('divide-y divide-line-soft')
      // And each page reads the shell rather than a section-local copy of it.
      expect(source, `${name} should use the shared shell`).toContain('from \'@/components/settings/SettingsShell.vue\'')
    }
  })

  it('keeps each page on its own save call', () => {
    expect(page('GlobalSettingsView.vue')).toContain('saveGlobalSettings')
    expect(page('GlobalSettingsView.vue'), 'the panel-wide page must not call the workspace save').not.toContain('saveWorkspaceSettings')
    expect(page('SettingsView.vue')).toContain('saveWorkspaceSettings')
    expect(page('SettingsView.vue'), 'the workspace page must not write the panel-wide file').not.toContain('saveGlobalSettings')
  })

  it('keeps every section anchor, so the rail always has a target to scroll to', () => {
    const shell = fs.readFileSync(path.join(root, 'src/components/settings/SettingsShell.vue'), 'utf8')
    expect(shell, 'the shell renders the rail').toContain('SettingsSection')

    for (const [name, ids] of [
      ['GlobalSettingsView.vue', ['listener', 'authentication', 'host', 'backups', 'tls', 'interface', 'paths']],
      ['SettingsView.vue', ['defaults', 'logs', 'notifications', 'ddns']],
    ] as const) {
      // One `SettingsSection` per rail entry: a missing anchor leaves that entry dead.
      for (const id of ids)
        expect(page(name), `${name} has no section anchored at ${id}`).toContain(`id="${id}"`)
      expect(page(name).match(/<SettingsSection/g)?.length).toBe(ids.length)
    }
  })
})
