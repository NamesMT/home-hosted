// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

/**
 * The job sheet, mounted: the secret **value** boxes sit directly under the names that declare them.
 *
 * The layout anchors the slot (`JOB_FORM_LAYOUT[].slots`), and this asserts the position, because the
 * failure is positional and silent: rendered as an ordinary sibling section the block lands after the
 * whole form, which is the 1897 px defect the server form's anchor exists to prevent. A test that only
 * read the catalogue would pass with the renderer ignoring the anchor.
 *
 * The sheet is mounted with a stand-in for the secret block — the block itself has its own test and a
 * masked input per name, and what is under test here is *where* the entry point's markup lands.
 */
async function mountSheet() {
  const JobSheet = (await import('../src/components/JobSheet.vue')).default
  const wrapper = mount(JobSheet, {
    props: {
      open: true,
      job: {
        id: 'nightly-backup',
        label: 'Nightly backup',
        enabled: true,
        command: './backup.sh',
        args: ['--full'],
        schedule: '0 3 * * *',
        running: false,
        secretEnv: ['BACKUP_TOKEN'],
        secretEnvSet: [],
      },
    },
    slots: { 'secret-values': '<div class="secret-values-slot" />' },
  })
  await nextTick()
  return wrapper
}

describe('the job sheet', () => {
  it('draws the anchored secret-values slot immediately after the names field', async () => {
    const wrapper = await mountSheet()

    const names = wrapper.findAll('label').find(node => node.text().startsWith('secret env names'))
    expect(names, 'the names field must be rendered').toBeDefined()
    const slot = wrapper.find('.secret-values-slot')
    expect(slot.exists(), 'the slot must be rendered').toBe(true)

    // The slot shares the group's grid with the field it follows, and sits immediately after it.
    const grid = names!.element.parentElement!
    expect(slot.element.parentElement).toBe(grid)
    expect([...grid.children].indexOf(names!.element) + 1).toBe([...grid.children].indexOf(slot.element))

    // And it is inside the secret-environment group, not after the form's last block.
    const group = wrapper.findAll('.group').find(node => node.find('.group__title').text() === 'secret environment')!
    expect(group.element.contains(slot.element), 'the slot belongs in the names’ own group').toBe(true)

    wrapper.unmount()
  })

  it('shows the id read-only when editing, with the reason', async () => {
    const wrapper = await mountSheet()
    const id = wrapper.findAll('label').find(node => node.text().startsWith('id'))!.find('input')
    expect((id.element as HTMLInputElement).value).toBe('nightly-backup')
    expect(id.attributes('disabled'), 'the id cannot be changed').toBeDefined()
    expect(wrapper.text()).toContain('cannot be changed')
    wrapper.unmount()
  })

  it('asks for an id only when creating one', async () => {
    const wrapper = await mountSheet()
    await wrapper.setProps({ job: null })
    await nextTick()
    const id = wrapper.findAll('label').find(node => node.text().startsWith('id'))!.find('input')
    expect(id.attributes('disabled'), 'a new job needs an id typed in').toBeUndefined()
    expect((id.element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })
})
