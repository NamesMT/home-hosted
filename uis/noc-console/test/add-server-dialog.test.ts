// @vitest-environment happy-dom
import type { ServerDefaults } from '@shared/contracts'
import { serverCreateSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { type } from 'arktype'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * The add dialog's payload, end to end.
 *
 * The extraction moved the form's fields into a shared component, so the risk is not that a
 * helper computes the wrong thing — that is pinned in `server-form.test.ts` — but that the
 * dialog's *wiring* stopped feeding it: a field rendered from the catalogue that never
 * reaches `form`, or a payload that no longer validates. This drives the real dialog and
 * reads the body it hands the control plane.
 */

const created: unknown[] = []
const defaults = ref<ServerDefaults | null>(null)

vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    defaults,
    lastError: ref(null),
    createServer: async (payload: unknown) => { created.push(payload) },
  }),
}))
vi.mock('@/composables/useUi', () => ({
  flash: () => {},
  selectedId: ref(null),
}))

const Dialog = (await import('../src/components/AddServerDialog.vue')).default

function mountDialog() {
  return mount(Dialog, { props: { open: true } })
}

/** The input a label names, scoped because `command` appears twice in the sheet. */
function inputFor(wrapper: ReturnType<typeof mountDialog>, label: string) {
  const field = wrapper.findAll('label').find(node => node.find('.field__label').exists() && node.text().includes(label))
  if (!field)
    throw new Error(`no field labelled “${label}”`)
  return field.find('input, textarea, select')
}

beforeEach(() => {
  created.length = 0
  defaults.value = null
})

describe('the add-server dialog', () => {
  it('creates a server from what the shared form collected', async () => {
    const wrapper = mountDialog()
    await inputFor(wrapper, 'id').setValue('web')
    await inputFor(wrapper, 'command').setValue('node')
    await inputFor(wrapper, 'args — space separated').setValue('-p {port}')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(created).toHaveLength(1))

    const payload = created[0] as Record<string, unknown>
    expect(payload.id).toBe('web')
    expect(payload.command).toBe('node')
    // This variant gives `args` a single line, so the whole line is one argument — the
    // page variant is the one that splits them one per line.
    expect(payload.args).toEqual(['-p {port}'])
    wrapper.unmount()
  })

  it('leaves an inherited value out of the body, so the entry keeps following the defaults', async () => {
    defaults.value = { enabled: true, autostart: false, bind: 'lan', onPortConflict: 'block', logBufferLines: 500 } as ServerDefaults
    const wrapper = mountDialog()
    await inputFor(wrapper, 'id').setValue('web')
    await inputFor(wrapper, 'command').setValue('node')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(created).toHaveLength(1))

    const payload = created[0] as Record<string, unknown>
    // The panel's own `lan` is what the field starts on, so nothing is written about it.
    expect(payload.bind).toBeUndefined()
    expect(payload.autostart).toBeUndefined()
    expect(payload.enabled).toBeUndefined()
    expect(payload.logBufferLines).toBeUndefined()
    wrapper.unmount()
  })

  it('sends only what the person decided when the panel defaults are the same', async () => {
    const wrapper = mountDialog()
    await inputFor(wrapper, 'id').setValue('web')
    await inputFor(wrapper, 'command').setValue('node')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(created).toHaveLength(1))

    const payload = created[0] as Record<string, unknown>
    // A schema-valid body, which is the contract the panel will accept.
    expect(serverCreateSchema(payload) instanceof type.errors).toBe(false)
    // Only what was decided. Every other field equals what the entry would inherit — a blank
    // `cwd` is the inherited `.`, and the empty `args`/`env`/`dataEnvs` maps are the
    // inherited empties — so all of them drop out of the diff. Writing them would freeze
    // today's defaults into the entry instead of leaving them inherited.
    expect(Object.keys(payload).sort()).toEqual(['command', 'id'])
    wrapper.unmount()
  })

  it('refuses a body the schema would, and says why', async () => {
    const wrapper = mountDialog()
    await inputFor(wrapper, 'command').setValue('node')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.text()).toContain('id must start with a lowercase letter or digit')
    expect(created).toHaveLength(0)
    wrapper.unmount()
  })

  it('carries the bootstrap only when its toggle is on', async () => {
    const wrapper = mountDialog()
    await inputFor(wrapper, 'id').setValue('web')
    await inputFor(wrapper, 'command').setValue('node')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(created).toHaveLength(1))
    expect((created[0] as Record<string, unknown>).bootstrap).toBeUndefined()

    // A successful create resets the form — as the dialog has always done — so the second
    // attempt has to be filled in again.
    await inputFor(wrapper, 'id').setValue('worker')
    await inputFor(wrapper, 'command').setValue('node')
    const toggle = wrapper.findAll('label').find(node => node.text().includes('run before the first start'))!.find('input')
    await toggle.setValue(true)
    // The bootstrap `command` and `timeout` are the second fields of those names.
    const commandFields = wrapper.findAll('label').filter(node => node.text().includes('command'))
    await commandFields[1]!.find('input').setValue('./install.sh')
    // Scoped to the bootstrap group: the health pane also has a `timeout (ms)` box, and a
    // form-wide search silently fills in the wrong one.
    const bootstrap = wrapper.findAll('.group').find(node => node.text().includes('once per up session'))!
    const timeout = bootstrap.findAll('label').find(node => node.find('.field__label').text() === 'timeout (ms)')!
    await timeout.find('input').setValue('5000')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(created).toHaveLength(2))

    expect((created[1] as Record<string, unknown>).id).toBe('worker')
    expect((created[1] as Record<string, unknown>).bootstrap).toEqual({
      command: './install.sh',
      args: [],
      env: {},
      timeoutMs: 5000,
      runOnce: true,
    })
    wrapper.unmount()
  })
})
