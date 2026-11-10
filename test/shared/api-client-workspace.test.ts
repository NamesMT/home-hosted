import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLogHistory,
  clearLogs,
  createServer,
  createWorkspace,
  deleteWorkspace,
  fetchBackups,
  fetchDdns,
  fetchLogHistory,
  fetchLogServers,
  fetchState,
  fetchWorkspaceSettings,
  patchServer,
  patchSettings,
  patchWorkspaceSettings,
  removeServer,
  scoped,
  sendTelegramTest,
  serverAction,
  serverStreamUrl,
  startAll,
  stopAll,
  stopOrphan,
  testWebhook,
  useWorkspaceResolver,
} from '#src/shared/api-client'

/**
 * The workspace-scoped half of the panel client.
 *
 * These 35 calls were a hand-maintained copy in each UI's `lib/api.ts` — 387 and 386 lines, 61%
 * identical — so they sat outside `src/shared` and outside its coverage floor. Collapsing them moved
 * the code here, where the floor applies and the cases below pay for it. What is worth pinning is the
 * part the two copies disagreed about: the URL each call builds, and what happens when a call omits
 * the workspace.
 */
afterEach(() => {
  vi.unstubAllGlobals()
  // The resolver is module state: leaving one installed would leak into the next test.
  useWorkspaceResolver(() => null)
})

