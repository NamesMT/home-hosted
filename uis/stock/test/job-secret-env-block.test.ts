// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import JobSecretEnvBlock from '../src/components/job/JobSecretEnvBlock.vue'

/**
 * A **job's** secret values: a name, a set marker, and a masked box — never a value.
 *
 * The same screen the server block is, against the job's own write-only route. The panel never sends a
 * value back, so a block that could render one would be the leak the whole feature exists to prevent;
 * what it is built from is `secretEnvSet` (names only) plus `PUT /api/jobs/:id/secrets`.
 *
 * The three facts here are the ones a refactor breaks silently: the declared names are listed, every
 * input is masked and empty, and no box exists for a name the job does not declare — because the
 * declaration is the consent.
 */
function mountBlock(setNames: string[], declared = ['BACKUP_TOKEN'], savedDeclared = declared, jobId = 'nightly-backup') {
  return mount(JobSecretEnvBlock, {
    props: { jobId, declared, savedDeclared, setNames },
  })
}

describe('the job secret environment block', () => {
  it('lists the declared names and marks which have a value', () => {
    const wrapper = mountBlock(['BACKUP_TOKEN'])
    expect(wrapper.text()).toContain('BACKUP_TOKEN')
    expect(wrapper.text()).toMatch(/set/)
    wrapper.unmount()
  })

  it('masks every input and leaves it empty', () => {
    const wrapper = mountBlock([])
    const inputs = wrapper.findAll('input')
    expect(inputs).toHaveLength(1)
    for (const input of inputs) {
      expect(input.attributes('type')).toBe('password')
      expect((input.element as HTMLInputElement).value).toBe('')
    }
    wrapper.unmount()
  })

  it('offers no box for a name the job does not declare', () => {
    // Two declared names, two inputs — the block cannot invent a name, so it cannot write one.
    expect(mountBlock([], ['A', 'B']).findAll('input')).toHaveLength(2)
    // And none at all when the job declares nothing.
    expect(mountBlock([], []).findAll('input')).toHaveLength(0)
  })

  it('sends nothing for a blank box, because blank means "leave it alone"', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const wrapper = mountBlock([])
      const save = wrapper.findAll('button').find(node => node.text().toLowerCase().includes('save'))!
      await save.trigger('click')
      await wrapper.vm.$nextTick()
      expect(fetchSpy, 'a blank box sends nothing').not.toHaveBeenCalled()
      wrapper.unmount()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('writes a typed value through the job\'s own write-only route', async () => {
    const calls: Array<{ url: string, body: string | undefined }> = []
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const wrapper = mountBlock([])
      await wrapper.find('input').setValue('hunter2')
      const save = wrapper.findAll('button').find(node => node.text().toLowerCase().includes('save'))!
      await save.trigger('click')
      await wrapper.vm.$nextTick()
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(calls).toHaveLength(1)
      // The job's route, keyed by its id — not the server one, which takes a server id.
      expect(calls[0]!.url).toContain('/api/jobs/nightly-backup/secrets')
      expect(JSON.parse(calls[0]!.body!)).toEqual({ set: { BACKUP_TOKEN: 'hunter2' } })
      // Cleared the moment it is stored: the value must not sit in the page's model afterwards.
      expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
      wrapper.unmount()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  /**
   * A name typed into the sheet's names box gets a box immediately, marked "needs saving": the route
   * refuses a value for a name the **stored** job does not declare, so the box is inert instead of
   * accepting a secret that would come back as a 400.
   */
  it('gives a newly typed name a box, inert until the job is saved', () => {
    const wrapper = mountBlock([], ['BACKUP_TOKEN', 'NEW_TOKEN'], ['BACKUP_TOKEN'])
    const labels = wrapper.findAll('input').map(input => input.attributes('aria-label'))
    expect(labels).toEqual(['BACKUP_TOKEN', 'NEW_TOKEN'])
    expect(wrapper.text()).toMatch(/needs saving/i)
    expect(wrapper.findAll('input')[1]!.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  /**
   * A value cannot exist before the job does: the store is keyed by the job id. Creating one shows
   * this block, so it says so rather than offering a box that would post to `/api/jobs//secrets`.
   */
  it('refuses to take a value while the job does not exist yet', () => {
    const wrapper = mountBlock([], ['BACKUP_TOKEN'], [], '')
    expect(wrapper.text()).toContain('once the job exists')
    expect(wrapper.find('input').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
