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
  paths: [{ path: '/srv/app/data', id: 'data:/srv/app/data', origin: 'app:DATA_DIR', included: true, note: null }],
  files: [],
}

/** The dialog body/footer without reka-ui's portal: the mapping is what is under test. */
const stubs = {
  Modal: { template: '<div><slot /><slot name="footer" /></div>' },
}

/**
 * The dialog is what now guarantees a selection reaches the API: a template that
 * mounted but dropped the model would leave an archive capturing everything while
 * the person watched a box go unticked.
 */
describe('backupDialog', () => {
  afterEach(() => vi.restoreAllMocks())

  async function open() {
    const wrapper = mount(BackupDialog, { props: { open: true, state }, global: { stubs } })
    await nextTick()
    return wrapper
  }

  it('offers every item, and omits the selection when nothing was unticked', async () => {
    const spy = vi.spyOn(api, 'createBackup').mockResolvedValue({})
    const wrapper = await open()

    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(4)
    await wrapper.findAll('button').find(node => node.text().includes('Create backup'))!.trigger('click')
    await nextTick()

    expect(spy).toHaveBeenCalledWith('', undefined)
  })

  it('sends the unchecked items as the selection', async () => {
    const spy = vi.spyOn(api, 'createBackup').mockResolvedValue({})
    const wrapper = await open()

    // `config`, `secrets`, `tls`, then the declared path.
    await wrapper.findAll('input[type="checkbox"]')[3]!.setValue(false)
    await wrapper.findAll('button').find(node => node.text().includes('Create backup'))!.trigger('click')
    await nextTick()

    expect(spy).toHaveBeenCalledWith('', ['config', 'secrets', 'tls'])
  })
})
