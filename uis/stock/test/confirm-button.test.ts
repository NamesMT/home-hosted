// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ConfirmButton from '../src/components/settings/ConfirmButton.vue'

/**
 * A destructive action must confirm in a *popover*, never by arming the same button for a
 * second press: arming reuses the same spot, so an impatient double click fires it.
 *
 * This is a component test because the defect is entirely in the rendered behaviour — one
 * `<button>` that renamed itself, so the second click of a double click landed on the same
 * pixels. The popover's own content is portalled to `document.body`, so these query that
 * rather than the wrapper.
 */
const panelButtons = (): HTMLButtonElement[] => [...document.body.querySelectorAll('button')]
const byText = (text: string): HTMLButtonElement | undefined => panelButtons().find(button => button.textContent?.trim() === text)

describe('confirmButton', () => {
  it('does not fire on a rapid second click', async () => {
    const wrapper = mount(ConfirmButton, { props: { label: 'Delete', confirmLabel: 'Confirm delete' } })

    const trigger = wrapper.find('button')
    expect(trigger.text()).toBe('Delete')
    // The trigger keeps its own label: an armed button would have renamed this same
    // element, which is what put the destructive action under the second click.
    expect(byText('Confirm delete')).toBeUndefined()

    // A double click — two clicks in quick succession, the second on the same element.
    await trigger.trigger('click')
    await trigger.trigger('click')
    await nextTick()

    // Nothing fired. The second click just toggled the popover shut again.
    expect(wrapper.emitted('confirm')).toBeUndefined()

    wrapper.unmount()
  })

  it('fires only from the destructive button inside the popover', async () => {
    const wrapper = mount(ConfirmButton, {
      props: { label: 'Delete', confirmLabel: 'Confirm delete', title: 'Delete this archive?', hint: 'It cannot be recovered.' },
    })

    await wrapper.find('button').trigger('click')
    await nextTick()

    expect(document.body.textContent).toContain('Delete this archive?')
    expect(document.body.textContent).toContain('It cannot be recovered.')

    // The safe choice comes first in the panel's tab order.
    const ordered = panelButtons().map(button => button.textContent?.trim())
    expect(ordered.indexOf('Cancel')).toBeGreaterThanOrEqual(0)
    expect(ordered.indexOf('Cancel')).toBeLessThan(ordered.indexOf('Confirm delete'))

    byText('Confirm delete')!.click()
    await nextTick()
    expect(wrapper.emitted('confirm')).toHaveLength(1)

    wrapper.unmount()
  })

  it('carries the busy state onto the trigger', () => {
    const wrapper = mount(ConfirmButton, { props: { label: 'Delete', loading: true } })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
