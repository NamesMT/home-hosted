import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What the removal confirmation promises must match what removal does.
 *
 * The UI said *"its persisted logs stay on disk"* from v0.3.0 onwards. `fix(supervisor): a removed server
 * takes its log files with it` made that false, and `fix(supervisor): reclaim a removed server's history`
 * added a second consequence nothing mentioned. A confirmation that describes the wrong outcome is worse
 * than none: it is the sentence a person reads at the moment they decide.
 *
 * Pinned against the code rather than a copied string, so the next change to removal fails here.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const SUPERVISOR = fs.readFileSync(path.join(root, 'src/services/supervisor.ts'), 'utf8')

/** The `sync()` branch that handles a server leaving `servers.config.json`. */
function removalBranch(): string {
  const start = SUPERVISOR.indexOf('const config = wanted.get(id)')
  const end = SUPERVISOR.indexOf('const bufferChanged', start)
  expect(start, 'the removal branch must exist').toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SUPERVISOR.slice(start, end)
}

describe('the removal confirmation', () => {
  it('claims only what the removal branch actually does', () => {
    const branch = removalBranch()
    // The branch deletes the log files…
    expect(branch, 'the branch must clear the log files').toContain('logFiles.clear(id)')
    // …and forgets the crash history.
    expect(branch, 'the branch must forget the history').toContain('history.forget(id)')

    // So the UI must not promise the logs survive, and should mention both losses.
    const copies = [
      fs.readFileSync(path.join(root, 'uis/stock/src/components/server/ServerCard.vue'), 'utf8'),
      fs.readFileSync(path.join(root, 'uis/stock/src/views/ServerDetailView.vue'), 'utf8'),
    ]
    for (const copy of copies) {
      expect(copy, 'the logs do not stay on disk any more').not.toContain('persisted logs stay on disk')
      expect(copy, 'and the history goes with them').toContain('crash history are deleted')
    }
  })
})
