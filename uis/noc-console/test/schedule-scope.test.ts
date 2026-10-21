// @vitest-environment happy-dom
import type { BackupScope, BackupsView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ScheduleScope from '../src/components/ScheduleScope.vue'

/**
 * The automatic-scope dialog, round-tripped.
 *
 * `uis/stock` has the same dialog over its own capture tree; this one runs over noc-console's flat
 * leaf list, so the seeding rule is what differs and what is worth pinning. A scope that does not
 * survive the round trip narrows a schedule on an ordinary Save, with nothing on screen to show it.
 */

const state: BackupsView = {
  enabled: true,
  dir: '/tmp/.backups',
  keep: 5,
  schedule: { intervalMs: 3_600_000, keep: 7 },
  lastAutomaticAt: null,
  includePaths: [],
  entries: [
    { id: 'global:settings', label: 'Panel settings', kind: 'settings', note: null, items: [] },
    { id: 'global:secrets', label: 'Secrets', kind: 'secrets', note: null, items: [] },
    {
      id: 'workspace:default',
      label: 'Default',
      kind: 'workspace',
      workspaceId: 'default',
      note: null,
      items: [
        { id: 'workspace:default:settings', label: 'Settings', kind: 'settings', included: true, note: null },
        { id: 'workspace:default:servers', label: 'Servers', kind: 'servers', included: true, note: null },
      ],
    },
  ],
  files: [],
}

function mountScope(scope: BackupScope | null, onWrite: (value: BackupScope | null) => void) {
  return mount(ScheduleScope, {
    // `defineModel('scope')` emits `update:scope`; the quoted keys are needed for that one and keep
    // the object consistent.
    props: { 'open': false, 'state': state, 'scope': scope, 'onUpdate:scope': onWrite },
  })
}

async function openAndApply(wrapper: ReturnType<typeof mountScope>): Promise<void> {
  await wrapper.setProps({ open: true })
  await nextTick()
  await wrapper.findAll('button').find(node => node.text().trim() === 'apply')!.trigger('click')
  await nextTick()
}

describe('noc-console\'s automatic backup scope', () => {
  it('round-trips a saved exclusion instead of widening it back', async () => {
    let written: BackupScope | null | undefined
    const wrapper = mountScope({ mode: 'except', ids: ['global:secrets'] }, (value) => { written = value })
    await openAndApply(wrapper)
    expect(written).toEqual({ mode: 'except', ids: ['global:secrets'] })
  })

  it('stores "everything ticked" as no scope at all', async () => {
    // Only the empty setting also covers a workspace declared tomorrow; the full id list would not.
    let written: BackupScope | null | undefined
    const wrapper = mountScope({ mode: 'only', ids: ['global:settings'] }, (value) => { written = value })
    await wrapper.setProps({ open: true })
    await nextTick()
    await wrapper.findAll('button').find(node => node.text().trim() === 'select all')!.trigger('click')
    await nextTick()
    await wrapper.findAll('button').find(node => node.text().trim() === 'apply')!.trigger('click')
    await nextTick()
    expect(written, 'everything means no scope').toBeNull()
  })

  it('refuses an empty tick rather than reading it as the whole default', async () => {
    let written: BackupScope | null | undefined
    const wrapper = mountScope({ mode: 'only', ids: ['global:settings'] }, (value) => { written = value })
    await wrapper.setProps({ open: true })
    await nextTick()

    const none = wrapper.findAll('button').find(node => node.text().trim() === 'select none')
    if (!none)
      throw new Error('no select-none button')
    await none.trigger('click')
    await nextTick()

    const apply = wrapper.findAll('button').find(node => node.text().trim() === 'apply')!
    expect(apply.attributes('disabled'), 'an empty selection cannot be applied').toBeDefined()
    await apply.trigger('click')
    await nextTick()
    expect(written, 'nothing was written').toBeUndefined()
  })
})
