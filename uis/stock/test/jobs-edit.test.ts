// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * Editing a job from the Jobs page.
 *
 * The page only ever *created* one. The API could edit it the whole time — `api.updateJob` existed
 * and the row's own enable/disable toggle used it — but there was no field to change a command, a
 * schedule, a timeout or a `cwd` with, so a typo in a nightly backup meant deleting the job and
 * declaring it again.
 *
 * Two facts are about the form rather than the wiring, and both are silent when broken:
 *
 *  1. **`id` is not editable.** It names the run's log file, its history events and its stored secret
 *     values; a changed id orphans all three. The box is disabled in edit mode, and the patch the
 *     sheet sends carries no `id` at all.
 *  2. **The form is filled from the stored job**, not from the create-side defaults. A sheet that
 *     opened blank would reset the `cwd`, the timeout and `enabled` on the first save — the person
 *     would never see the values they had, and would only find out when the job next ran.
 */
const sent: Array<{ method: string, url: string, body: Record<string, unknown> | null }> = []

const JOB = {
  id: 'nightly-backup',
  label: 'Nightly backup',
  enabled: false,
  command: './scripts/backup.sh',
  args: ['--full', '--keep=14'],
  schedule: '0 3 * * *',
  running: false,
  cwd: '/srv/app',
  timeoutMs: 900_000,
  secretEnv: ['BACKUP_TOKEN'],
  secretEnvSet: ['BACKUP_TOKEN'],
  // The two instants the row renders as text, pinned to the mocked tick below: one run finished two
  // hours ago, the next is in three. A fixture without them left both cells untested.
  lastRunAt: 1_700_000_000_000 - 2 * 3_600_000,
  nextRunAt: 1_700_000_000_000 + 3 * 3_600_000,
  lastExitCode: 0,
}

vi.mock('@/lib/api', async (importOriginal) => {
  // Spread the real module: the view does `import * as api`, and a plain object has no module
  // namespace, which Vue's ref-unwrapping rejects.
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listJobs: async () => ({ jobs: [JOB] }),
    updateJob: async (id: string, patch: Record<string, unknown>) => {
      sent.push({ method: 'PATCH', url: `/api/jobs/${id}`, body: patch })
      return { job: JOB }
    },
    createJob: async (input: Record<string, unknown>) => {
      sent.push({ method: 'POST', url: '/api/jobs', body: input })
      return { job: JOB }
    },
  }
})

vi.mock('@/composables/useControlPlane', () => ({
  useControlPlane: () => ({ now: { value: 1_700_000_000_000 } }),
}))

/**
 * Open the row's edit sheet.
 *
 * The trigger is in the wrapper (the table is not portalled); the sheet it opens is in `document.body`.
 */
async function openEdit(wrapper: Awaited<ReturnType<typeof mountJobs>>): Promise<void> {
  const trigger = wrapper.findAll('button').find(node => node.text() === 'Edit')
  if (!trigger)
    throw new Error('the row has no edit control')
  await trigger.trigger('click')
  await wrapper.vm.$nextTick()
}

async function mountJobs() {
  const View = (await import('../src/views/JobsView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/w/:workspaceId/jobs', component: { template: '<div />' } }],
  })
  await router.push('/w/default/jobs')
  await router.isReady()
  return mount(View, { global: { plugins: [router] } })
}

/**
 * The sheet's own DOM, which is **not** under the wrapper.
 *
 * `Modal` portals its content to `document.body` (reka-ui's `DialogPortal`), so a `wrapper.findAll`
 * sees the table and nothing else — the same shape every popover test in this suite has to handle.
 */
function inBody<T extends Element>(selector: string): T[] {
  return [...document.body.querySelectorAll<T>(selector)]
}

function bodyButton(label: string): HTMLButtonElement | undefined {
  return inBody<HTMLButtonElement>('button').find(node => node.textContent?.trim() === label)
}

/**
 * The input a field renders, found by its **label text**.
 *
 * `TextField`/`NumberField` draw `<label for>` and `<input id>` as siblings, not a wrapping label, so
 * the lookup goes through `for` rather than `querySelector` inside the label.
 */
function field(label: string): HTMLInputElement {
  const node = inBody<HTMLLabelElement>('label').find(entry => entry.textContent?.trim() === label)
  const id = node?.htmlFor
  const input = id === undefined || id === '' ? undefined : document.getElementById(id)
  if (!(input instanceof HTMLInputElement))
    throw new Error(`no field labelled “${label}”`)
  return input
}