function stub(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The smallest body `workspaceViewSchema` accepts, so a validating call can be driven end to end. */
function workspaceView(): Record<string, unknown> {
  return {
    id: 'alpha',
    label: 'Alpha',
    configPath: '/h/.hh/alpha/servers.config.json',
    settingsPath: '/h/.hh/alpha/settings.json',
    configError: null,
    logsDir: '/h/.hh/alpha/.logs',
    defaults: {},
    logs: {},
    notifications: {},
    serverCount: 0,
    runningCount: 0,
    crashedCount: 0,
    servers: [],
  }
}

function url(mock: ReturnType<typeof vi.fn>): string {
  return (mock.mock.calls.at(-1) as unknown as [string])[0]
}

function init(mock: ReturnType<typeof vi.fn>): RequestInit {
  return (mock.mock.calls.at(-1) as unknown as [string, RequestInit])[1] ?? {}
}

describe('scoped', () => {
  it('appends the workspace as a query', () => {
    expect(scoped('/api/logs', 'alpha')).toBe('/api/logs?workspace=alpha')
  })

  it('omits the key when no workspace is named and none is resolved', () => {
    // An omitted workspace means "the panel's default", which is what a single-workspace instance
    // wants; `?workspace=` would be a lookup of a workspace whose id is empty.
    expect(scoped('/api/logs')).toBe('/api/logs')
    expect(scoped('/api/logs', '')).toBe('/api/logs')
    expect(scoped('/api/logs', null)).toBe('/api/logs')
  })

  it('falls back to the installed resolver when the caller names nothing', () => {
    useWorkspaceResolver(() => 'from-resolver')
    expect(scoped('/api/logs')).toBe('/api/logs?workspace=from-resolver')
  })

  it('prefers the caller\'s own workspace to the resolver', () => {
    // `stock` threads the workspace explicitly and installs no resolver; `noc-console` installs one
    // and passes nothing. Both must work, and an explicit argument always wins.
    useWorkspaceResolver(() => 'from-resolver')
    expect(scoped('/api/logs', 'explicit')).toBe('/api/logs?workspace=explicit')
  })

  it('joins with `&` when the path already carries a query', () => {
    // The bug this unifies: `stock`'s copy always wrote `?`, so a path with its own query produced
    // `/api/logs/x/download?file=y?workspace=z`. It was latent only because no caller passed one.
    expect(scoped('/api/logs/x/download?file=a.log', 'alpha')).toBe('/api/logs/x/download?file=a.log&workspace=alpha')
  })

  it('merges extra parameters with the workspace', () => {
    expect(scoped('/api/logs/x', 'alpha', new URLSearchParams({ tail: '50' }))).toBe('/api/logs/x?tail=50&workspace=alpha')
  })

  it('encodes a workspace id that needs it', () => {
    expect(scoped('/api/logs', 'a b')).toBe('/api/logs?workspace=a+b')
  })
})

describe('the routes these calls name', () => {
  it('builds each workspace-scoped URL', async () => {
    // One table rather than a test per call: what matters is the path and the method, and a table
    // makes an inconsistency between siblings visible at a glance.
    const cases: Array<[string, () => Promise<unknown>, string, string]> = [
      ['fetchLogServers', () => fetchLogServers('alpha'), '/api/logs?workspace=alpha', 'GET'],
      ['clearLogHistory', () => clearLogHistory('web', 'alpha'), '/api/logs/web?workspace=alpha', 'DELETE'],
      ['startAll', () => startAll('alpha'), '/api/servers/start-all?workspace=alpha', 'POST'],
      ['stopAll', () => stopAll('alpha'), '/api/servers/stop-all?workspace=alpha', 'POST'],
      ['clearLogs', () => clearLogs('web', 'alpha'), '/api/servers/web/clear-logs?workspace=alpha', 'POST'],
      ['removeServer', () => removeServer('web', 'alpha'), '/api/servers/web?workspace=alpha', 'DELETE'],
      ['stopOrphan', () => stopOrphan('alpha', 'web'), '/api/servers/orphans/web/stop?workspace=alpha', 'POST'],
      ['fetchDdns', () => fetchDdns('alpha'), '/api/ddns?workspace=alpha', 'GET'],
      ['sendTelegramTest', () => sendTelegramTest('ops', { chatId: '1' }, 'alpha'), '/api/notifications/destinations/ops/test?workspace=alpha', 'POST'],
      ['testWebhook', () => testWebhook('alpha', { target: {} as never, id: 'ops' }), '/api/notifications/test-webhook?workspace=alpha', 'POST'],
      ['fetchState', () => fetchState(), '/api/state', 'GET'],
      ['createWorkspace', () => createWorkspace({ label: 'x' }), '/api/workspaces', 'POST'],
      ['patchSettings', () => patchSettings({}), '/api/settings', 'PATCH'],
    ]
    for (const [, call, path, method] of cases) {
      const mock = stub({})
      // These calls validate their answer, so a body that does not satisfy the contract throws — that
      // is a separate assertion below. Here only the request matters.
      await call().catch(() => null)
      expect(url(mock), `${method} ${path}`).toBe(path)
      expect(init(mock).method ?? 'GET', `${method} ${path}`).toBe(method)
    }
  })

  it('scopes the per-server stream URL', () => {
    expect(serverStreamUrl('web', 'alpha')).toBe('/api/servers/web/stream?workspace=alpha')
    useWorkspaceResolver(() => 'from-resolver')
    expect(serverStreamUrl('web')).toBe('/api/servers/web/stream?workspace=from-resolver')
  })

  it('sends the workspace in the log-history query alongside the filters', async () => {
    // The two copies built this differently: one composed the whole query, the other prepended a
    // pre-built `?…`. One spelling now, and every parameter lands in the same query string.
    const mock = stub({ serverId: 'web', enabled: true, sizeBytes: 1, files: [], searched: null, lines: [] })
    await fetchLogHistory('web', { tail: 50, search: 'boom', stream: 'stderr' }, 'alpha')
    const built = new URL(url(mock), 'http://x')
    expect(built.pathname).toBe('/api/logs/web')
    expect(built.searchParams.get('workspace')).toBe('alpha')
    expect(built.searchParams.get('tail')).toBe('50')
    expect(built.searchParams.get('search')).toBe('boom')
    expect(built.searchParams.get('stream')).toBe('stderr')
  })

  it('omits an empty search rather than sending a filter that matches nothing', async () => {
    const mock = stub({ serverId: 'web', enabled: true, sizeBytes: 1, files: [], searched: null, lines: [] })
    await fetchLogHistory('web', { search: '', stream: '' }, 'alpha')
    const built = new URL(url(mock), 'http://x')
    expect(built.searchParams.has('search')).toBe(false)
    expect(built.searchParams.has('stream')).toBe(false)
  })
})

describe('validation at the boundary', () => {
  it('refuses a backups payload that is not one', async () => {
    // The drift this collapse resolved: `stock` cast this response, `noc-console` validated it, so a
    // contract change would have shown as an empty capture tree in one product only.
    stub({ dir: '.backups' })
    await expect(fetchBackups()).rejects.toThrow('backups contract mismatch')
  })

  it('accepts a real backups payload', async () => {
    stub({ dir: '.backups', entries: [], files: [] })
    await expect(fetchBackups()).resolves.toMatchObject({ dir: '.backups' })
  })

  it('refuses a workspace-settings payload that is not one', async () => {
    stub({ id: 'alpha' })
    await expect(fetchWorkspaceSettings('alpha')).rejects.toThrow('workspace settings contract mismatch')
  })

  it('refuses an invalid workspace-settings patch before sending it', async () => {
    const mock = stub({})
    // `defaults` must be an object; a string is a client bug, and the schema says so locally rather
    // than letting the server answer 400 after every other pending edit has been bundled in.
    await expect(patchWorkspaceSettings({ defaults: 'nope' } as never, 'alpha')).rejects.toThrow()
    expect(mock).not.toHaveBeenCalled()
  })

  it('refuses a failed patch with the panel\'s own sentence', async () => {
    stub({ message: 'port 3000 is already in use', code: 'PORT_BUSY' }, 409)
    await expect(patchServer('web', { command: 'node' }, 'alpha')).rejects.toThrow('port 3000 is already in use')
  })
})

describe('a lifecycle refusal', () => {
  it('reads the `{ ok: false, error }` envelope, not just `message`', async () => {
    // The refusal shape is why the shared `failureMessage` exists: reading only `message` showed
    // "request failed with 409" for the one button a person presses when a server will not start.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'port 3000 is already in use' }), { status: 409, headers: { 'content-type': 'application/json' } })))
    await expect(serverAction('web', 'start', 'alpha')).rejects.toThrow('port 3000 is already in use')
  })

  it('answers a successful action with its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(serverAction('web', 'start', 'alpha')).resolves.toEqual({ ok: true })
  })

  it('answers an empty success body with a bare `ok`', async () => {
    // A 204-style answer has no body; a caller reading `result` must not get `null`.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(serverAction('web', 'stop', 'alpha')).resolves.toEqual({ ok: true })
  })
})

