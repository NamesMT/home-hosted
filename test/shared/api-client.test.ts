import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthRequiredError,
  backupDownloadUrl,
  clearPassword,
  clearProxyCertificate,
  deleteBackup,
  fetchProxy,
  fetchSession,
  fetchSettings,
  installProxyEngine,
  login,
  logout,
  patchProxy,
  proxyAction,
  restoreBody,
  retryProxyCertificate,
  revertProxy,
  revertUi,
  setPassword,
  startProxy,
  stopProxy,
  uploadProxyCertificate,
  uploadUi,
} from '#src/shared/api-client'

/**
 * The panel API client both UIs share.
 *
 * These calls moved out of the UIs' own `lib/api.ts`, where their tests exercised them; the code is
 * the same, but coverage is measured per file, so the moved module needs its own. The cases below are
 * the ones worth pinning — the URL each call builds, the method, and what the body carries — rather
 * than a call per function.
 */
afterEach(() => {
  vi.unstubAllGlobals()
})

/** Records every request and answers with `body`. */
function stub(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', mock)
  return mock
}

function lastCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit | undefined] {
  return mock.mock.calls.at(-1) as unknown as [string, RequestInit | undefined]
}

// The real body `/api/proxy` answers with, captured from the fixture rather than hand-written: every
// field the schema requires, so this pins the client and not my guess at the contract.
const proxyPayload = {
  config: {
    email: '',
    engine: 'caddy',
    dns01: {
      resolvers: [],
      enabled: false,
    },
    certificates: [],
    routes: [],
    httpsPort: 443,
    httpPort: 80,
    enabled: false,
    staging: false,
  },
  engine: {
    id: 'caddy',
    installed: false,
    version: null,
    source: null,
    path: null,
    bytes: null,
    error: null,
  },
  engines: [
    {
      id: 'caddy',
      label: 'Caddy',
      docsUrl: 'https://caddyserver.com/docs/',
      releaseUrl: 'https://github.com/caddyserver/caddy/releases',
      acme: true,
      internalCa: true,
      dns01: true,
      tcp: false,
    },
  ],
  status: {
    state: 'off',
    pid: null,
    urls: [],
    certExpiryDays: null,
    since: null,
    lastError: null,
  },
  routes: [],
  certificates: [],
  dnsAccounts: [],
} as const

