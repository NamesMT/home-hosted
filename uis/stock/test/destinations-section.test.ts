// @vitest-environment happy-dom
import type { DestinationStatusView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ConfirmButton from '../src/components/settings/ConfirmButton.vue'
import DestinationsSection from '../src/components/settings/DestinationsSection.vue'
import NotificationPolicyFields from '../src/components/settings/NotificationPolicyFields.vue'
import { createWorkspaceForm } from '../src/components/settings/settingsForm'

/**
 * Both notifications components, **mounted**.
 *
 * No test mounted either of them, which is how two silent render defects shipped: `SettingsView`
 * used four components it never imported (Vue renders an unknown tag as an inert custom element),
 * and `NotificationPolicyFields` had two root nodes (an SFC cannot render that). Both compiled,
 * both typechecked, and 254 UI tests stayed green. A mount is the only thing that sees the
 * difference, so these assert what actually reaches the DOM.
 */

const telegramRow: DestinationStatusView = {
  kind: 'telegram',
  id: 'alerts',
  enabled: true,
  useOwnSettings: false,
  chatId: '424242',
  tokenSet: true,
  url: null,
  method: null,
  format: null,
  headers: null,
  onCrash: true,
  onUnhealthy: true,
  onForcedRestart: true,
  onRecovered: false,
  onHost: true,
  onDdns: true,
  cooldownMs: 120_000,
  lastResult: null,
  lastResultAt: null,
}

function mountSection(destinations = createWorkspaceForm().destinations) {
  return mount(DestinationsSection, {
    props: { statuses: [telegramRow], destinations, dirty: false },
    global: { stubs: { ConfirmButton: { template: '<button class="confirm">remove</button>' }, Notice: true } },
  })
}

describe('the destinations section renders', () => {
  it('shows the empty state, and an add button for each kind', () => {
    const section = mountSection([])
    expect(section.text()).toContain('No destination yet')
    expect(section.findAll('button').some(button => button.text().includes('Add Telegram'))).toBe(true)
    expect(section.findAll('button').some(button => button.text().includes('Add webhook'))).toBe(true)
  })

  it('renders a telegram row with its chat id and token controls', async () => {
    const form = createWorkspaceForm()
    form.destinations = [{
      id: 'alerts',
      kind: 'telegram',
      enabled: true,
      useOwnSettings: false,
      chatId: '424242',
      tokenSet: true,
      url: '',
      method: 'POST',
      format: 'json',
      headers: '',
      policy: { ...form.policy },
    }]

    const section = mountSection(form.destinations)
    // The values the page must show, not merely that a component exists.
    expect(section.text()).toContain('alerts')
    expect(section.text()).toContain('token set')
    expect((section.find('input').element as HTMLInputElement).value || section.html()).toContain('424242')
  })

  it('hides the policy fields while a destination inherits, and shows them when it does not', async () => {
    const form = createWorkspaceForm()
    form.destinations = [{
      id: 'alerts',
      kind: 'telegram',
      enabled: true,
      useOwnSettings: false,
      chatId: '',
      tokenSet: false,
      url: '',
      method: 'POST',
      format: 'json',
      headers: '',
      policy: { ...form.policy },
    }]

    const section = mountSection(form.destinations)
    // Inheriting: no policy fields, because the general block above is what applies.
    expect(section.findComponent(NotificationPolicyFields).exists()).toBe(false)

    await section.setProps({ destinations: [{ ...form.destinations[0]!, useOwnSettings: true }] })
    await nextTick()
    expect(section.findComponent(NotificationPolicyFields).exists()).toBe(true)
  })
})

describe('the policy fields component has one root', () => {
  /**
   * An SFC with two root nodes renders nothing at all. Asserting the fields exist is what catches
   * a regression to a bare `v-for` beside a sibling.
   */
  it('renders every toggle and the cooldown for the policy it is given', () => {
    const policy = { onCrash: true, onUnhealthy: true, onForcedRestart: true, onRecovered: false, onHost: true, onDdns: true, cooldownMs: 120_000 }
    const fields = mount(NotificationPolicyFields, { props: { modelValue: policy } })

    /*
     * A fragment and a wrapper look alike from `children.length`, so assert what actually differs:
     * the wrapper is a *real* element the fields sit inside. With a bare multi-root template Vue
     * renders an empty placeholder comment and the fields land as siblings — nothing renders.
     */
    expect(fields.element.tagName, 'a single root element, so the fields must sit inside one element').toBe('DIV')
    expect(fields.element.className, 'the root is the fields wrapper').toBe('contents')
    expect(fields.element.children.length, 'every field is inside that root').toBe(7)
    const labels = fields.findAll('label').map(label => label.text()).join(' ')
    for (const expected of ['Retries exhausted', 'Port unhealthy', 'Forced restart', 'Recovered', 'Host vitals breached', 'Dynamic DNS'])
      expect(labels, `${expected} must render`).toContain(expected)
    expect(fields.text()).toContain('Cooldown')
  })
})

/**
 * The confirmation names what removing *this* destination costs.
 *
 * The rows all bound the Telegram sentence, so removing a webhook said "any stored bot token for it
 * is removed" — a consequence a webhook does not have, and one that reads as though the button
 * deletes somebody else's credential. The webhook's own copy
 * (`settings.webhook.removeQuestion`/`removeBody`) existed in all nine catalogs and was rendered
 * nowhere.
 */
describe('the remove confirmation names the right consequence', () => {
  function row(kind: 'telegram' | 'webhook', id: string) {
    const form = createWorkspaceForm()
    return {
      ...form,
      destinations: [{
        id,
        kind,
        enabled: true,
        useOwnSettings: false,
        chatId: kind === 'telegram' ? '424242' : '',
        tokenSet: kind === 'telegram',
        url: kind === 'webhook' ? 'https://example.com/hook' : '',
        method: 'POST' as const,
        format: 'json' as const,
        headers: '',
        policy: { ...form.policy },
      }],
    }
  }

  it('tells a webhook that its URL and headers go', () => {
    const form = row('webhook', 'tickets')
    // The popover content is what states the cost, so read what the button was handed.
    const section = mount(DestinationsSection, {
      props: { statuses: [], destinations: form.destinations, dirty: false },
      global: { stubs: { Notice: true } },
    })

    const button = section.findAllComponents(ConfirmButton)[0]
    expect(button, 'the row rendered no confirmation').toBeDefined()
    const props = button!.props() as { title?: string, hint?: string }
    expect(props.hint, 'a webhook has no bot token to remove').toContain('URL and headers')
    expect(props.hint, 'the Telegram sentence must not reach a webhook').not.toContain('bot token')
    expect(props.title).toContain('tickets')
  })

  it('tells a Telegram destination that its token goes', () => {
    const form = row('telegram', 'alerts')
    const section = mount(DestinationsSection, {
      props: { statuses: [telegramRow], destinations: form.destinations, dirty: false },
      global: { stubs: { Notice: true } },
    })

    const button = section.findAllComponents(ConfirmButton)[0]
    const props = button!.props() as { title?: string, hint?: string }
    expect(props.hint).toContain('bot token')
  })
})
