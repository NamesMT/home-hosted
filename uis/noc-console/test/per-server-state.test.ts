import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every map the composable keys by *server* must be pruned when that server goes.
 *
 * The buffers and series live in the shared live store now (`store.forget` prunes them, pinned in
 * `test/shared/live-store.test.ts`); the one map this wrapper still owns is the pane-facing
 * `logLines`, so its removal path must call the store and drop that entry too.
 */
const source = fs.readFileSync(fileURLToPath(new URL('../src/composables/useControlPlane.ts', import.meta.url)), 'utf8')

describe('per-server client state', () => {
  it('prunes every server-keyed map on removal', () => {
    expect(source).toMatch(/const logLines\b/)
    const removal = source.slice(source.indexOf('remove: (workspaceId'), source.indexOf('remove: (workspaceId') + 400)
    expect(removal, 'the store owns the buffers and the series').toContain('store.forget(workspaceId, id)')
    expect(removal, 'and the wrapper its own pane arrays').toMatch(/delete logLines\[/)
  })
})
