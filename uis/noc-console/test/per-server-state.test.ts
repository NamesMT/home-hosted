import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every map the composable keys by *server* must be pruned when that server goes.
 *
 * `logLines` and `series` were deleted on removal and `lastSample` — the marker that dedupes samples per
 * server — was not, so every id the session ever sampled stayed in it for the life of the page. It is
 * inert rather than wrong (a re-added id has a different `sampledAt`, so the stale entry suppresses
 * nothing), but it is the same unbounded-growth shape the other two are pruned to prevent.
 *
 * A source-level check because the composable is module-level Vue state behind the API client: driving it
 * for real would mean mocking every call for one line of bookkeeping.
 */
const source = fs.readFileSync(fileURLToPath(new URL('../src/composables/useControlPlane.ts', import.meta.url)), 'utf8')

describe('per-server client state', () => {
  it('prunes every server-keyed map on removal', () => {
    // The server-keyed containers, named as they are declared.
    const serverKeyed = ['logLines', 'series', 'lastSample']
    for (const name of serverKeyed)
      expect(source, `${name} must be declared`).toMatch(new RegExp(`const ${name}\\b`))

    // Anti-vacuity: the removal path must actually delete something.
    const removal = source.slice(source.indexOf('remove: (workspaceId'), source.indexOf('remove: (workspaceId') + 400)
    expect(removal, 'the removal path must delete at least one map entry').toContain('delete ')

    const unpruned = serverKeyed.filter(name => !new RegExp(`(?:delete ${name}\\[|${name}\\.delete\\()`).test(removal))
    expect(unpruned, 'a server-keyed map that removal never prunes').toEqual([])
  })
})
