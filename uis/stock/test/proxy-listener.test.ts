// @vitest-environment happy-dom
import type { ListenerDraft } from '../src/lib/proxy'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import ListenerPanel from '../src/components/proxy/ListenerPanel.vue'
import { UNPRIVILEGED_HTTP_PORT, UNPRIVILEGED_HTTPS_PORT } from '../src/lib/proxy'

/**
 * The listener block binds straight onto the page's reactive object, so the
 * switch and the port presets have to land on that object — a nested `v-model`
 * on a model ref is exactly the shape that silently writes nowhere.
 */

function draft(overrides: Partial<ListenerDraft> = {}): ListenerDraft {
  return { enabled: false, httpPort: 80, httpsPort: 443, email: '', staging: false, dns01: false, resolvers: '', ...overrides }
}

function mountPanel(form: ListenerDraft, emailHost: string | null = null) {
  return mount(ListenerPanel, {
    props: { form, enginePath: '/home/u/.hh/.proxy/bin/hh-caddy', emailHost, dnsAccounts: [] },
  })
}

describe('the listener panel', () => {
  it('writes the run switch back to the page’s draft', async () => {
    const form = reactive(draft())
    const wrapper = mountPanel(form)

    await wrapper.get('[role="switch"]').trigger('click')
    expect(form.enabled).toBe(true)
  })

  it('offers the unprivileged pair, and 80/443 again', async () => {
    const form = reactive(draft())
    const wrapper = mountPanel(form)
    const button = (label: string) => wrapper.findAll('button').find(node => node.text().includes(label))!

    await button(`Use ${UNPRIVILEGED_HTTP_PORT} / ${UNPRIVILEGED_HTTPS_PORT}`).trigger('click')
    expect(form.httpPort).toBe(UNPRIVILEGED_HTTP_PORT)
    expect(form.httpsPort).toBe(UNPRIVILEGED_HTTPS_PORT)

    await button('Use 80 / 443').trigger('click')
    expect(form.httpPort).toBe(80)
    expect(form.httpsPort).toBe(443)
  })

  it('explains the privileged bind, with the exact command', () => {
    const wrapper = mountPanel(draft())

    expect(wrapper.text()).toContain('needs a privileged bind')
    expect(wrapper.text()).toContain('sudo setcap \'cap_net_bind_service=+ep\' /home/u/.hh/.proxy/bin/hh-caddy')
  })

  it('asks for the ACME e-mail only when a public hostname needs one', () => {
    expect(mountPanel(draft({ email: '' }), 'gitea.example.com').text()).toContain('An e-mail is needed')
    expect(mountPanel(draft({ email: 'me@example.com' }), null).text()).not.toContain('An e-mail is needed')
  })
})
