import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPassword, fetchSettings } from '../src/lib/api'

/**
 * Every failure surfaces the panel's own message, not a bare status.
 *
 * `request` reads `message` first and falls back to a bare `error` field. This UI's copy lacked that
 * fallback while `stock`'s had it, so the same failed call produced two different strings depending on
 * which UI you were in — the kind of drift that comes from a copied helper. Both reads are pinned here
 * so the pair cannot diverge silently again.
 */
afterEach(() => {
  vi.unstubAllGlobals()
})

function failing(body: unknown, status = 400): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })))
}

describe('request error messages', () => {
  it('uses the envelope message when there is one', async () => {
    failing({ message: 'the control port is in use', code: 'PORT_BUSY', detail: null })
    await expect(fetchSettings()).rejects.toThrow('the control port is in use')
  })

  it('falls back to a bare `error` field, which the other UI already read', async () => {
    failing({ error: 'only this machine may answer a challenge' }, 403)
    await expect(fetchSettings()).rejects.toThrow('only this machine may answer a challenge')
  })

  it('falls back to the status when the body says nothing usable', async () => {
    failing({ detail: 'no message here' }, 400)
    await expect(fetchSettings()).rejects.toThrow('request failed with 400')
    failing('not json at all', 500)
    await expect(clearPassword()).rejects.toThrow('request failed with 500')
  })

  it('throws AuthRequiredError on the 401 the SPA routes on', async () => {
    failing({ message: 'authentication required', code: 'AUTH_REQUIRED', detail: null }, 401)
    await expect(fetchSettings()).rejects.toThrow('authentication required')
  })
})
