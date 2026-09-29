// @vitest-environment happy-dom
import type { BackupFile, RestorePlan } from '@shared/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RestoreDialog from '../src/components/settings/RestoreDialog.vue'
import * as api from '../src/lib/api'

const archive: BackupFile = { name: 'backup-1.zip', sizeBytes: 100, createdAt: 1, encrypted: false }

const plan: RestorePlan = {
  dryRun: true,
  encrypted: false,
  needsPassword: false,
  items: [
    { id: 'global:settings', label: 'global/settings.json', kind: 'settings', restorable: true, selected: true, note: null },
    { id: 'data:/srv/app', label: '/srv/app', kind: 'data', restorable: true, selected: true, note: 'restored from /old/app' },
  ],
  applied: ['global/settings.json', '/srv/app'],
  skipped: [],
  restartRequired: false,
  reloaded: true,
}

const stubs = {
  Modal: { template: '<div><slot /><slot name="footer" /></div>' },
}

function button(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll('button').find(node => node.text().includes(label))!
}

/**
 * The plan, the password prompt and the selection used to live inline in Settings,
 * where a completed restore was easy to miss. They are now the dialog's own state,
 * so the wiring between them is what this guards.
 */
describe('restoreDialog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('plans on open and applies only what stayed ticked', async () => {
    const spy = vi.spyOn(api, 'restoreStoredBackup').mockResolvedValue(plan)
    const wrapper = mount(RestoreDialog, {
      props: { open: true, files: [archive], initial: { kind: 'stored', name: archive.name } },
      global: { stubs },
    })
    await flushPromises()

    expect(spy).toHaveBeenCalledWith(archive.name, false, {})
    expect(wrapper.text()).toContain('Nothing has changed yet')
    expect(wrapper.text()).toContain('Choose what to restore — 2 of 2 selected')

    spy.mockResolvedValue({ ...plan, dryRun: false })
    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(false)
    await button(wrapper, 'Apply this restore').trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenLastCalledWith(archive.name, true, { include: ['global:settings'] })
    expect(wrapper.emitted('applied')?.[0]).toEqual(['Restored 2 item(s) — the restored servers are live, autostart entries starting.'])
  })

  it('asks for the password instead of offering the selection', async () => {
    const spy = vi.spyOn(api, 'restoreStoredBackup')
      .mockResolvedValueOnce({ ...plan, needsPassword: true, items: [], applied: [], error: 'this backup is password-protected' })
      .mockResolvedValueOnce(plan)
    const wrapper = mount(RestoreDialog, {
      props: { open: true, files: [archive], initial: { kind: 'stored', name: archive.name } },
      global: { stubs },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('this backup is password-protected')
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0)
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)

    await wrapper.find('input[type="password"]').setValue('hunter2')
    await button(wrapper, 'Check again with the password').trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenLastCalledWith(archive.name, false, { password: 'hunter2' })
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(2)
  })
})
