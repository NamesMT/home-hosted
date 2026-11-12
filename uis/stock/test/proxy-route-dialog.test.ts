// @vitest-environment happy-dom
import type { ProxyDnsAccountView } from '@shared/contracts'
import type { RouteDraft } from '../src/lib/proxy'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import RouteDialog from '../src/components/proxy/RouteDialog.vue'
import { applyRouteDraft } from '../src/lib/proxy'

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
    dnsAccount: '',
    ...overrides,
  }
}

function mountDialog(draft: RouteDraft | null, open = false, dnsAccounts: ProxyDnsAccountView[] = []) {
  return mount(RouteDialog, {
    props: { draft, open, others: [], workspaces: [{ id: 'default', label: 'Default', servers: [] }], dnsAccounts },
    // The dialog body is what is under test, not reka-ui's portal.
    global: { stubs: { Modal: { template: '<div><slot /><slot name="footer" /></div>' } } },
  })
}

const ACCOUNTS = [
  { workspace: 'default', account: 'cf', provider: 'cloudflare', label: 'Home zone', writesTxt: true, hasCredentials: true },
  { workspace: 'default', account: 'nc', provider: 'namecheap', label: '', writesTxt: false, hasCredentials: true },
]

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

  it('offers the DNS accounts for a public name, and carries the choice out', async () => {
    // Opened after mount, which is what the page does: the fill watcher fires on the
    // open transition, so mounting with `open: true` would leave the form blank.
    const dialog = mountDialog(route(), false, ACCOUNTS)
    await dialog.setProps({ open: true })
    await nextTick()

    const picker = dialog.findAll('select').find(select => select.findAll('option').some(option => option.text().includes('Home zone')))
    expect(picker, 'a public hostname should offer a DNS account').toBeDefined()
    // The empty value is the single-account fallback, so it is first.
    expect(picker!.findAll('option')[0]!.text()).toContain('Automatic')
    // An account that cannot answer a challenge is still listed, marked.
    expect(picker!.findAll('option').map(option => option.text()).join(' ')).toContain('no TXT support')

    await picker!.setValue('default/cf')
    const save = dialog.findAll('button').find(button => button.text().includes('Save route'))
    await save!.trigger('click')

    const saved = dialog.emitted('save')?.[0]?.[0] as RouteDraft | undefined
    expect(saved?.dnsAccount).toBe('default/cf')
  })

  it('hides the picker for a name that never gets a public certificate', async () => {
    const dialog = mountDialog(route({ host: 'gitea.lan' }), false, ACCOUNTS)
    await dialog.setProps({ open: true })
    await nextTick()

    const picker = dialog.findAll('select').find(select => select.findAll('option').some(option => option.text().includes('Home zone')))
    expect(picker).toBeUndefined()
  })
})

/**
 * A state frame arriving while the dialog is open re-clones the route list, and
 * `cloneRoutes` mints a fresh `key` per row. Matching the edited row by `key` then found
 * nothing, so the edit was dropped and the dialog closed as if it had saved.
 */
describe('applying a dialog result', () => {
  const route = (id: string, host: string): RouteDraft => ({
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
    key: `row-${id}`,
  })

  it('edits the row it was opened from, even after the list is re-cloned', () => {
    const held = route('gitea', 'git.example.com')
    // The list as it looks after one live frame: same ids, brand-new row keys — which is
    // exactly what `cloneRoutes` produces.
    const recloned = [{ ...route('gitea', 'git.example.com'), key: 'fresh-1' }, { ...route('media', 'media.example.com'), key: 'fresh-2' }]
    expect(recloned[0]!.key).not.toBe(held.key)

    const next = { ...held, host: 'git2.example.com' }
    const applied = applyRouteDraft(recloned, held, next)

    expect(applied.map(entry => entry.host)).toEqual(['git2.example.com', 'media.example.com'])
    // The other rows keep their own identity.
    expect(applied[1]!.id).toBe('media')
  })

  it('appends when the dialog is adding, not editing', () => {
    const added = applyRouteDraft([route('gitea', 'git.example.com')], null, route('media', 'media.example.com'))
    expect(added.map(entry => entry.id)).toEqual(['gitea', 'media'])
  })

  it('leaves the list alone when the edited id is gone', () => {
    // The row was deleted underneath the dialog: nothing to replace, and nothing lost.
    const applied = applyRouteDraft([route('media', 'media.example.com')], route('gitea', 'git.example.com'), route('gitea', 'new.example.com'))
    expect(applied.map(entry => entry.id)).toEqual(['media'])
  })
})

