import type { RouteDraft } from '#src/shared/proxy-form'
import { describe, expect, it } from 'vitest'
import { reactive, ref, toRaw } from 'vue'
import { applyRouteDraft, cloneRoutes, newRouteKey } from '#src/shared/proxy-form'

/**
 * The two route-draft helpers both UIs call.
 *
 * They lived in each UI's `lib/proxy.ts` while the detach still needed Vue's `toRaw`; `clonePlain`
 * (`src/shared/clone.ts`) removed that reason, and the two copies were byte-identical. The cases
 * below came with the copies, and the reactive one is the defect they were fixed for: a list the
 * page rebuilt with `filter` holds Vue proxies inside the raw array, so `structuredClone(toRaw(…))`
 * threw `DataCloneError` before the dialog could fill its form.
 */
function route(overrides: Partial<RouteDraft> = {}): RouteDraft {
  return {
    key: newRouteKey(),
    id: 'gitea',
    host: 'git.example.com',
    enabled: true,
    target: 'external',
    workspace: '',
    server: '',
    url: 'http://10.0.0.5:3000',
    path: '',
    tls: 'off',
    dnsAccount: '',
    ...overrides,
  }
}

describe('cloneRoutes', () => {
  it('detaches every row, so an edit cannot reach live state', () => {
    const live = [route()]
    const [draft] = cloneRoutes(live)

    draft!.host = 'other.example.com'
    expect(live[0]!.host).toBe('git.example.com')
  })

  it('gives every cloned row its own key, which is why an edit matches by id', () => {
    const [first] = cloneRoutes([route()])
    const [second] = cloneRoutes([route()])

    expect(first!.id).toBe(second!.id)
    expect(first!.key).not.toBe(second!.key)
  })

  /** The regression: the list is reactive and a removal rebuilt it, so its members are proxies. */
  it('clones a route list a page rebuilt, which `structuredClone(toRaw(...))` cannot', () => {
    const routes = ref([route(), route({ id: 'media', host: 'media.example.com' })])
    routes.value = routes.value.filter(entry => entry.id !== 'gitea')
    expect(() => structuredClone(toRaw(routes.value)), 'anti-vacuity: the old clone throws').toThrow(/could not be cloned/)

    const drafts = cloneRoutes(routes.value)
    expect(drafts.map(entry => entry.host)).toEqual(['media.example.com'])
    // Plain all the way down, or the next clone on this list throws the same way.
    expect(() => structuredClone(drafts)).not.toThrow()
  })

  it('accepts a plain list too, which is what a test and a fresh fill hand it', () => {
    const live = reactive([route()])
    expect(cloneRoutes(live).map(entry => entry.host)).toEqual(['git.example.com'])
  })
})

/**
 * A row is matched by **id**, never by its `key`.
 *
 * A state frame arriving while the dialog is open re-clones the list and mints a fresh key per
 * row, so the row the dialog was opened from no longer matches by key — the edit was then dropped
 * and the dialog closed as if it had saved.
 */
describe('applyRouteDraft', () => {
  it('edits the row it was opened from, even after the list is re-cloned', () => {
    const held = route({ key: 'row-1' })
    const recloned = [route({ key: 'fresh-1' }), route({ id: 'media', host: 'media.example.com', key: 'fresh-2' })]
    expect(recloned[0]!.key).not.toBe(held.key)

    const applied = applyRouteDraft(recloned, held, { ...held, host: 'git2.example.com' })

    expect(applied.map(entry => entry.host)).toEqual(['git2.example.com', 'media.example.com'])
    expect(applied[1]!.id).toBe('media')
  })

  it('appends when the dialog is adding, not editing', () => {
    const added = applyRouteDraft([route()], null, route({ id: 'media', host: 'media.example.com' }))
    expect(added.map(entry => entry.id)).toEqual(['gitea', 'media'])
  })

  it('leaves the list alone when the edited id is gone', () => {
    // Deleted underneath the dialog: nothing to replace, and nothing lost.
    const applied = applyRouteDraft(
      [route({ id: 'media', host: 'media.example.com' })],
      route(),
      route({ host: 'new.example.com' }),
    )
    expect(applied.map(entry => entry.id)).toEqual(['media'])
  })
})