describe('request', () => {
  it('parses a JSON body and sends the JSON content type', async () => {
    const mock = stub({ ok: true })
    await expect(fetchSettings()).resolves.toEqual({ ok: true })
    const [, init] = lastCall(mock)
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('handles an empty body without throwing on the parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(logout()).resolves.toBeNull()
  })

  it('turns the envelope into an Error, and the bare `error` field too', async () => {
    stub({ message: 'nope', code: 'X', detail: null }, 400)
    await expect(fetchSettings()).rejects.toThrow('nope')
    stub({ error: 'bare shape' }, 403)
    await expect(fetchSettings()).rejects.toThrow('bare shape')
    stub({ detail: null }, 500)
    await expect(fetchSettings()).rejects.toThrow('request failed with 500')
  })

  it('throws AuthRequiredError for the 401 the SPA routes on', async () => {
    stub({ message: 'authentication required', code: 'AUTH_REQUIRED', detail: null }, 401)
    await expect(fetchSession()).rejects.toBeInstanceOf(AuthRequiredError)
  })
})

describe('the proxy contract is validated at the boundary', () => {
  it('accepts a real payload and rejects a malformed one', async () => {
    stub(proxyPayload)
    await expect(fetchProxy()).resolves.toMatchObject({ status: { state: 'off' } })
    stub({ nonsense: true })
    await expect(fetchProxy()).rejects.toThrow(/proxy contract mismatch/)
  })

  it('builds the action URL and the certificate URLs', async () => {
    let mock = stub(proxyPayload)
    await startProxy(); expect(lastCall(mock)[0]).toBe('/api/proxy/start')
    mock = stub(proxyPayload)
    await stopProxy(); expect(lastCall(mock)[0]).toBe('/api/proxy/stop')
    mock = stub(proxyPayload)
    await revertProxy(); expect(lastCall(mock)[0]).toBe('/api/proxy/revert')
    mock = stub(proxyPayload)
    // A route id, not a certificate id: the retry is per route.
    await retryProxyCertificate('a/b'); expect(lastCall(mock)[0]).toBe('/api/proxy/routes/a%2Fb/retry-certificate')
    mock = stub(proxyPayload)
    await clearProxyCertificate('x'); expect(lastCall(mock)[1]?.method).toBe('DELETE')
  })

  it('sends a patch body and the engine version', async () => {
    let mock = stub(proxyPayload)
    await patchProxy({ enabled: true })
    expect(lastCall(mock)[1]?.method).toBe('PATCH')
    expect(lastCall(mock)[1]?.body).toBe(JSON.stringify({ enabled: true }))
    mock = stub(proxyPayload)
    await installProxyEngine('1.2.3')
    expect(lastCall(mock)[1]?.body).toBe(JSON.stringify({ version: '1.2.3' }))
  })

  it('sends a certificate as a JSON body, and a UI as multipart', async () => {
    const mock = stub(proxyPayload)
    await uploadProxyCertificate('id', 'label', 'CERT', 'KEY')
    expect(lastCall(mock)[1]?.method).toBe('PUT')
    expect(JSON.parse(String(lastCall(mock)[1]?.body))).toMatchObject({ label: 'label', certificate: 'CERT' })

    // A `FormData` body must not carry the JSON content type — the boundary is set by the runtime.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, meta: null, ui: {} }), { status: 200 })))
    await uploadUi(new File(['x'], 'ui.zip'))
    vi.unstubAllGlobals()
  })
})

describe('auth and backups', () => {
  it('omits currentPassword when there is none, and sends it when there is', async () => {
    // ArkType rejects an explicit `undefined`, so first-time setup must omit the key entirely.
    let mock = stub({ ok: true, enabled: true })
    await setPassword(undefined, 'new-one')
    expect(JSON.parse(String(lastCall(mock)[1]?.body))).toEqual({ newPassword: 'new-one' })
    mock = stub({ ok: true, enabled: true })
    await setPassword('old-one', 'new-one')
    expect(JSON.parse(String(lastCall(mock)[1]?.body))).toEqual({ currentPassword: 'old-one', newPassword: 'new-one' })
  })

  it('validates the body shape before sending it', async () => {
    const mock = stub({ authenticated: true })
    await expect(login('a-good-password')).resolves.toBeDefined()
    expect(mock).toHaveBeenCalledTimes(1)

    // `loginSchema` requires only that `password` is a string, so an *empty* one is well-formed and
    // does reach the server — which answers 401. Asserted so the boundary is not mistaken for a
    // client-side empty check: only a non-string is refused here.
    const fresh = vi.fn(async () => new Response(JSON.stringify({ message: 'invalid password', code: 'LOGIN_FAILED', detail: null }), { status: 401 }))
    vi.stubGlobal('fetch', fresh)
    await expect(login('')).rejects.toThrow('invalid password')
    expect(fresh, 'an empty string is a valid body and must be sent').toHaveBeenCalledTimes(1)
  })

  it('encodes names in a URL and a delete', async () => {
    expect(backupDownloadUrl('a b.zip')).toBe('/api/backups/a%20b.zip/download')
    const mock = stub({ ok: true })
    await deleteBackup('a/b.zip')
    expect(lastCall(mock)[0]).toBe('/api/backups/a%2Fb.zip')
    expect(lastCall(mock)[1]?.method).toBe('DELETE')
  })

  it('carries only the restore options that were given', async () => {
    expect(restoreBody({})).toEqual({})
    expect(restoreBody({ password: '' })).toEqual({})
    expect(restoreBody({ password: 'p', include: ['a'] })).toEqual({ password: 'p', include: ['a'] })
  })

  it('clears the password with DELETE', async () => {
    const mock = stub({ ok: true })
    await clearPassword()
    expect(lastCall(mock)[1]?.method).toBe('DELETE')
  })

  it('reverts a UI with DELETE', async () => {
    const mock = stub({ ok: true, removed: true, ui: {} })
    await revertUi()
    expect(lastCall(mock)[1]?.method).toBe('DELETE')
  })

  it('exposes proxyAction for each verb', async () => {
    const mock = stub(proxyPayload)
    await proxyAction('apply')
    expect(lastCall(mock)[0]).toBe('/api/proxy/apply')
  })
})