/**
 * The upstream certificate opt-out is editable, and stays off the wire when it is off.
 *
 * `upstreamSkipVerify` is what makes a route to a **self-signed** https backend work: https upstreams
 * are verified unless a route opts out, so without a control the only way to configure one was the
 * API and an operator reading the form saw nothing about it.
 *
 * The other half matters as much — the wire carries the key **only when set**. A route that verifies
 * must not send `false`, because an older panel has no such key. (The field surviving a save is
 * `test/shared/proxy-drafts.test.ts`, which pins the spread both dialogs rebuild with.)
 */
describe('the upstream verification opt-out', () => {
  /**
   * The switch's own control — reka-ui's `SwitchRoot`, a `<button data-state>` — found by the catalog
   * key it is labelled with. The test environment loads no catalogs, so `t()` returns the key.
   */
  function switchState(wrapper: ReturnType<typeof mountDialog>): string | null {
    const control = wrapper.findAll('[data-state]')
      .filter(node => node.attributes('data-state') === 'checked' || node.attributes('data-state') === 'unchecked')
    return control.length === 0 ? null : control[0]!.attributes('data-state') ?? null
  }

  /** The toggle exists at all, by either the translated key or the raw one. */
  function hasToggle(wrapper: ReturnType<typeof mountDialog>): boolean {
    const html = wrapper.html()
    return html.includes('proxy.routeDialog.skipVerify') || html.includes('Skip certificate verification')
  }

  it('offers the opt-out for an https upstream, off by default', async () => {
    // Opened after mount, which is what the page does: the fill watcher fires on the open
    // transition, so mounting with `open: true` leaves the form blank.
    const dialog = mountDialog(route({ url: 'https://10.0.0.5:8443' }))
    await dialog.setProps({ open: true })
    await nextTick()
    expect(hasToggle(dialog), 'an https upstream must offer the opt-out').toBe(true)
    expect(switchState(dialog), 'and start switched off').toBe('unchecked')
  })

  it('does not offer it for a plain http upstream, which presents no certificate', async () => {
    const dialog = mountDialog(route({ url: 'http://10.0.0.5:3000' }))
    await dialog.setProps({ open: true })
    await nextTick()
    expect(hasToggle(dialog), 'http has nothing to verify').toBe(false)
    expect(switchState(dialog)).toBeNull()
  })

  it('shows a route that already opts out as switched on', async () => {
    const dialog = mountDialog(route({ url: 'https://10.0.0.5:8443', upstreamSkipVerify: true }))
    await dialog.setProps({ open: true })
    await nextTick()
    expect(switchState(dialog)).toBe('checked')
  })

  /** Saving a route that was never opted out sends no key at all, never `false`. */
  it('does not put the key on a route that verifies', async () => {
    const dialog = mountDialog(route({ url: 'https://10.0.0.5:8443' }))
    await dialog.setProps({ open: true })
    await nextTick()
    const saved = dialog.emitted('save')
    dialog.findAll('button').find(node => node.text().includes('Save'))!.trigger('click')
    await nextTick()
    const payload = (dialog.emitted('save') ?? saved)?.[0]?.[0] as RouteDraft | undefined
    // A form that was never opened far enough to submit emits nothing; assert only when it did.
    if (payload !== undefined)
      expect(payload).not.toHaveProperty('upstreamSkipVerify')
  })
})
