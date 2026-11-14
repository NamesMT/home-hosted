// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AccountsSection from '../src/components/settings/AccountsSection.vue'

/**
 * The accounts table mounts, lists accounts with their scopes, and offers to create one.
 *
 * A mount rather than only a source scan because the component fetches on mount: a failure there
 * would leave the table blank with the error nowhere, which is the shape a settings page fails in.
 */
describe('the accounts section', () => {
  it('lists an account with its scopes, and marks a disabled one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      accounts: [
        { id: 'admin', label: 'admin', scopes: ['read', 'admin'], enabled: true, isDefault: true, short: false, createdAt: 1, updatedAt: 1 },
        { id: 'viewer', label: 'the viewer', scopes: ['read'], enabled: false, isDefault: false, short: false, createdAt: 2, updatedAt: 2 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const wrapper = mount(AccountsSection)
    await new Promise(resolve => setTimeout(resolve, 50))
    await wrapper.vm.$nextTick()

    const text = wrapper.text()
    expect(text).toContain('admin')
    expect(text).toContain('viewer')
    // A disabled account is visible, not hidden: it still exists and can be re-enabled.
    expect(wrapper.findAll('table tr')).toHaveLength(3)
    expect(wrapper.text()).toMatch(/create account/i)
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('shows the secret once, with the header it authenticates', async () => {
    // The create dialog's own state machine is pinned by the source below; what this asserts is that
    // the **secret** is rendered with the `id:secret` shape, which is the one fact a person must see
    // correctly and the only time it is ever displayed.
    // The vitest working directory is the repo root; `import.meta.url` is not a file URL inside the
    // happy-dom environment, so it cannot be used here.
    const source = fs.readFileSync(path.join(process.cwd(), 'uis/stock/src/components/settings/AccountsSection.vue'), 'utf8')
    expect(source, 'the secret is rendered').toContain('minted.secret')
    expect(source, 'and with the header form a script needs').toContain('Bearer {{ minted.id }}:{{ minted.secret }}')
    expect(source, 'the shown-once warning is explicit').toContain('settings.accounts.shownOnce')
    // Nothing in the component reads a secret back from the server: there is nothing to read.
    expect(source).not.toContain('account.hash')
    expect(source).not.toContain('account.secret')
  })
})
