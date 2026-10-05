// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ConfirmButton from '../src/components/ConfirmButton.vue'

/**
 * A destructive action must confirm as its own step, never by arming the same button for a
 * second press: arming reuses the spot, so an impatient double click fires it. The stock
 * UI's port kill was moved to a popover for exactly this reason, and this is its
 * counterpart — the destructive button is a separate target inside a confirmation sheet.
 */
describe('confirmButton', () => {
  it('does not fire on a rapid second click', async () => {
    const wrapper = mount(ConfirmButton, { props: { label: 'delete', confirmLabel: 'confirm', tone: 'danger' } })

    const trigger = wrapper.find('button')
    expect(trigger.text()).toBe('delete')
    // The trigger keeps its own label and no destructive button exists yet.
    expect(wrapper.findAll('button').map(button => button.text())).not.toContain('confirm')

    await trigger.trigger('click')
    await trigger.trigger('click')
    await nextTick()

    expect(wrapper.emitted('confirm')).toBeUndefined()

    wrapper.unmount()
  })

  it('confirms only from the button inside the sheet', async () => {
    const wrapper = mount(ConfirmButton, {
      props: { label: 'delete', confirmLabel: 'Confirm delete', title: 'Delete it?', hint: 'this cannot be undone' },
    })

    await wrapper.find('button').trigger('click')
    await nextTick()

    // The heading and the note are shown, and cancel comes first in tab order.
    expect(wrapper.text()).toContain('Delete it?')
    expect(wrapper.text()).toContain('this cannot be undone')
    const texts = wrapper.findAll('button').map(button => button.text())
    expect(texts.indexOf('cancel')).toBeLessThan(texts.indexOf('Confirm delete'))

    await wrapper.findAll('button').find(button => button.text() === 'Confirm delete')!.trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)

    wrapper.unmount()
  })

  it('closes without confirming when cancelled', async () => {
    const wrapper = mount(ConfirmButton, { props: { label: 'delete', confirmLabel: 'Confirm delete' } })

    await wrapper.find('button').trigger('click')
    await nextTick()
    await wrapper.findAll('button').find(button => button.text() === 'cancel')!.trigger('click')
    await nextTick()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.findAll('button').map(button => button.text())).toEqual(['delete'])

    wrapper.unmount()
  })
})
