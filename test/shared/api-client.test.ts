import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthRequiredError,
  backupDownloadUrl,
  clearProxyCertificate,
  createAccount,
  createBackup,
  createBackupBody,
  ddnsView,
  deleteBackup,
  disableAuth,
  failureMessage,
  fetchJobLog,
  fetchProxy,
  fetchSession,
  fetchSettings,
  fetchWslTemperature,
  installProxyEngine,
  installWslTemperature,
  login,
  logout,
  patchProxy,
  proxyAction,
  removeWslTemperature,
  restoreBody,
  restoreStoredBackup,
  retryProxyCertificate,
  revertProxy,
  revertUi,
  revokeAccount,
  setJobSecrets,
  setMySecret,
  startProxy,
  stopProxy,
  uploadProxyCertificate,
  uploadUi,
} from '#src/shared/api-client'
import { makeFixture, makeView } from '../api/fixture'

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

  it('reports the status of a failure whose body is not JSON, rather than a SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('404 Not Found', { status: 404 })))
    await expect(fetchSettings()).rejects.toThrow('request failed with 404')
    // The same rule on a mutating call: a 5xx from something in front of the panel answers HTML, and
    // a SyntaxError there would hide both the status and the fact that nothing was changed.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json at all', { status: 500 })))
    await expect(disableAuth()).rejects.toThrow('request failed with 500')
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

/**
 * The two envelopes this API really uses, and the sentence a person sees from each.
 *
 * A thrown `DetailedError` answers `{ message, code, detail }`; a **lifecycle refusal** answers
 * `{ ok: false, error }` with a 409. Both UIs read only `message` for start/stop/restart, so a
 * refused start reached the toast as `request failed with 409` — measured in Chromium on a real
 * panel whose port was held: the card explained `port 3000 is already in use (pid 2409394)` while
 * the toast beside it said nothing at all. The CLI has always read `error` first, so the two
 * transports disagreed about the same refusal.
 */
describe('failureMessage', () => {
  it('prefers the thrown-error envelope', () => {
    expect(failureMessage({ message: 'body: port must be 1..65535', code: 'INVALID_INPUT', detail: null }, 400))
      .toBe('body: port must be 1..65535')
  })

  it('reads the lifecycle envelope, which carries `error` and no `message`', () => {
    // The exact body a refused start answers with.
    expect(failureMessage({ ok: false, error: 'port 3000 is already in use (pid 2409394)', code: 'ACTION_FAILED' }, 409))
      .toBe('port 3000 is already in use (pid 2409394)')
    expect(failureMessage({ ok: false, error: 'server "web" is disabled', code: 'ACTION_FAILED' }, 409))
      .toBe('server "web" is disabled')
  })

  it('falls back to the status when there is no sentence to show', () => {
    expect(failureMessage(null, 502)).toBe('request failed with 502')
    expect(failureMessage({}, 409)).toBe('request failed with 409')
    // A non-string `error` is still better than nothing, but an empty one is not a message.
    expect(failureMessage({ error: '' }, 409)).toBe('request failed with 409')
  })
})

describe('the ddns contract is validated at the boundary', () => {
  /**
   * `ddnsView` was never called by a test — the only uncovered function in this module — so its
   * mismatch path was unexercised. Driven through the real fixture rather than a hand-written payload:
   * the contract is 9 KB of config, and a fixture I typed would pin my guess at it.
   */
  it('accepts what the panel actually sends and rejects a payload that is not one', async () => {
    const created = await makeFixture({ views: [makeView('web')] })
    try {
      const real = await (await created.app.request('/api/ddns')).json()
      await expect(ddnsView(real)).resolves.toMatchObject({ credentials: [] })
      await expect(ddnsView({ nonsense: true })).rejects.toThrow(/ddns contract mismatch/)
      await expect(ddnsView(null)).rejects.toThrow(/ddns contract mismatch/)
    }
    finally {
      await created.cleanup()
    }
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

    // A `FormData` body must not carry the JSON content type — the runtime sets the boundary.
    const mock2 = vi.fn(async () => new Response(JSON.stringify({ ok: true, meta: null, ui: {} }), { status: 200 }))
    vi.stubGlobal('fetch', mock2)
    await uploadUi(new File(['x'], 'ui.zip'))
    const init = lastCall(mock2)[1]
    expect(init?.body).toBeInstanceOf(FormData)
    expect(init?.headers).toBeUndefined()
  })

  it('rejects a certificate the schema refuses, before sending it', async () => {
    // The label may be empty — the schema defaults it — but a certificate or key may not: it requires
    // at least one character. Asserted both ways, since assuming the label was required is what the
    // first version of this test got wrong.
    const ok = stub(proxyPayload)
    await expect(uploadProxyCertificate('id', '', 'CERT', 'KEY')).resolves.toBeDefined()
    expect(ok, 'an empty label is valid').toHaveBeenCalledTimes(1)

    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(uploadProxyCertificate('id', 'label', '', 'KEY')).rejects.toThrow()
    expect(mock, 'a body without a certificate must not reach the server').not.toHaveBeenCalled()
  })
})

describe('auth and backups', () => {
  it('omits currentSecret when there is none, and sends it when there is', async () => {
    // ArkType rejects an explicit `undefined`, so a first-time set must omit the key entirely.
    let mock = stub({ ok: true })
    await setMySecret(undefined, 'new-one')
    expect(JSON.parse(String(lastCall(mock)[1]?.body))).toEqual({ newSecret: 'new-one' })
    mock = stub({ ok: true })
    await setMySecret('old-one', 'new-one')
    expect(JSON.parse(String(lastCall(mock)[1]?.body))).toEqual({ currentSecret: 'old-one', newSecret: 'new-one' })
  })

  it('creates and revokes an account through its own routes', async () => {
    const created = stub({ account: { id: 'teammate' }, secret: 'hh_generated' })
    await createAccount({ id: 'teammate', scopes: ['read'] })
    expect(lastCall(created)[0]).toBe('/api/auth/accounts')
    expect(lastCall(created)[1]?.method).toBe('POST')

    const revoked = stub({ ok: true })
    await revokeAccount('a b')
    expect(lastCall(revoked)[0], 'the id is encoded into the path').toBe('/api/auth/accounts/a%20b')
    expect(lastCall(revoked)[1]?.method).toBe('DELETE')
  })

  it('validates the body shape before sending it', async () => {
    const mock = stub({ authenticated: true })
    await expect(login('default', 'a-good-password')).resolves.toBeDefined()
    expect(mock).toHaveBeenCalledTimes(1)

    /**
     * An empty secret or id is refused **before** the request.
     *
     * `loginSchema` used to accept an empty password, so it reached the server and came back 401. A
     * credential is two non-empty halves now, and an empty one is not a guess worth spending a request
     * — or an attempt against the address budget — on.
     */
    const fresh = vi.fn(async () => new Response(JSON.stringify({ message: 'invalid account id or secret', code: 'LOGIN_FAILED', detail: null }), { status: 401 }))
    vi.stubGlobal('fetch', fresh)
    // It throws synchronously — the schema check runs before a promise is ever produced — so the
    // assertion is `toThrow`, not `rejects`.
    expect(() => login('default', '')).toThrow('secret')
    expect(() => login('', 'a-good-password')).toThrow('id')
    expect(fresh, 'neither reached the server').not.toHaveBeenCalled()
  })

  it('encodes names in a URL and a delete', async () => {
    expect(backupDownloadUrl('a b.zip')).toBe('/api/backups/a%20b.zip/download')
    const mock = stub({ ok: true })
    await deleteBackup('a/b.zip')
    expect(lastCall(mock)[0]).toBe('/api/backups/a%2Fb.zip')
    expect(lastCall(mock)[1]?.method).toBe('DELETE')
  })

  /**
   * A job's log takes a **server log's** filters, so the client builds the same query.
   *
   * The two must not drift: a page that offers a stream filter on a job has to send the parameter a
   * page that offers one on a server sends, or the same control silently means two things.
   */
  it('asks for a job log with only the filters it was given', async () => {
    const mock = stub({ jobId: 'backup', enabled: true, sizeBytes: 0, files: [], lines: [] })
    await fetchJobLog('backup')
    expect(lastCall(mock)[0]).toBe('/api/jobs/backup/log')

    await fetchJobLog('a b', { tail: 100, stream: 'stderr', search: 'boom' })
    const url = lastCall(mock)[0]
    expect(url).toContain('/api/jobs/a%20b/log?')
    expect(url).toContain('tail=100')
    expect(url).toContain('stream=stderr')
    expect(url).toContain('search=boom')

    // An empty string is not a filter: the route reads it as one matching nothing, so it is omitted.
    await fetchJobLog('backup', { search: '', stream: '' })
    expect(lastCall(mock)[0]).toBe('/api/jobs/backup/log')
  })

  /**
   * A job's secret values go through the **job's** route, keyed by its id — not the server one.
   *
   * The two stores are the same file, so a call sent to the wrong route would look like it worked and
   * write under a key nothing reads.
   */
  it('writes a job\'s secret values through its own route', async () => {
    const mock = stub({ ok: true })
    await setJobSecrets('a/b', { set: { TOKEN: 'x' }, unset: ['OLD'] })
    expect(lastCall(mock)[0]).toBe('/api/jobs/a%2Fb/secrets')
    expect(lastCall(mock)[1]?.method).toBe('PUT')
    expect(JSON.parse(lastCall(mock)[1]?.body as string)).toEqual({ set: { TOKEN: 'x' }, unset: ['OLD'] })
  })

  it('carries only the restore options that were given', async () => {
    expect(restoreBody({})).toEqual({})
    expect(restoreBody({ password: '' })).toEqual({})
    expect(restoreBody({ password: 'p', include: ['a'] })).toEqual({ password: 'p', include: ['a'] })
  })

  /**
   * A restore may say what to leave out, the way the CLI's `--exclude` does.
   *
   * `restoreBody` had its own copy of the selection builder that carried only `password` and
   * `include`, so a UI could tick items but never express "everything except the credentials" —
   * the one shape the docs recommend for an archive that moves between machines. The server's
   * schema refused the key it never sent, so the two halves were wrong together.
   */
  it('sends a restore selection in either direction, and refuses an empty one', async () => {
    expect(restoreBody({ exclude: ['global:secrets'] })).toEqual({ exclude: ['global:secrets'] })
    expect(restoreBody({ include: ['workspace:default'], exclude: ['workspace:default:secrets'] }))
      .toEqual({ include: ['workspace:default'], exclude: ['workspace:default:secrets'] })
    expect(() => restoreBody({ include: [] })).toThrow('nothing is selected')
    expect(() => restoreBody({ exclude: [] })).toThrow('nothing is excluded')

    const mock = stub({ items: [] })
    await restoreStoredBackup('x.zip', true, { exclude: ['global:secrets'] })
    expect(JSON.parse(String(lastCall(mock)[1]?.body))).toEqual({ name: 'x.zip', exclude: ['global:secrets'] })
  })

  it('sends a create selection in either direction, and refuses an empty one', async () => {
    const mock = stub({ file: { name: 'x.zip' } })
    await createBackup({ exclude: ['global:secrets'] })
    expect(lastCall(mock)[0]).toBe('/api/backups')
    expect(lastCall(mock)[1]?.method).toBe('POST')
    expect(JSON.parse(String(lastCall(mock)[1]?.body))).toEqual({ exclude: ['global:secrets'] })

    // Both at once is what the CLI means by `--include … --exclude …`: the exclusion applies after.
    expect(createBackupBody({ password: '', include: ['a'], exclude: ['a:b'] })).toEqual({ include: ['a'], exclude: ['a:b'] })

    // An empty list must never travel: omitting `include` means "everything" to the server and an
    // empty `exclude` would leave in exactly what was meant to be dropped.
    expect(() => createBackupBody({ include: [] })).toThrow('nothing is selected')
    expect(() => createBackupBody({ exclude: [] })).toThrow('nothing is excluded')
  })

  it('turns the guard off with DELETE, keeping the accounts', async () => {
    const mock = stub({ ok: true })
    await disableAuth()
    expect(lastCall(mock)[0]).toBe('/api/auth/password')
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

/**
 * The WSL temperature bridge's three calls.
 *
 * The `download` query is consent, and it is the whole safety property: a press without it writes the
 * helper and answers `needsDownload`, so no click installs a binary the person was not told about.
 * A URL assertion is the only place that is visible — the panel's own branch is tested beside it.
 */
describe('the WSL temperature bridge', () => {
  const status = { wsl: true, supported: true, configured: false, scriptWritten: false, libraryPresent: false, scriptPath: null }

  it('asks for the state', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await expect(fetchWslTemperature()).resolves.toMatchObject({ supported: true })
    expect(lastCall(mock)[0]).toBe('/api/host/temperature')
  })

  it('posts without consent by default, and with it only when asked', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 }))
    vi.stubGlobal('fetch', mock)

    await installWslTemperature()
    const [plainUrl, plainInit] = lastCall(mock)
    expect(plainUrl, 'no consent must mean no download query').toBe('/api/host/temperature')
    expect(plainInit?.method).toBe('POST')

    await installWslTemperature({ download: true })
    expect(lastCall(mock)[0], 'consent travels as the query the route reads').toBe('/api/host/temperature?download=true')
  })

  it('deletes through the same path', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await removeWslTemperature()
    const [url, init] = lastCall(mock)
    expect(url).toBe('/api/host/temperature')
    expect(init?.method).toBe('DELETE')
  })
})