describe('workspace CRUD', () => {
  it('sends the label on a create and returns the workspace', async () => {
    const mock = stub({ workspace: workspaceView() }, 201)
    await expect(createWorkspace({ label: 'Alpha' })).resolves.toMatchObject({ id: 'alpha' })
    expect(init(mock).body).toBe('{"label":"Alpha"}')
  })

  it('validates the create body before sending it', async () => {
    const mock = stub({})
    await expect(createWorkspace({ label: '' } as never)).rejects.toThrow()
    expect(mock).not.toHaveBeenCalled()
  })

  it('answers a removal with what was removed', async () => {
    stub({ ok: true, removed: { id: 'alpha', label: 'Alpha' } })
    await expect(deleteWorkspace('alpha')).resolves.toEqual({ ok: true, removed: { id: 'alpha', label: 'Alpha' } })
  })

  it('refuses a removal answer that is not one', async () => {
    stub({ ok: true })
    await expect(deleteWorkspace('alpha')).rejects.toThrow('workspace removal contract mismatch')
  })
})

describe('the settings answer', () => {
  it('validates the rebinding pair a save depends on', async () => {
    // A cast here would let a missing `rebinding` read as `undefined`, which is falsy, and leave the
    // page on a stale origin after the listener moved.
    stub({ control: {}, host: {}, backups: {}, ui: {} })
    await expect(patchSettings({})).rejects.toThrow('settings contract mismatch')
  })

  it('sends only the group that changed', async () => {
    // A patch that re-sent the whole config is how a page starts rewriting settings nobody edited.
    // The answer is not asserted here: the shape a real save returns is driven end to end against the
    // route in `test/api/settings.test.ts` (which validates it with `settingsSavedSchema`), and a
    // hand-written body here would pin my guess at that payload instead of the client.
    const mock = stub({})
    await patchSettings({ host: { enabled: true } }).catch(() => null)
    expect(init(mock).body).toBe('{"host":{"enabled":true}}')
  })
})

describe('creating a server', () => {
  it('posts the payload to the workspace route', async () => {
    const mock = stub({})
    await createServer({ id: 'web', command: 'node' } as never, 'alpha')
    expect(url(mock)).toBe('/api/servers?workspace=alpha')
    expect(init(mock).method).toBe('POST')
  })
})
