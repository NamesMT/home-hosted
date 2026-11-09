// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref, withDirectives } from 'vue'
import { vFocusTrap } from '../src/composables/useFocusTrap'
import { closeTopLayer, useModalLayer } from '../src/composables/useModalLayer'

/**
 * Only one of the console's modal panels set `aria-modal`, none kept focus inside, and closing one
 * left focus on `<body>`. Escape also closed a modal and the drawer under it in one press.
 */
function tab(shift = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })
  document.activeElement!.dispatchEvent(event)
  return event
}

function dialog(open: ReturnType<typeof ref<boolean>>, buttons: string[], inner?: ReturnType<typeof ref<boolean>>) {
  return defineComponent({
    setup() {
      return () => h('div', [
        h('button', { id: 'opener' }, 'open'),
        open.value
          ? withDirectives(h('div', { role: 'dialog', id: 'outer' }, [
              ...buttons.map(id => h('button', { id }, id)),
              inner?.value === true
                ? withDirectives(h('div', { role: 'dialog', id: 'inner' }, [h('button', { id: 'yes' }, 'yes'), h('button', { id: 'no' }, 'no')]), [[vFocusTrap]])
                : null,
            ]), [[vFocusTrap]])
          : null,
      ])
    },
  })
}

describe('the focus trap', () => {
  it('moves focus in, cycles Tab inside, and gives it back on close', async () => {
    const open = ref(false)
    const wrapper = mount(dialog(open, ['a', 'b', 'c']), { attachTo: document.body })
    const opener = document.getElementById('opener')!
    opener.focus()

    open.value = true
    await nextTick()
    expect(document.activeElement?.id).toBe('a')

    document.getElementById('c')!.focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(document.activeElement?.id, 'Tab on the last control wraps to the first').toBe('a')
    tab(true)
    expect(document.activeElement?.id, 'Shift+Tab on the first wraps to the last').toBe('c')
    document.getElementById('b')!.focus()
    expect(tab().defaultPrevented, 'a Tab in the middle is the browser\'s own').toBe(false)

    open.value = false
    await nextTick()
    expect(document.activeElement).toBe(opener)
    wrapper.unmount()
  })

  it('holds focus on a panel with nothing focusable, and lets the inner of two dialogs own Tab', async () => {
    const open = ref(true)
    const inner = ref(false)
    const wrapper = mount(dialog(open, [], inner), { attachTo: document.body })
    await nextTick()
    const outer = document.getElementById('outer')!
    expect(document.activeElement).toBe(outer)
    expect(tab().defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(outer)

    inner.value = true
    await nextTick()
    expect(document.activeElement?.id).toBe('yes')
    document.getElementById('no')!.focus()
    tab()
    expect(document.activeElement?.id, 'the inner dialog wraps, the outer one does not interfere').toBe('yes')

    inner.value = false
    await nextTick()
    expect(document.activeElement, 'closing the inner dialog returns focus to the outer one').toBe(outer)
    wrapper.unmount()
  })
})

describe('escape closes one layer per press', () => {
  it('closes the topmost modal and leaves the drawer for the next press', async () => {
    const open = ref(true)
    let drawer = true
    const host = defineComponent({
      setup() {
        useModalLayer(() => open.value, () => { open.value = false })
        return () => h('div')
      },
    })
    const wrapper = mount(host)
    const closeDrawer = (): void => {
      drawer = false
    }
    closeTopLayer(closeDrawer)
    await nextTick()
    expect(open.value).toBe(false)
    expect(drawer, 'the drawer under the modal stays open').toBe(true)
    closeTopLayer(closeDrawer)
    expect(drawer).toBe(false)
    wrapper.unmount()
  })
})
