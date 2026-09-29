// @vitest-environment happy-dom
import type { BackupsView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import BackupDialog from '../src/components/settings/BackupDialog.vue'
import * as api from '../src/lib/api'

const state: BackupsView = {
  enabled: true,
  dir: '/tmp/.backups',
  keep: 5,
  includePaths: [],
  entries: [
    { id: 'global:settings', label: 'Panel settings', kind: 'settings', note: null, items: [] },
    { id: 'global:secrets', label: 'Secrets', kind: 'secrets', note: null, items: [] },
    { id: 'global:tls', label: 'TLS', kind: 'tls', note: null, items: [] },
    {
      id: 'workspace:default',
      label: 'Default',
      kind: 'workspace',
      workspaceId: 'default',
      note: null,
      items: [
        { id: 'workspace:default:settings', label: 'Settings', kind: 'settings', included: true, note: null },
        { id: 'workspace:default:servers', label: 'Servers', kind: 'servers', included: true, note: null },
        {
          id: 'data:/srv/app/data',
          label: '/srv/app/data',
          kind: 'data',
          path: '/srv/app/data',
          origin: 'app:DATA_DIR',
          included: true,
          note: null,
        },
      ],
    },
  ],
  files: [],
}

/** The dialog body/footer without reka-ui's portal: the mapping is what is under test. */
const stubs = {
  Modal: { template: '<div><slot /><slot name="footer" /></div>' },
}

/**
 * The dialog is what now guarantees a selection reaches the API: a template that
 * mounted but dropped the model would leave an archive capturing everything while
 * the person watched a box go unticked. The top level picks entries, and a
 * workspace's nested dialog picks its leaves.
 */
describe('backupDialog', () => {
  afterEach(() => vi.restoreAllMocks())

  async function open() {
    const wrapper = mount(BackupDialog, { props: { open: true, state }, global: { stubs } })
    await nextTick()
    return wrapper
  }

  function checkbox(wrapper: Awaited<ReturnType<typeof open>>, index: number) {
    const found = wrapper.findAll('input[type="checkbox"]')[index]
    if (!found)
      throw new Error(`no checkbox at ${index}`)
    return found
  }

  async function create(wrapper: Awaited<ReturnType<typeof open>>): Promise<void> {
    const button = wrapper.findAll('button').find(node => node.text().includes('Create backup'))
    if (!button)
      throw new Error('no Create backup button')
    await button.trigger('click')
    await nextTick()
  }

  it('offers every entry, and omits the selection when nothing was unticked', async () => {
    const spy = vi.spyOn(api, 'createBackup').mockResolvedValue({})
    const wrapper = await open()

    // One checkbox per top-level entry; the leaves only appear in the sub-dialog.
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(4)
    await create(wrapper)

    expect(spy).toHaveBeenCalledWith('', undefined)
  })

  it('sends what is left ticked as the selection', async () => {
    const spy = vi.spyOn(api, 'createBackup').mockResolvedValue({})
    const wrapper = await open()

    // `global:settings`, `global:secrets`, `global:tls`, `workspace:default`.
    await checkbox(wrapper, 1).setValue(false)
    await create(wrapper)

    expect(spy).toHaveBeenCalledWith('', ['global:settings', 'global:tls', 'workspace:default'])
  })

  it('sends only the leaves that stayed ticked in a workspace sub-dialog', async () => {
    const spy = vi.spyOn(api, 'createBackup').mockResolvedValue({})
    const wrapper = await open()

    const choose = wrapper.findAll('button').find(node => node.text().includes('Choose items'))
    if (!choose)
      throw new Error('no Choose items button')
    await choose.trigger('click')
    await nextTick()

    // The sub-dialog appends its three leaves after the four entry checkboxes.
    await checkbox(wrapper, 5).setValue(false)

    const apply = wrapper.findAll('button').find(node => node.text().trim() === 'Apply')
    if (!apply)
      throw new Error('no Apply button')
    await apply.trigger('click')
    await nextTick()
    await create(wrapper)

    // The workspace is captured in part, so its picked leaves travel by id.
    expect(spy).toHaveBeenCalledWith('', ['global:settings', 'global:secrets', 'global:tls', 'workspace:default:settings', 'data:/srv/app/data'])
  })
})
