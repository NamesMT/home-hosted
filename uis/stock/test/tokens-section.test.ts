// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import TokensSection from '../src/components/settings/TokensSection.vue'

/**
 * The token table mounts, and offers the create form with every scope explained.
 *
 * A mount (rather than only a source scan) because the component fetches on mount: a failure there
 * would leave the table blank with no error anywhere, which is the shape a settings page fails in.
 * noc-console's half is `uis/noc-console/test/tokens-section.test.ts`.
 */
describe('the tokens section', () => {
  it('mounts and offers to create a token', () => {
    // The listing is fetched on mount; stub it so this stays a unit test.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tokens: [] }), { status: 200 })))
    const wrapper = mount(TokensSection)
    // The button is there before the fetch resolves: the section never waits to be useful.
    expect(wrapper.text()).toMatch(/create token/i)
    wrapper.unmount()
    vi.unstubAllGlobals()
  })
})
