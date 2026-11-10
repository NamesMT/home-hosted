// @vitest-environment happy-dom
import type { ServerConfig } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * The config page, end to end: what it hands the control plane when Save is pressed.
 *
 * It read every box with `Number(...)`, so a cleared `grace (ms)` saved `0` — an instant SIGKILL on
 * the next stop — and it diffed against live state, refilling (and wiping) a half-typed form
 * whenever another client saved the same entry. It also could not edit the `dump`/`load` hooks
 * the stock editor offers.
 */

const saved: unknown[] = []
const live = ref<ServerConfig>(config())

function config(overrides: Record<string, unknown> = {}): ServerConfig {
  return serverSchema.assert({ id: 'web', command: 'node', port: 4000, stop: { graceMs: 8000 }, ...overrides }) as ServerConfig
}

vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: ref('default'),
    defaults: ref(null),
    serverById: () => ({ id: 'web', status: 'stopped', bindHost: '127.0.0.1', config: live.value }),
    saveConfig: async (_id: string, patch: unknown) => {
      saved.push(patch)
      return { ok: true as const, value: undefined }
    },
    removeServer: async () => ({ ok: true as const, value: undefined }),
  }),
}))
vi.mock('@/composables/useUi', () => ({
  flash: () => {},
  selectedId: ref(null),
  configChangesOpen: ref(false),
}))
vi.mock('@/router', () => ({ workspacePath: () => '/' }))

const View = (await import('../src/views/ServerConfigView.vue')).default

async function mountView() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  const wrapper = mount(View, { props: { id: 'web' }, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

function inputFor(wrapper: Awaited<ReturnType<typeof mountView>>, label: string, within?: string) {
  const scope = within === undefined ? wrapper : wrapper.findAll('.pane').find(pane => pane.find('.pane__title').text() === within)!
  const field = scope.findAll('label').find(node => node.find('.field__label').exists() && node.find('.field__label').text() === label)
  if (!field)
    throw new Error(`no field labelled “${label}”`)
  return field.find('input, textarea, select')
}

beforeEach(() => {
  saved.length = 0
  live.value = config()
})

describe('the server config page', () => {
  it('treats a cleared number box as "unchanged", never as 0', async () => {
    const wrapper = await mountView()
    await inputFor(wrapper, 'grace (ms)').setValue('')
    await inputFor(wrapper, 'max retries').setValue('')
    await inputFor(wrapper, 'label').setValue('Web')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saved).toEqual([{ label: 'Web' }])
    wrapper.unmount()
  })

  it('keeps typed edits when the entry changes elsewhere, and says so', async () => {
    const wrapper = await mountView()
    await inputFor(wrapper, 'label').setValue('mine')

    live.value = config({ command: 'bun' })
    // `serverById` is read through a computed; poke the page with a re-render of the prop.
    await wrapper.setProps({ id: 'web' })
    await flushPromises()

    expect((inputFor(wrapper, 'label').element as HTMLInputElement).value).toBe('mine')
    expect(wrapper.text()).toContain('changed elsewhere')

    await wrapper.find('form').trigger('submit')
    await flushPromises()
    // Only this page's own edit travels: the other client's `command` is not written back.
    expect(saved).toEqual([{ label: 'mine' }])
    wrapper.unmount()
  })

  it('edits the dump hook, its timeout in seconds', async () => {
    const wrapper = await mountView()
    const pane = wrapper.findAll('.pane').find(node => node.find('.pane__title').text() === 'backup dump')!
    await pane.find('.pane__head input[type="checkbox"]').setValue(true)
    await inputFor(wrapper, 'command', 'backup dump').setValue('mongodump')
    await inputFor(wrapper, 'timeout (s)', 'backup dump').setValue('30')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saved).toEqual([{ dump: { command: 'mongodump', args: [], env: {}, timeoutMs: 30_000 } }])
    wrapper.unmount()
  })
})
