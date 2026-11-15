// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SecretEnvBlock from '../src/components/server/SecretEnvBlock.vue'

/**
 * The secret block shows a **name**, a set marker, and a masked box — never a value.
 *
 * This is the one screen whose whole job is to prove the values are not here. A value never enters
 * the config, so the block is built from `secretEnvSet` (names only) plus the write-only route; a
 * block that could render one would be the leak the feature exists to prevent.
 *
 * The three facts asserted here are the ones a refactor would break silently: the names are listed,
 * every input is masked and empty, and no box exists for a name the entry does not declare — because
 * declaration is the consent, so an undeclared name cannot be written through this screen either.
 */
/**
 * Mount with the **draft** names the caller passes.
 *
 * `declared` is what the form currently lists and `savedDeclared` is what the stored config has; a
 * name in the first but not the second is typed-but-unsaved, and its box is disabled. The default
 * here is the saved config, so every existing assertion keeps its meaning.
 */
function mountBlock(setNames: string[], declared = ['DATABASE_URL', 'API_KEY'], savedDeclared = declared) {
  return mount(SecretEnvBlock, {
    props: { serverId: 'app', declared, savedDeclared, setNames, workspaceId: 'default' },
  })
}

describe('the secret environment block', () => {
  it('lists the declared names', () => {
    const wrapper = mountBlock([])
    expect(wrapper.text()).toContain('DATABASE_URL')
    expect(wrapper.text()).toContain('API_KEY')
    wrapper.unmount()
  })

  it('marks a set name without showing what it is set to', () => {
    const wrapper = mountBlock(['DATABASE_URL'])
    // One name has a value, so exactly one marker is the "set" one.
    const text = wrapper.text()
    expect(text).toMatch(/set/)
    expect(text).toContain('not set')
    // Every input is masked and empty: the panel never sent a value to fill one with.
    for (const input of wrapper.findAll('input')) {
      expect(input.attributes('type')).toBe('password')
      expect((input.element as HTMLInputElement).value).toBe('')
    }
    wrapper.unmount()
  })

  it('offers no box for a name the entry does not declare', () => {
    // Two declared names, two inputs — the block cannot invent a name, so it cannot write one.
    expect(mountBlock([]).findAll('input')).toHaveLength(2)
  })

  it('sends a value only when the person typed one', async () => {
    // A blank box is "leave it alone", never "store empty": `save` returns without a request.
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
})

/**
 * The two defects this block was rebuilt for.
 *
 * Both were reported from the running UI: a name typed into the form did not get a box until the
 * config was saved and the page reopened, and setting one secret meant typing in two places far
 * apart. The first is reactivity (`declared` must be the form draft, not the saved config), and the
 * second is layout, which `test/shared/secret-env-layout.test.ts` pins.
 */
describe('a name typed into the form, not yet saved', () => {
  it('gets a box as soon as it is declared, with no save', () => {
    // One saved name, and the draft has grown a second one — the regression was the box not existing.
    const wrapper = mountBlock([], ['DATABASE_URL', 'NEW_TOKEN'], ['DATABASE_URL'])
    const labels = wrapper.findAll('input').map(input => input.attributes('aria-label'))
    expect(labels).toEqual(['DATABASE_URL', 'NEW_TOKEN'])
    wrapper.unmount()
  })

  it('marks it as needing a save, and refuses to take a value yet', () => {
    const wrapper = mountBlock([], ['DATABASE_URL', 'NEW_TOKEN'], ['DATABASE_URL'])
    expect(wrapper.text()).toMatch(/needs saving/i)
    // The route refuses a value for a name the **stored** entry does not declare, so the box says so
    // rather than letting a person type a secret and be answered with a 400.
    const unsavedBox = wrapper.findAll('input')[1]!
    expect(unsavedBox.attributes('disabled')).toBeDefined()
    // The badge carries the instruction, and the box refuses input rather than letting a person type
    // a secret that the route would then answer with a 400.
    expect(wrapper.text()).toMatch(/needs saving/i)
    wrapper.unmount()
  })

  it('loses a box when the name is removed from the form', () => {
    const wrapper = mountBlock([], ['DATABASE_URL'], ['DATABASE_URL'])
    return wrapper.setProps({ declared: [] }).then(() => {
      expect(wrapper.findAll('input')).toHaveLength(0)
      wrapper.unmount()
    })
  })
})
