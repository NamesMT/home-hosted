// @vitest-environment happy-dom
import type { BackupScope, BackupsView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ScheduleScope from '../src/components/settings/ScheduleScope.vue'

/**
 * The scope dialog, round-tripped.
 *
 * The failure this pins is a silent one: the dialog seeds the tick tree from the *saved* scope and
 * writes the ticks back as a scope. If a seeded scope does not survive that round trip, opening the
 * page and pressing Save narrows an automatic backup — with nothing on screen to show it.
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

/** The dialog body/footer without reka-ui's portal. */
const stubs = { Modal: { template: '<div><slot /><slot name="footer" /></div>' } }

describe('the automatic backup scope dialog', () => {
  it('says the whole default scope until one is chosen', () => {
    const wrapper = mount(ScheduleScope, { props: { scope: null, state }, global: { stubs } })
    expect(wrapper.text()).toContain('Everything')
  })

  it('says what is saved, so the schedule is readable without opening the dialog', () => {
    // The summary is the only place the choice is visible on the page; a blank or wrong one hides
    // that a scheduled backup is narrower than "everything".
    const except = mount(ScheduleScope, { props: { scope: { mode: 'except', ids: ['global:secrets'] }, state }, global: { stubs } })
    expect(except.text()).toContain('Everything except 1')

    const only = mount(ScheduleScope, { props: { scope: { mode: 'only', ids: ['global:settings', 'global:tls'] }, state }, global: { stubs } })
    expect(only.text()).toContain('Only 2 selected')
  })

  it('round-trips a coarse exclusion instead of widening it back', async () => {
    // Every entry is still listed; only the excluded one is unticked. If the seeding failed to
    // untick it, applying would store `null` — the whole default — and the person's choice would
    // vanish on the next Save.
    let written: BackupScope | null | undefined
    const wrapper = mount(ScheduleScope, {
      props: {
        'scope': { mode: 'except', ids: ['global:secrets'] },
        'state': state,
        // `defineModel('scope')` emits `update:scope`, so the listener prop has to be spelled that
        // way; the quoted keys keep the object consistent with the one that needs them.
        'onUpdate:scope': (value: BackupScope | null) => { written = value },
      },
      global: { stubs },
    })

    const open = wrapper.findAll('button').find(node => node.text().includes('Choose'))
    if (!open)
      throw new Error('no choose button')
    await open.trigger('click')
    await nextTick()

    // The stubbed `Modal` renders every slot, so the sub-dialog's own footer (also inside a Modal)
    // comes first in the DOM: the scope dialog's Apply is the last one.
    const apply = wrapper.findAll('button').filter(node => node.text().trim() === 'Apply').at(-1)
    if (!apply)
      throw new Error('no apply button')
    await apply.trigger('click')
    await nextTick()

    expect(written).toEqual({ mode: 'except', ids: ['global:secrets'] })
  })

  it('clears the scope when everything is ticked again', async () => {
    // The empty setting is what also covers a workspace declared tomorrow, so "everything" must be
    // stored as no scope at all rather than as the full id list as it stands today.
    let written: BackupScope | null | undefined
    const wrapper = mount(ScheduleScope, {
      props: {
        'scope': { mode: 'only', ids: ['global:settings'] },
        'state': state,
        'onUpdate:scope': (value: BackupScope | null) => { written = value },
      },
      global: { stubs },
    })

    await wrapper.findAll('button').find(node => node.text().includes('Choose'))!.trigger('click')
    await nextTick()
    // The tree's own Select all is its first button; the sub-dialog's copy comes later in the DOM.
    await wrapper.findAll('button').filter(node => node.text().trim() === 'Select all').at(0)!.trigger('click')
    await nextTick()
    await wrapper.findAll('button').filter(node => node.text().trim() === 'Apply').at(-1)!.trigger('click')
    await nextTick()

    expect(written, 'everything means no scope').toBeNull()
  })
})
