// @vitest-environment happy-dom
import type { ProxyDnsAccountView } from '@shared/contracts'
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
