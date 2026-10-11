// @vitest-environment happy-dom
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick, reactive } from 'vue'
import ServerFormFields from '../src/components/ServerFormFields.vue'

/**
 * The shared server form, mounted.
 *
 * `server-form.test.ts` pins the catalogue as data; this pins the *wiring*, which is what
 * the extraction actually risked. A catalogue nobody renders, or a field whose edit never
 * reaches the form object, would pass every pure-module check and leave the dialog unable
 * to create a server.
 */
function mountForm(variant: 'sheet' | 'page', over: Record<string, string | boolean> = {}) {
  const form = reactive<Record<string, string | boolean>>(over)
  const wrapper = mount(ServerFormFields, {
    props: { variant, form },
    slots: { lifecycle: '<div class="lifecycle-slot" />' },
  })
  return { wrapper, form }
}

/**
 * The field a label belongs to. `within` scopes the search, because the form legitimately
 * shows the same word twice — a process `command` and a bootstrap `command` — and grabbing
 * the first would silently test the wrong one.
 */
function fieldInput(wrapper: VueWrapper, label: string, within?: DOMWrapper<Element>) {
  const root = within ?? (wrapper as unknown as DOMWrapper<Element>)
  const field = root.findAll('label').find(node => node.find('.field__label').exists() && node.text().includes(label))
  if (!field)
    throw new Error(`no field labelled “${label}” was rendered`)
  return field
}

describe('the shared server form', () => {
  it('renders the sheet’s fields, with the lifecycle slot where the dialog wants it', () => {
    const { wrapper } = mountForm('sheet', { id: '', label: '', command: '', bootstrapEnabled: false, logBufferLines: '' })
    expect(wrapper.find('input').exists()).toBe(true)
    // The dialog's `id` box, which only this variant has.
    expect(wrapper.text()).toContain('id')
    expect(wrapper.find('.lifecycle-slot').exists()).toBe(true)
    wrapper.unmount()
  })

  /**
   * The dialog's shell is a leading grid of the everyday fields, then a folded half. The
   * fold is part of the sheet's shape, not of the field catalogue, so nothing else pins it.
   */
  it('keeps the everyday grid outside the fold, in the dialog’s own order', () => {
    const { wrapper } = mountForm('sheet', { id: '', label: '', command: '', bootstrapEnabled: false, logBufferLines: '' })
    const root = wrapper.element as HTMLElement
    const [leading, folded] = Array.from(root.children)

    expect(leading!.tagName).toBe('DIV')
    expect(leading!.className).toBe('grid')
    expect(folded!.tagName).toBe('DETAILS')
    expect(folded!.className).toBe('advanced')
    expect(leading!.querySelector('summary')).toBeNull()

    // `command` also names the bootstrap box, so compare by position rather than text.
    const labels = Array.from(leading!.querySelectorAll('.field__label')).map(node => node.textContent)
    expect(labels).toEqual([
      'id',
      'label',
      'command',
      'args — space separated',
      'cwd',
      'port',
      'bind',
      'autostart with up',
      'persistent',
    ])
    wrapper.unmount()
  })

  it('renders the page’s panes, and the readout only where the page places it', () => {
    const { wrapper } = mountForm('page', { label: '', port: '', bind: 'local' })
    expect(wrapper.findAll('.pane').length).toBeGreaterThan(0)
    const readout = fieldInput(wrapper, 'live bind address')
    expect(readout.find('input').attributes('disabled')).toBeDefined()
    // The `id` box belongs to the dialog alone.
    expect(fieldInput(wrapper, 'live bind address')).toBeTruthy()
    wrapper.unmount()
  })

  it('writes an edit back into the entry point’s own form object', async () => {
    const { wrapper, form } = mountForm('sheet', { id: '', label: '', command: '' })
    await fieldInput(wrapper, 'label').find('input').setValue('renamed')
    expect(form.label).toBe('renamed')
    wrapper.unmount()
  })

  it('toggles a checkbox field through to the form object', async () => {
    const { wrapper, form } = mountForm('sheet', { autostart: false, label: '', id: '', command: '' })
    await fieldInput(wrapper, 'autostart with up').find('input').setValue(true)
    expect(form.autostart).toBe(true)
    wrapper.unmount()
  })

  it('disables the bootstrap boxes until the section’s own toggle is on', async () => {
    const { wrapper, form } = mountForm('sheet', { bootstrapEnabled: false, bootstrapCommand: '' })
    // Scoped to the bootstrap group: the process \`command\` above it must stay enabled.
    const bootstrap = wrapper.findAll('.group').find(node => node.text().includes('bootstrap'))!
    expect(fieldInput(wrapper, 'command', bootstrap).find('input').attributes('disabled')).toBeDefined()
    expect(fieldInput(wrapper, 'run before the first start', bootstrap).find('input').attributes('disabled')).toBeUndefined()

    form.bootstrapEnabled = true
    await nextTick()
    expect(fieldInput(wrapper, 'command', bootstrap).find('input').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows the page’s explicit-IPv4 box only while bind is custom', async () => {
    const { wrapper, form } = mountForm('page', { bind: 'local', customBind: '' })
    expect(wrapper.text()).not.toContain('ipv4 address')

    form.bind = 'custom'
    await nextTick()
    expect(wrapper.text()).toContain('ipv4 address')
    wrapper.unmount()
  })

  it('fills the sheet’s log-buffer placeholder from the inherited default', () => {
    const { wrapper } = mountForm('sheet', { logBufferLines: '', label: '', id: '', command: '' })
    const input = fieldInput(wrapper, 'log buffer lines').find('input')
    expect(input.attributes('placeholder')).toBe('inherited (500)')
    wrapper.unmount()
  })

  /**
   * The dialog puts the caret in its `id` box when it opens, as it did before the
   * extraction. The mount is attached to the document because a detached one cannot hold
   * focus at all — the first version of this test failed against working code for that
   * reason.
   */
  it('moves focus to the field an entry point asks for', async () => {
    const form = reactive<Record<string, string | boolean>>({ id: '', label: '', command: '' })
    const wrapper = mount(ServerFormFields, {
      props: { variant: 'sheet', form },
      slots: { lifecycle: '<div class="lifecycle-slot" />' },
      attachTo: document.body,
    })
    ;(wrapper.vm as unknown as { focusField: (key: string) => void }).focusField('id')
    await nextTick()

    expect((document.activeElement as HTMLInputElement | null)?.getAttribute('placeholder')).toBe('my-server')
    wrapper.unmount()
  })
})
