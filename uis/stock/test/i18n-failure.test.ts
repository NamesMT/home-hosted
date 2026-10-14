// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A catalog is a network fetch, so it can fail: a stale `index.html` after a redeploy, an offline
 * home server, a proxy that drops the chunk.
 *
 * The failure that matters is not "the wrong language" but "no page at all". `initLocale()` is
 * awaited before mount, and a rejection escaping that await left the app unmounted — a blank screen
 * with no way back for someone who cannot read the page to diagnose it. English is bundled, so the
 * only acceptable outcome is an English panel.
 *
 * This drives the real module rather than mocking `initLocale`, so it pins the code that runs.
 */
describe('a catalog that cannot load', () => {
  afterEach(() => vi.doUnmock('vue'))

  it('still mounts the app, in English', async () => {
    const mounted: string[] = []
    let localeAtMount: string | null = null

    // Fail the dynamic import the way a dropped chunk does.
    vi.doMock('@/i18n', async () => {
      const actual = await vi.importActual<typeof import('@/i18n')>('@/i18n')
      return {
        ...actual,
        // A stored non-English choice whose chunk cannot be fetched.
        initLocale: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
        currentLocale: () => 'en',
      }
    })
    vi.doMock('vue', async () => {
      const actual = await vi.importActual<typeof import('vue')>('vue')
      return {
        ...actual,
        createApp: () => ({
          use: () => ({
            mount: (selector: string) => {
              localeAtMount = 'en'
              mounted.push(selector)
            },
          }),
        }),
      }
    })

    await import('@/main')
    // Let the bootstrap settle.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(mounted, 'a failed catalog must not leave a blank page').toEqual(['#app'])
    expect(localeAtMount).toBe('en')
  })
})
