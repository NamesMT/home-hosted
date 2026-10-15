// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Panel from '../src/components/ui/Panel.vue'
import { cn } from '../src/lib/cn'

/**
 * `Panel` takes the app's one container class list and lets a caller override part of it —
 * `<Panel class="p-0">` is used three times to drop the default padding.
 *
 * That only works because the merge is Tailwind-aware: plain string concatenation yields
 * `p-4 p-0`, where CSS source order decides rather than the caller. These pin the behaviour so
 * the helper cannot be swapped for a plain concat without a failure.
 */
function classesOf(wrapper: ReturnType<typeof mount>): string {
  return wrapper.find('section').classes().join(' ')
}

describe('the panel container', () => {
  it('pads by default and drops the padding when told not to', () => {
    expect(classesOf(mount(Panel))).toContain('p-4')
    expect(classesOf(mount(Panel, { props: { padded: false } }))).not.toContain('p-4')
  })

  it('lets a caller override the default padding, losing the default', () => {
    // The real usage: `<Panel class="p-0">` in the overview and server-detail views.
    const merged = classesOf(mount(Panel, { props: { class: 'p-0' } }))
    expect(merged).toContain('p-0')
    expect(merged).not.toContain('p-4')
  })

  it('keeps a caller class that does not conflict', () => {
    expect(classesOf(mount(Panel, { props: { class: 'mt-2' } }))).toContain('mt-2')
  })

  it('merges through the shared helper, not a second implementation', () => {
    // One `cn`, so `Panel` and every other component resolve a conflict the same way.
    const props = { class: 'p-0' }
    const merged = classesOf(mount(Panel, { props }))
    expect(merged).toBe(cn('rounded-panel border border-line bg-panel shadow-card', true && 'p-4', props.class))
  })
})
