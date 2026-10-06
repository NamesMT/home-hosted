import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '#src/config/store'

/**
 * The notice that lists `configWarnings` must not name a narrower cause than the array holds.
 *
 * It said *"Some keys in this workspace's config are not recognized"* while the array also carries
 * cross-field messages — `"app" depends on unknown server "ghost"` has been in there since
 * `81500f7`, long before the HEAD/body warning joined it. A user with a dependency typo read a heading
 * about unrecognized keys and a body about a dependency: the detail was right and the heading described
 * the wrong kind of problem.
 *
 * Pinned against the array's real contents, so a second kind of warning cannot silently outgrow the
 * copy again.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('the config-warning notice', () => {
  it('does not narrow its heading to one kind of warning', () => {
    // Two kinds in one file: an unrecognized key, and a dependency pointing at a missing id.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-warncopy-'))
    try {
      const servers = path.join(dir, 'servers.config.json')
      fs.writeFileSync(servers, JSON.stringify({ servers: [{ id: 'app', command: 'node', dependsOn: ['ghost'], notARealKey: 1 }] }, null, 2))
      const store = new WorkspaceStore('default', path.join(dir, 'settings.json'), servers)
      store.load()

      // Anti-vacuity: both kinds must actually be present, or the assertion below proves nothing.
      expect(store.configWarnings.some(w => w.includes('depends on unknown server'))).toBe(true)
      expect(store.configWarnings.some(w => w.includes('unrecognized key'))).toBe(true)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }

    // The heading must not claim the array is only about unrecognized keys.
    const view = fs.readFileSync(path.join(root, 'uis/stock/src/views/SettingsView.vue'), 'utf8')
    expect(view, 'the heading describes one kind while the body may hold another').not.toContain('keys in this workspace\'s config are not recognized')
    expect(view).toContain('config has a warning')
  })
})
