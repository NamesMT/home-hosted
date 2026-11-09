// @vitest-environment happy-dom
import type { LogLine } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick, reactive } from 'vue'
import LogPane from '../src/components/LogPane.vue'

/**
 * Auto-follow watched the line count, and the live buffer is capped at 1000: once full, a batch
 * keeps the length while the content moves on, so follow stopped while the pane still said "live".
 */
function line(text: string): LogLine {
  return { ts: 1, stream: 'stdout', text }
}

describe('the noc-console log pane', () => {
  it('keeps following once the buffer is at its cap', async () => {
    const lines = reactive(Array.from({ length: 5 }, (_, index) => line(`old-${index}`)))
    const wrapper = mount(LogPane, { props: { lines, live: true, max: 400 } })
    const body = wrapper.find('.log__body').element as HTMLElement
    let scrolls = 0
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: () => {
        scrolls += 1
      },
    })
    await nextTick()
    const before = scrolls

    // One line in, one out, in place — how the live buffer moves when it is full.
    lines.splice(0, lines.length, ...lines.slice(1), line('new'))
    await nextTick()
    await nextTick()
    expect(scrolls, 'a full buffer must still scroll to the new line').toBeGreaterThan(before)
    wrapper.unmount()
  })
})
