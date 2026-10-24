// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { closeTopModal, modalDepth, modalOpen, useModalLayer } from '../src/composables/useModalLayer'

/**
 * An open overlay must own the keyboard.
 *
 * Both halves of this were measured in Chromium on the built panel (`dist/cli.js`, a real home,
 * four real entries) before this file existed:
 *
 *  - four surfaces drew an `esc` keycap and did nothing when it was pressed — the "stop all" and
 *    "remove" confirmations, the create-backup sheet and the restore sheet. `esc` is advertised
 *    in the overlay's own head, so pressing it and watching nothing happen reads as a broken UI.
 *  - with the "stop all" sheet open, the shell's single-key shortcuts still fired: `x` stopped the
 *    selected server *behind* the confirmation (`svc2 running` → `stopped`, sheet still open) and
 *    `j` moved the selection the sheet covered. The shell tested a hand-written list of its own
 *    flags, which cannot see a dialog whose open state lives in the component.
 *
 * The fix is one registry rather than twelve listeners, so these cases pin the registry's two
 * decisions — the topmost layer owns Escape, and the depth is honest — and the scan beside them
 * pins that every modal surface registers at all.
 */
describe('useModalLayer', () => {
  /** A component whose open state is a ref the test drives, counting how often it is closed. */
  function layer(initial: boolean) {
    const open = ref(initial)
    const closes = ref(0)
    const host = defineComponent({
      setup() {
        useModalLayer(() => open.value, () => { closes.value++ })
        return () => h('div')
      },
    })
    return { open, closes, wrapper: mount(host) }
  }

  it('is not open until a layer registers, and closes the topmost one only', async () => {
    expect(modalOpen()).toBe(false)
    expect(closeTopModal()).toBe(false)
    expect(modalDepth.value).toBe(0)

    const first = layer(true)
    const second = layer(true)
    expect(modalDepth.value).toBe(2)
    expect(modalOpen()).toBe(true)

    // Escape reaches the overlay that is on top, so a confirmation inside a page cannot dismiss
    // the work that page holds behind it.
    expect(closeTopModal()).toBe(true)
    expect(second.closes.value).toBe(1)
    expect(first.closes.value).toBe(0)

    // Closing the overlay is what unregisters it — the top of the stack is then the page's own.
    second.open.value = false
    await nextTick()
    expect(closeTopModal()).toBe(true)
    expect(first.closes.value).toBe(1)

    first.open.value = false
    await nextTick()
    expect(modalOpen()).toBe(false)
    expect(closeTopModal()).toBe(false)

    first.wrapper.unmount()
    second.wrapper.unmount()
  })

  it('registers on open and leaves on close, so the refusal follows the overlay', async () => {
    const { open, wrapper } = layer(false)
    expect(modalOpen()).toBe(false)

    open.value = true
    await nextTick()
    expect(modalOpen()).toBe(true)
    expect(modalDepth.value).toBe(1)

    open.value = false
    await nextTick()
    expect(modalOpen()).toBe(false)
    expect(modalDepth.value).toBe(0)

    wrapper.unmount()
  })

  it('unregisters when the component goes away while still open', () => {
    const { wrapper } = layer(true)
    expect(modalOpen()).toBe(true)
    wrapper.unmount()
    expect(modalOpen()).toBe(false)
    expect(modalDepth.value).toBe(0)
  })
})