describe('the Jobs page edits a job', () => {
  it('opens the sheet on the stored job, with every field filled from it', async () => {
    sent.length = 0
    const wrapper = await mountJobs()
    await wrapper.vm.$nextTick()

    await openEdit(wrapper)

    expect(field('Job id').value).toBe('nightly-backup')
    expect(field('Command').value).toBe('./scripts/backup.sh')
    expect(field('Schedule').value).toBe('0 3 * * *')
    // The three the create form used to default: a sheet opened blank would rewrite them.
    expect(field('Working directory').value).toBe('/srv/app')
    expect(field('Timeout (s)').value).toBe('900')
    wrapper.unmount()
  })

  it('cannot edit the id, which names the log, the history and the secrets', async () => {
    sent.length = 0
    const wrapper = await mountJobs()
    await wrapper.vm.$nextTick()

    await openEdit(wrapper)

    expect(field('Job id').disabled, 'the id box is disabled in edit mode').toBe(true)
    wrapper.unmount()
  })

  it('sends a patch without an id, and with the values the person saw', async () => {
    sent.length = 0
    const wrapper = await mountJobs()
    await wrapper.vm.$nextTick()

    await openEdit(wrapper)

    const schedule = field('Schedule')
    schedule.value = '30 4 * * *'
    schedule.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()

    const save = bodyButton('Save')
    expect(save, 'the sheet offers Save in edit mode').toBeDefined()
    save!.click()
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))

    const patch = sent.find(entry => entry.method === 'PATCH')
    expect(patch, 'the save reached the API').toBeDefined()
    expect(patch!.url).toBe('/api/jobs/nightly-backup')
    // No `id`: the route keys on it, and a changed one would orphan the job's own state.
    expect(patch!.body).not.toHaveProperty('id')
    expect(patch!.body).toMatchObject({
      schedule: '30 4 * * *',
      command: './scripts/backup.sh',
      args: ['--full', '--keep=14'],
      cwd: '/srv/app',
      timeoutMs: 900_000,
      // Untouched is still sent: the panel's patch is whole-field, and a field left out is a field
      // that keeps whatever it had — which is what the form showed, so sending it is honest.
      enabled: false,
    })
    wrapper.unmount()
  })

  /**
   * The create sheet's submit is usable with valid fields.
   *
   * It was `:loading="busy === 'new' || busy === editingId"`, and in create mode `editingId` is `null`
   * while `busy` is `null` too — so `null === null` held and the button rendered **permanently
   * loading**, disabled with its spinner turning. A sheet nobody could submit, with no error to
   * explain it, on the one flow that had always worked.
   */
  it('can submit the create sheet once its required fields are filled', async () => {
    sent.length = 0
    const wrapper = await mountJobs()
    await wrapper.vm.$nextTick()

    const create = wrapper.findAll('button').find(node => node.text() === 'New job')
    expect(create, 'the page offers a create action').toBeDefined()
    await create!.trigger('click')
    await wrapper.vm.$nextTick()

    const submit = (): HTMLButtonElement | undefined => inBody<HTMLButtonElement>('button').find(node => node.textContent?.trim() === 'New job')
    // An empty sheet cannot submit — that is `canSubmit`, not the bug.
    expect(submit()?.disabled, 'an empty create sheet must not submit').toBe(true)

    field('Job id').value = 'nightly-backup'
    field('Job id').dispatchEvent(new Event('input'))
    field('Command').value = '/bin/echo'
    field('Command').dispatchEvent(new Event('input'))
    field('Schedule').value = '0 3 * * *'
    field('Schedule').dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()

    expect(submit()?.getAttribute('aria-busy'), 'a filled sheet must not render as loading').toBeNull()
    expect(submit()?.disabled, 'a filled create sheet must submit').toBe(false)
    wrapper.unmount()
  })

  /**
   * The row's **Last** column says how long ago the previous run finished.
   *
   * It went through `relativeFrom`, which is the countdown formatter the **Next** column needs: it
   * clamps a negative delta to zero, so a past instant renders `now`. Every row read `now`
   * regardless of when it actually ran — a column that cannot be wrong per row because it is wrong
   * for all of them. Measured in the browser against a run 7091 s old, and reproduced here with a
   * run two hours before the shell's tick.
   */
  it('puts the previous run in the past, not at "now"', async () => {
    const wrapper = await mountJobs()
    await wrapper.vm.$nextTick()

    // The "Next" column is a future instant and must keep its countdown; "Last" is a past one.
    const row = wrapper.findAll('tbody tr')[0]
    const cells = row?.findAll('td').map(cell => cell.text().replace(/\s+/g, ' ').trim()) ?? []
    const last = cells[3] ?? ''

    expect(last, 'a two-hour-old run is not "now"').not.toMatch(/\bnow\b/)
    expect(last, 'it reads as an elapsed time').toMatch(/2h ago/)
    expect(cells[2], 'the next run keeps its countdown').toMatch(/^in /)
    wrapper.unmount()
  })
})
