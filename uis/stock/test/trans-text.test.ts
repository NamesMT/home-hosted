// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import TransText from '@/components/ui/TransText.vue'
import { __resetLocaleForTests, setLocale } from '@/i18n'

/**
 * A sentence that carries markup keeps its whole self in the catalog, and `TransText` is what puts
 * the markup back. Two things about it are easy to get wrong and silent when wrong:
 *
 * 1. A placeholder with no slot must render the plain value, not the literal `{name}`.
 * 2. A placeholder that *does* have a slot must not be substituted first — the previous
 *    implementation passed every param to `t()`, so a caller that supplied both a slot and a param
 *    of the same name lost its markup and showed the plain value.
 */
function render(props: { k: string, params?: Record<string, unknown> }, slots?: Record<string, () => unknown>) {
  return mount(TransText, { props, slots })
}

describe('transText', () => {
  afterEach(() => __resetLocaleForTests())

  it('fills a placeholder from a param when no slot is given', () => {
    const html = render({ k: 'login.sessionNote', params: { days: 7 } }).html()
    expect(html).toContain('7 days')
    expect(html).not.toContain('{days}')
  })

  it('renders markup from a slot', () => {
    const html = render(
      { k: 'login.noPasswordWarning' },
      { command: () => h('code', {}, 'pnpm run auth:set-password') },
    ).html()
    expect(html).toContain('<code>pnpm run auth:set-password</code>')
    expect(html).not.toContain('{command}')
  })

  it('prefers the slot when a param of the same name is also passed', () => {
    const html = render(
      { k: 'login.defaultPasswordWarning', params: { password: 'PLAIN' } },
      { password: () => h('code', {}, 'MARKED') },
    ).html()
    expect(html, 'the markup must win over a same-named param').toContain('MARKED')
    expect(html).not.toContain('PLAIN')
  })

  it('renders a placeholder in the reader’s language', async () => {
    await setLocale('ru')
    const html = render({ k: 'login.sessionNote', params: { days: 30 } }).html()
    expect(html).toContain('30')
    expect(html).not.toMatch(/\{\w+\}/)
  })
})
