import { describe, expect, it } from 'vitest'
import { stockCopy } from '../helpers/stock-copy'

/**
 * What the removal confirmation promises must match what removal does: a removed server takes its
 * log files and its crash history with it (pinned by "a removed server" in `supervisor.test.ts`).
 * The UI said "its persisted logs stay on disk" long after that stopped being true.
 */
describe('the removal confirmation', () => {
  it('names both losses and never promises the logs survive', () => {
    const copies: Array<[string, string]> = [
      ['ServerCard', stockCopy('serverCard.removeDescription', { label: 'web' })],
      ['ServerDetailView', stockCopy('views.serverDetail.removeDescription', { label: 'web' })],
    ]
    for (const [name, copy] of copies) {
      expect(copy, `${name}: the logs do not stay on disk any more`).not.toContain('persisted logs stay on disk')
      expect(copy, `${name}: the history goes with them`).toContain('crash history are deleted')
    }
  })
})
