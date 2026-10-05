// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ToggleSwitch from '../src/components/ui/ToggleSwitch.vue'

/**
 * A component test rather than a pure-module one, for the same reason `number-field`
 * needed one: the defect lives in the rendered DOM, so nothing that does not mount the
 * component can see it.
 *
 * The switch's text sits in a sibling `<label>`, and a label only names a control by
 * wrapping it or by `for` — `SwitchRoot` renders a `<button>`, so the label named
 * nothing. Every one of these read as just "switch" to a screen reader.
 */
describe('toggleSwitch', () => {
  it('names the switch for assistive tech', () => {
    const wrapper = mount(ToggleSwitch, { props: { label: 'Allow backups', hint: 'Off stops new archives.' } })

    const control = wrapper.find('[role="switch"]')
    expect(control.exists()).toBe(true)

    const labelledBy = control.attributes('aria-labelledby')
    expect(labelledBy, 'the switch carries no accessible name').toBeTruthy()
    // The id it points at has to be in the DOM and hold the visible text.
    const named = wrapper.find(`#${labelledBy}`)
    expect(named.exists()).toBe(true)
    expect(named.text()).toBe('Allow backups')

    wrapper.unmount()
  })

  it('still names it when the label is only for assistive tech', () => {
    const wrapper = mount(ToggleSwitch, { props: { label: 'Enabled', srOnly: true } })

    const labelledBy = wrapper.find('[role="switch"]').attributes('aria-labelledby')
    const named = wrapper.find(`#${labelledBy}`)
    // `sr-only` hides it visually, not from the accessibility tree.
    expect(named.classes()).toContain('sr-only')
    expect(named.text()).toBe('Enabled')

    wrapper.unmount()
  })

  it('gives two switches in one app their own ids', () => {
    // One mount, two components — how the app actually renders them. Two separate
    // `mount()` calls are two apps, and `useId` restarts in each.
    const wrapper = mount({
      components: { ToggleSwitch },
      template: '<div><ToggleSwitch label="One" /><ToggleSwitch label="Two" /></div>',
    })

    const ids = wrapper.findAll('[role="switch"]').map(control => control.attributes('aria-labelledby'))
    expect(new Set(ids).size).toBe(2)
    // Each id resolves to its OWN label, not the first one in the tree.
    expect(wrapper.find(`#${ids[0]}`).text()).toBe('One')
    expect(wrapper.find(`#${ids[1]}`).text()).toBe('Two')

    wrapper.unmount()
  })

  it('toggles the model when the label is clicked, and not when disabled', async () => {
    const wrapper = mount(ToggleSwitch, { props: { label: 'Allow backups' } })

    await wrapper.find('label').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([true])

    const disabled = mount(ToggleSwitch, { props: { label: 'Locked', disabled: true } })
    await disabled.find('label').trigger('click')
    expect(disabled.emitted('update:modelValue')).toBeUndefined()

    wrapper.unmount()
    disabled.unmount()
  })
})
