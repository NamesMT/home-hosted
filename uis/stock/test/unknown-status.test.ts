// @vitest-environment happy-dom
import type { ServerStatus } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StatusPill from '../src/components/ui/StatusPill.vue'
import { statusLabel, statusMeta } from '../src/lib/status'

/**
 * The client now accepts a status a newer panel added rather than dropping the whole frame, so every
 * lookup by status must survive a value it has no row for: indexing `STATUS_META` with one threw
 * inside the render and blanked the page that the lenient parser had just kept alive.
 */
describe('a status this UI does not know', () => {
  it('renders as it came, in a neutral tone', () => {
    const wrapper = mount(StatusPill, { props: { status: 'hibernating' as ServerStatus, health: 'degraded' as never } })
    expect(wrapper.text()).toContain('hibernating')
    expect(statusMeta('hibernating').tone).toBe('neutral')
    expect(statusLabel('hibernating')).toBe('hibernating')
    wrapper.unmount()
  })

  it('still labels a known one from the catalog', () => {
    expect(statusMeta('crashed')).toMatchObject({ labelKey: 'status.crashed', tone: 'danger' })
  })
})
