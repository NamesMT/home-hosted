// @vitest-environment happy-dom
import type { HealthState, ServerStatus } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HealthChip from '../src/components/HealthChip.vue'
import StatusChip from '../src/components/StatusChip.vue'

/**
 * The client accepts a status or health value a newer panel added (`@shared/live-frames`), so the
 * chips must show one they have no label for as it came, not as an empty chip.
 */
describe('a value this UI does not know', () => {
  it('is shown as-is', () => {
    expect(mount(StatusChip, { props: { status: 'hibernating' as ServerStatus } }).text()).toBe('hibernating')
    expect(mount(HealthChip, { props: { health: 'degraded' as HealthState } }).text()).toBe('degraded')
    expect(mount(HealthChip, { props: { health: 'disabled' } }).text()).toBe('off')
  })
})
