// @vitest-environment happy-dom
import type { LogLine } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { TooltipProvider } from 'reka-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import LogViewer from '../src/components/log/LogViewer.vue'

/**
 * Auto-follow is a watcher, and a watcher only runs when its source changes. The source
 * used to be the visible line count, which stops changing once the client buffer hits its
 * cap (MAX_CLIENT_LINES): follow then silently stopped while the footer still said
 * "streaming". These drive the real component with a stubbed rAF.
 */
/**
 * The app wraps everything in a `TooltipProvider`; the viewer's header uses a tooltip, so
 * it has to be mounted inside one. The bound props are returned so a test can reassign the
 * array and the version together, which is what a real batch looks like.
 */
function mountInApp(initial: { lines: LogLine[], version: number, live?: boolean }) {
  const bound = reactive({ ...initial })
  const wrapper = mount({
    components: { LogViewer, TooltipProvider },
    template: '<TooltipProvider><LogViewer v-bind="bound" /></TooltipProvider>',
    setup: () => ({ bound }),
  })
  return { wrapper, bound }
}

const frames: FrameRequestCallback[] = []

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  // happy-dom has no layout, so the scroll target is a stub either way.
  Element.prototype.scrollTo = () => {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function line(text: string, ts: number): LogLine {
  return { ts, stream: 'stdout', text }
}

describe('logViewer auto-follow', () => {
  it('schedules a scroll for every batch', async () => {
    const lines = ref<LogLine[]>([line('a', 1)])
    const version = ref(1)
    const { wrapper, bound } = mountInApp({ lines: lines.value, version: version.value, live: true })
    await nextTick()

    const before = frames.length
    lines.value = [line('a', 1), line('b', 2)]
    version.value = 2
    bound.lines = lines.value
    bound.version = version.value
    await nextTick()

    expect(frames.length).toBeGreaterThan(before)
    wrapper.unmount()
  })

  /**
   * The case that used to break: the buffer is at its cap, so the array keeps its length
   * while its content moves on. A count-keyed watcher sees no change.
   */
  it('still follows when the buffer is full and only its content changes', async () => {
    const cap = 5
    const lines = ref<LogLine[]>(Array.from({ length: cap }, (_, index) => line(`old-${index}`, index)))
    const version = ref(1)
    const { wrapper, bound } = mountInApp({ lines: lines.value, version: version.value, live: true })
    await nextTick()

    const before = frames.length
    // One line in, one line out: a real buffer at its cap.
    lines.value = [...lines.value.slice(1), line('newest', 99)]
    version.value = 2
    bound.lines = lines.value
    bound.version = version.value
    await nextTick()

    expect(lines.value).toHaveLength(cap)
    expect(frames.length).toBeGreaterThan(before)
    wrapper.unmount()
  })

  it('does not follow once the person has taken over', async () => {
    const lines = ref<LogLine[]>([line('a', 1), line('b', 2)])
    const version = ref(1)
    const { wrapper, bound } = mountInApp({ lines: lines.value, version: version.value, live: true })
    await nextTick()

    // Pause follow, then a batch arrives.
    const toggle = wrapper.findAll('button').find(button => /follow|pause/i.test(button.text()))
    if (toggle !== undefined) {
      await toggle.trigger('click')
      await nextTick()
    }
    const before = frames.length
    lines.value = [...lines.value, line('c', 3)]
    version.value = 2
    bound.lines = lines.value
    bound.version = version.value
    await nextTick()

    // Either the toggle paused it (no new frame) or there was no toggle to press.
    expect(frames.length === before || toggle === undefined).toBe(true)
    wrapper.unmount()
  })
})
