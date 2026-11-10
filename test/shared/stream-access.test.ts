import type { SessionView } from '#src/shared/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthRequiredError, backupWarnings, LocalOnlyError, request } from '#src/shared/api-client'
import { streamRecovery } from '#src/shared/stream-access'

/**
 * After the browser gives up on an event stream, the UIs ask why.
 *
 * The panel now ends a stream whose credential stopped being valid, and with no password in force a
 * caller that is not the panel's machine gets `AUTH_DISABLED_REMOTE` (or `AUTH_UNARMED`). Both UIs
 * decided only from the session, which says `authRequired: false` in that case — so they reconnected
 * forever, each attempt another 401.
 */
function session(overrides: Partial<SessionView> = {}): SessionView {
  return { authenticated: false, authRequired: false, passwordSet: false, usingDefaultPassword: false, defaultPassword: null, sessionTtlMs: 1, ...overrides }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamRecovery', () => {
  it('sends a signed-out session to the login view', async () => {
    expect(await streamRecovery(async () => session({ authRequired: true }), async () => {})).toEqual({ action: 'login' })
  })

  it('stops retrying on a refusal signing in cannot fix, with the panel\'s message', async () => {
    const refused = new LocalOnlyError('set a password on the machine', 'AUTH_DISABLED_REMOTE')
    expect(await streamRecovery(async () => session(), async () => {
      throw refused
    })).toEqual({ action: 'refused', message: 'set a password on the machine' })
  })

  it('goes to login when the probe finds the session gone', async () => {
    expect(await streamRecovery(async () => session(), async () => {
      throw new AuthRequiredError()
    })).toEqual({ action: 'login' })
  })

  it('reconnects while the panel is unreachable or answers', async () => {
    expect(await streamRecovery(async () => {
      throw new Error('offline')
    }, async () => {})).toEqual({ action: 'retry' })
    expect(await streamRecovery(async () => session(), async () => {})).toEqual({ action: 'retry' })
  })
})

describe('request', () => {
  it.each(['AUTH_DISABLED_REMOTE', 'AUTH_UNARMED'])('throws LocalOnlyError for a %s 401, with the panel\'s message', async (code) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'only this machine', code }), { status: 401 }))
    const error = await request('/api/state').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LocalOnlyError)
    expect((error as LocalOnlyError).message).toBe('only this machine')
    expect((error as LocalOnlyError).code).toBe(code)
  })
})

describe('backupWarnings', () => {
  it('reads the optional warnings a created backup carries', () => {
    expect(backupWarnings({ file: {}, files: [], warnings: ['data/ held no files'] })).toEqual(['data/ held no files'])
    expect(backupWarnings({ file: {}, files: [] })).toEqual([])
    expect(backupWarnings(null)).toEqual([])
  })
})
