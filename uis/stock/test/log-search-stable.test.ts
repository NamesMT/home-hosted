// @vitest-environment happy-dom
import type { LogLine } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { TooltipProvider } from 'reka-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import LogViewer from '../src/components/log/LogViewer.vue'

/**
 * Stepping through search matches jumped back to the first one every time a line arrived: the reset
 * watched `matches`, which is rebuilt on every batch. Only a new query or stream filter starts over.
 */
function line(text: string, ts: number): LogLine {
  return { ts, stream: 'stdout', text }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('log search keeps its place', () => {
  it('holds the current match across a new batch, and clamps when matches fall off', async () => {
    const bound = reactive({ lines: [line('err 1', 1), line('err 2', 2), line('err 3', 3)], version: 1, live: true })
    const wrapper = mount({
      components: { LogViewer, TooltipProvider },
      template: '<TooltipProvider><LogViewer v-bind="bound" /></TooltipProvider>',
      setup: () => ({ bound }),
    })
    const search = wrapper.find('input[type="search"]')
    await search.setValue('err')
    await nextTick()
    const counter = (): string => search.element.parentElement!.querySelector('span.font-mono')!.textContent!.trim()
    expect(counter()).toBe('1/3')

    await search.trigger('keydown', { key: 'Enter' })
    await search.trigger('keydown', { key: 'Enter' })
    expect(counter()).toBe('3/3')

    // A batch arrives: a new array and a new version, as the store hands them out.
    bound.lines = [...bound.lines, line('err 4', 4)]
    bound.version = 2
    await nextTick()
    await nextTick()
    expect(counter(), 'the reader stays on the match they stepped to').toBe('3/4')

    // The buffer trimmed down to one match: the counter stays in range.
    bound.lines = [line('err 4', 4)]
    bound.version = 3
    await nextTick()
    await nextTick()
    expect(counter()).toBe('1/1')

    // A new query starts over.
    await search.setValue('err 4')
    await nextTick()
    expect(counter()).toBe('1/1')
    wrapper.unmount()
  })
})
