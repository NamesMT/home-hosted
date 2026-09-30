// @vitest-environment happy-dom
import type { RouteDraft } from '../src/lib/proxy'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import RouteDialog from '../src/components/proxy/RouteDialog.vue'

/**
 * Editing an existing route hands the dialog a row of the page's reactive route
 * list, and a `structuredClone` of a Vue proxy throws `DataCloneError` — which
 * used to abort the watcher *before* the form was filled, leaving the previous
 * route's values in place for Save to write back.
 */

function route(overrides: Partial<RouteDraft> = {}): RouteDraft {
  return {
    key: 'k',
    id: 'gitea',
    host: 'git.example.com',
    enabled: true,
    target: 'external',
    workspace: '',
    server: '',
    url: 'http://10.0.0.5:3000',
    path: '',
    tls: 'auto',
    ...overrides,
  }
}

function mountDialog(draft: RouteDraft | null, open = false) {
  return mount(RouteDialog, {
    props: { draft, open, others: [], workspaces: [{ id: 'default', label: 'Default', servers: [] }] },
    // The dialog body is what is under test, not reka-ui's portal.
    global: { stubs: { Modal: { template: '<div><slot /><slot name="footer" /></div>' } } },
  })
}

describe('the route dialog', () => {
  it('fills the form from a reactive draft instead of throwing', async () => {
    const rows = ref([route()])
    const dialog = mountDialog(rows.value[0]!)

    await dialog.setProps({ open: true })
    await nextTick()

    const host = dialog.findAll('input').find(input => (input.element as HTMLInputElement).value === 'git.example.com')
    expect(host, 'the hostname field should hold the route being edited').toBeDefined()
  })

  it('swaps to the second route when the page edits another row', async () => {
    const rows = ref([route(), route({ key: 'k2', id: 'media', host: 'media.example.com' })])
    const dialog = mountDialog(rows.value[0]!, true)
    await nextTick()

    // Closing and reopening is what the page does when another row is edited.
    await dialog.setProps({ open: false })
    await nextTick()
    await dialog.setProps({ draft: rows.value[1], open: true })
    await nextTick()

    const values = dialog.findAll('input').map(input => (input.element as HTMLInputElement).value)
    expect(values).toContain('media.example.com')
    expect(values).not.toContain('git.example.com')
  })
})
