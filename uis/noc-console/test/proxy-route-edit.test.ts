import type { RouteDraft } from '../src/lib/proxy'
import { describe, expect, it } from 'vitest'
import { applyRouteDraft, cloneRoutes } from '../src/lib/proxy'

/**
 * A state frame arriving while the route dialog is open re-clones the list, and
 * `cloneRoutes` mints a fresh `key` for every row. Matching the edited row by `key` then
 * found nothing, so the edit was silently dropped and the dialog closed as if it had saved.
 */
function route(id: string, host: string, key: string): RouteDraft {
  return {
    id,
    host,
    target: 'external',
    workspace: '',
    server: '',
    url: 'http://10.0.0.5:8080',
    path: '',
    tls: 'off',
    enabled: true,
    dnsAccount: '',
    key,
  }
}

describe('applying a route dialog result', () => {
  it('edits the row it was opened from, even after the list is re-cloned', () => {
    const held = route('gitea', 'git.example.com', 'row-1')
    // The list after one live frame: same ids, brand-new row keys.
    const recloned = [route('gitea', 'git.example.com', 'fresh-1'), route('media', 'media.example.com', 'fresh-2')]
    expect(recloned[0]!.key).not.toBe(held.key)

    const applied = applyRouteDraft(recloned, held, { ...held, host: 'git2.example.com' })

    expect(applied.map(entry => entry.host)).toEqual(['git2.example.com', 'media.example.com'])
    expect(applied[1]!.id).toBe('media')
  })

  it('appends when the dialog is adding, not editing', () => {
    const added = applyRouteDraft([route('gitea', 'git.example.com', 'row-1')], null, route('media', 'media.example.com', 'row-2'))
    expect(added.map(entry => entry.id)).toEqual(['gitea', 'media'])
  })

  it('leaves the list alone when the edited id is gone', () => {
    const applied = applyRouteDraft(
      [route('media', 'media.example.com', 'row-2')],
      route('gitea', 'git.example.com', 'row-1'),
      route('gitea', 'new.example.com', 'row-1'),
    )
    expect(applied.map(entry => entry.id)).toEqual(['media'])
  })

  /** What makes the bug reachable: a re-clone always produces new keys. */
  it('re-keys every row on a clone, which is why the id has to be the key', () => {
    const first = cloneRoutes([route('gitea', 'git.example.com', 'row-1')])
    const second = cloneRoutes([route('gitea', 'git.example.com', 'row-1')])
    expect(first[0]!.id).toBe(second[0]!.id)
    expect(first[0]!.key).not.toBe(second[0]!.key)
  })
})
