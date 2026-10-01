// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import RetryCertificateButton from '../src/components/proxy/RetryCertificateButton.vue'

/**
 * Retrying takes the name out of the engine's configuration so it lets go of the
 * certificate it fell back to. It is only offered once the engine has actually fallen
 * back, and it asks in a popover with the safe choice first.
 */

function mountButton(retryIn = '~8 hours') {
  return mount(RetryCertificateButton, {
    props: { host: 'git.example.com', retryIn },
    global: { stubs: { PopoverPortal: { template: '<div><slot /></div>' } } },
  })
}

describe('the retry certificate button', () => {
  it('does not retry on the first click', async () => {
    const button = mountButton()

    await button.find('button').trigger('click')
    await nextTick()

    expect(button.emitted('confirm')).toBeUndefined()
    // What the click did was open the question, naming the host it would touch.
    expect(button.text()).toContain('Ask the CA again for git.example.com?')
  })

  it('retries only from the explicit choice, and says what it costs', async () => {
    const button = mountButton()
    await button.find('button').trigger('click')
    await nextTick()

    const text = button.text()
    // What happened, what the engine does by itself, and what forcing it costs.
    expect(text).toContain('failed to obtain a CA certificate')
    expect(text).toContain('local CA')
    expect(text).toContain('It retries automatically every ~8 hours.')
    expect(text).toContain('will kill this route and make it unavailable for a bit')
    // The safe choice comes first in the tab order.
    const choices = button.findAll('button').map(entry => entry.text())
    expect(choices.indexOf('Leave it')).toBeLessThan(choices.indexOf('Retry now'))

    const retry = button.findAll('button').find(entry => entry.text() === 'Retry now')!
    await retry.trigger('click')
    expect(button.emitted('confirm')).toHaveLength(1)
  })

  it('offers the automatic interval it was given, not a fixed number', async () => {
    const button = mountButton('~40 minutes')
    await button.find('button').trigger('click')
    await nextTick()

    expect(button.text()).toContain('every ~40 minutes')
    expect(button.text()).not.toContain('8 hours')
  })
})
