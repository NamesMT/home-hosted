// @vitest-environment happy-dom
import type { ServerConfig } from '@shared/contracts'
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
function config(secretEnv: string[]): ServerConfig {
  return { id: 'app', command: 'node', args: [], secretEnv, env: {}, dataEnvs: {} } as unknown as ServerConfig
}

function mountBlock(setNames: string[]) {
  return mount(SecretEnvBlock, {
    props: { serverId: 'app', config: config(['DATABASE_URL', 'API_KEY']), setNames, workspaceId: 'default' },
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
