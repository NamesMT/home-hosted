import type { RestorePlan } from '#src/shared/contracts'
import type { Fixture } from './fixture'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

/**
 * The data routes: servers, logs, backups, notifications, TLS and the UI upload. These
 * are where a bad request turns into a status code, so the mappings and the allowlists
 * are what is pinned here.
 */

const fixtures: Fixture[] = []

async function fixture(options?: Parameters<typeof makeFixture>[0]): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

async function request(app: Fixture['app'], url: string, method = 'GET', body?: unknown): Promise<Response> {
  return await app.request(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })
}

/** A complete restore plan: a partial stub would drift from the schema the route answers with. */
function plan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    dryRun: false,
    encrypted: false,
    needsPassword: false,
    items: [],
    applied: [],
    skipped: [],
    restartRequired: false,
    reloaded: false,
    ...overrides,
  }
}

/** A real archive, so an upload goes through the same code a person's does. */
async function makeZip(file: string, entries: Record<string, string>): Promise<string> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const [name, content] of Object.entries(entries))
    await writer.add(name, new Uint8ArrayReader(Buffer.from(content)))
  fs.writeFileSync(file, await writer.close())
  return file
}

/** A fixture holding one configured, enabled server named `web`. */
async function withServer(options?: Parameters<typeof makeFixture>[0]): Promise<Fixture> {
  return fixture({ servers: [{ id: 'web', command: 'node', autostart: true }], ...options })
}

describe('servers route', () => {
  it('lists what the supervisor knows', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const body = await (await request(created.app, '/api/servers')).json() as { servers: Array<{ id: string }> }

    expect(body.servers.map(entry => entry.id)).toEqual(['web'])
  })

  it('creates a server and persists it', async () => {
    const created = await fixture()
    const response = await request(created.app, '/api/servers', 'POST', { id: 'web', command: 'node' })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ server: { id: 'web' } })
    expect(created.store.getServer('web')).toBeDefined()
    expect(fs.readFileSync(created.store.path, 'utf8')).toContain('"web"')
  })

  it('rejects a create body that breaks the schema, and a duplicate id', async () => {
    const created = await withServer()

    expect((await request(created.app, '/api/servers', 'POST', { id: 'Bad Id', command: 'node' })).status).toBe(400)
    expect((await request(created.app, '/api/servers', 'POST', { id: 'web' })).status).toBe(400)

    const duplicate = await request(created.app, '/api/servers', 'POST', { id: 'web', command: 'node' })
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ code: 'INVALID_SERVER' })
  })

  it('answers 404 for an unknown id and 200 for a known one', async () => {
    const created = await fixture({ views: [makeView('web')] })

    expect((await request(created.app, '/api/servers/ghost')).status).toBe(404)
    const known = await request(created.app, '/api/servers/web')
    expect(known.status).toBe(200)
    expect(await known.json()).toMatchObject({ server: { id: 'web' } })
  })

  it('maps a start result onto 200, 404 and 409', async () => {
    const created = await withServer()

    expect((await request(created.app, '/api/servers/web/start', 'POST')).status).toBe(200)

    created.supervisor.start = async () => ({ ok: false, error: 'unknown server "web"' })
    expect((await request(created.app, '/api/servers/web/start', 'POST')).status).toBe(404)

    // A server that exists but cannot start is a conflict, not a missing thing.
    created.supervisor.start = async () => ({ ok: false, error: 'port 3999 is already in use' })
    const conflict = await request(created.app, '/api/servers/web/start', 'POST')
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'port 3999 is already in use' })
  })

  it('maps a stop failure onto 404 and a restart failure onto 409', async () => {
    const created = await withServer()

    created.supervisor.stop = async () => ({ ok: false, error: 'not running' })
    expect((await request(created.app, '/api/servers/web/stop', 'POST')).status).toBe(404)

    created.supervisor.restart = async () => ({ ok: false, error: 'backoff' })
    expect((await request(created.app, '/api/servers/web/restart', 'POST')).status).toBe(409)
  })

  it('clamps the log limit so a bad client cannot slice from the wrong end', async () => {
    const created = await withServer()
    const seen: Array<number | undefined> = []
    created.supervisor.logLines = (_id, limit) => {
      seen.push(limit)
      return []
    }

    await request(created.app, '/api/servers/web/logs')
    await request(created.app, '/api/servers/web/logs?limit=1')
    await request(created.app, '/api/servers/web/logs?limit=999999')
    await request(created.app, '/api/servers/web/logs?limit=abc')

    expect(seen).toEqual([undefined, 1, 100_000, undefined])
  })

  it('404s the buffered logs of a server the config does not know', async () => {
    const created = await fixture()
    expect((await request(created.app, '/api/servers/ghost/logs')).status).toBe(404)
  })

  it('clears buffered logs and reports nothing to say', async () => {
    const created = await withServer()
    const cleared: string[] = []
    created.supervisor.clearLogs = id => cleared.push(id)

    expect(await (await request(created.app, '/api/servers/web/clear-logs', 'POST')).json()).toEqual({ ok: true })
    expect(cleared).toEqual(['web'])
  })

  it('reports what free-port did, and refuses with the right status when it could not', async () => {
    const created = await withServer()

    created.supervisor.freePort = async () => ({ ok: true, port: 4321, terminated: [99], forced: [], skipped: [], free: true })
    const ok = await request(created.app, '/api/servers/web/free-port', 'POST')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ port: 4321, terminated: [99] })

    // A holder this panel supervises is a config mistake, not something to kill.
    created.supervisor.freePort = async () => ({ ok: false, port: 4321, terminated: [], forced: [], skipped: [1], free: false, error: 'the holder is supervised by this panel' })
    const refused = await request(created.app, '/api/servers/web/free-port', 'POST')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'FREE_PORT_FAILED' })

    created.supervisor.freePort = async () => ({ ok: false, port: null, terminated: [], forced: [], skipped: [], free: true, error: 'unknown server "web"' })
    expect((await request(created.app, '/api/servers/web/free-port', 'POST')).status).toBe(404)
  })

  it('patches a server, 404s an unknown one and 400s a bad field', async () => {
    const created = await withServer()

    const patched = await request(created.app, '/api/servers/web', 'PATCH', { label: 'Web' })
    expect(patched.status).toBe(200)
    expect(created.store.getServer('web')!.label).toBe('Web')

    expect((await request(created.app, '/api/servers/ghost', 'PATCH', { label: 'x' })).status).toBe(404)
    expect((await request(created.app, '/api/servers/web', 'PATCH', { port: 700_000 })).status).toBe(400)
  })

  it('removes a server, and 404s one that was never there', async () => {
    const created = await withServer()

    const removed = await request(created.app, '/api/servers/web', 'DELETE')
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true })
    expect(created.store.getServer('web')).toBeUndefined()

    expect((await request(created.app, '/api/servers/web', 'DELETE')).status).toBe(404)
  })
})

describe('logs route', () => {
  function seedLogs(created: Fixture, count: number): void {
    for (let index = 0; index < count; index++)
      created.logFiles.append('web', { ts: index, stream: index % 2 === 0 ? 'stdout' : 'stderr', text: `line-${index}` })
    // `append` is buffered (it is called per line on a hot path), so a test has to
    // flush before it can read the file back.
    created.logFiles.flush()
  }

  it('lists every server with its on-disk files', async () => {
    const created = await withServer({ views: [makeView('web')] })
    seedLogs(created, 1)

    const body = await (await request(created.app, '/api/logs')).json() as { servers: Array<{ serverId: string, files: unknown[] }> }
    expect(body.servers[0]!.serverId).toBe('web')
    expect(body.servers[0]!.files.length).toBeGreaterThan(0)
  })

  it('reads a tail and refuses an unknown server', async () => {
    const created = await withServer()
    seedLogs(created, 60)

    expect((await request(created.app, '/api/logs/ghost')).status).toBe(404)

    const body = await (await request(created.app, '/api/logs/web?tail=1')).json() as { lines: unknown[], searched: number | null }
    // The floor is 50, so `tail=1` cannot ask for a single line.
    expect(body.lines).toHaveLength(50)
    expect(body.searched).toBeNull()
  })

  it('filters by stream and reports the wider window it searched', async () => {
    const created = await withServer()
    seedLogs(created, 60)

    const stderr = await (await request(created.app, '/api/logs/web?stream=stderr')).json() as { lines: Array<{ stream: string }> }
    expect(stderr.lines.length).toBeGreaterThan(0)
    expect(stderr.lines.every(line => line.stream === 'stderr')).toBe(true)

    const searched = await (await request(created.app, '/api/logs/web?search=line-1&tail=50')).json() as { lines: Array<{ text: string }>, searched: number }
    // Search widens to the 5000-line window, otherwise an older match looks like "no results".
    expect(searched.searched).toBe(5000)
    expect(searched.lines.every(line => line.text.includes('line-1'))).toBe(true)
  })

  it('downloads a known rotated file and refuses a name outside the rotation set', async () => {
    const created = await withServer()
    seedLogs(created, 3)

    const known = await request(created.app, '/api/logs/web/download?file=web.log')
    expect(known.status).toBe(200)
    expect(known.headers.get('content-type')).toContain('application/x-ndjson')
    expect(known.headers.get('content-disposition')).toContain('web.log')
    expect(await known.text()).toContain('line-2')

    // A traversal attempt is not in the allowlist, so it never reaches readFileSync.
    const refused = await request(created.app, `/api/logs/web/download?file=${encodeURIComponent('../secrets.json')}`)
    expect(refused.status).toBe(404)
    expect(await refused.json()).toMatchObject({ code: 'UNKNOWN_LOG_FILE' })
  })

  it('clears persisted logs and 404s an unknown server', async () => {
    const created = await withServer()
    seedLogs(created, 3)

    expect(await (await request(created.app, '/api/logs/web', 'DELETE')).json()).toEqual({ ok: true })
    expect((await request(created.app, '/api/logs/ghost', 'DELETE')).status).toBe(404)
  })
})

describe('backups route', () => {
  it('answers the backup view', async () => {
    const created = await fixture()
    const response = await request(created.app, '/api/backups')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ enabled: expect.any(Boolean) })
  })

  it('turns a failed create into a 400 rather than a server fault', async () => {
    const created = await fixture()
    created.backups.create = async () => ({ ok: false, error: 'nothing to capture' })

    const response = await request(created.app, '/api/backups', 'POST', {})
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'BACKUP_FAILED', message: 'nothing to capture' })
  })

  it('404s a download and a delete for an archive that is not there', async () => {
    const created = await fixture()

    expect((await request(created.app, '/api/backups/ghost.zip/download')).status).toBe(404)
    const removed = await request(created.app, '/api/backups/ghost.zip', 'DELETE')
    expect(removed.status).toBe(404)
    expect(await removed.json()).toMatchObject({ code: 'UNKNOWN_BACKUP' })
  })

  it('plans a restore without confirming, and demands an archive to restore from', async () => {
    const created = await fixture()

    const missing = await request(created.app, '/api/backups/restore', 'POST', {})
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ code: 'MISSING_ARCHIVE' })

    const unknown = await request(created.app, '/api/backups/restore', 'POST', { name: 'ghost.zip' })
    expect(unknown.status).toBe(404)

    // A wrong or missing password is a prompt, not a failure.
    created.backups.restore = async () => plan({ needsPassword: true, dryRun: true })
    created.backups.resolve = () => '/tmp/whatever.zip'
    const prompt = await request(created.app, '/api/backups/restore', 'POST', { name: 'ghost.zip' })
    expect(prompt.status).toBe(200)
    expect(await prompt.json()).toMatchObject({ needsPassword: true })

    created.backups.restore = async () => plan({ error: 'the archive is not a zip' })
    const failed = await request(created.app, '/api/backups/restore', 'POST', { name: 'ghost.zip' })
    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({ code: 'RESTORE_FAILED' })
  })
})

describe('notifications route', () => {
  it('verifies a token before storing it, and stores it only then', async () => {
    const created = await fixture()

    created.notifications.verifyToken = async () => ({ ok: false, error: 'Unauthorized' })
    const rejected = await request(created.app, '/api/notifications/token', 'PUT', { botToken: 'bad' })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ code: 'TELEGRAM_TOKEN_REJECTED' })
    expect(created.secrets.telegramTokenSet).toBe(false)

    created.notifications.verifyToken = async () => ({ ok: true, username: 'hh_bot' })
    const accepted = await request(created.app, '/api/notifications/token', 'PUT', { botToken: 'good-token' })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ ok: true, username: 'hh_bot' })
    expect(created.secrets.telegramToken).toBe('good-token')
  })

  it('forgets the token on delete', async () => {
    const created = await fixture()
    created.secrets.setTelegramToken('something')

    expect(await (await request(created.app, '/api/notifications/token', 'DELETE')).json()).toEqual({ ok: true })
    expect(created.secrets.telegramTokenSet).toBe(false)
  })

  it('reports a refused test message and a refused chat listing as 400s', async () => {
    const created = await fixture()

    created.notifications.sendTest = async () => ({ ok: false, error: 'no chat id configured' })
    const test = await request(created.app, '/api/notifications/test', 'POST', {})
    expect(test.status).toBe(400)
    expect(await test.json()).toMatchObject({ code: 'TELEGRAM_SEND_FAILED' })

    created.notifications.sendTest = async () => ({ ok: true })
    expect((await request(created.app, '/api/notifications/test', 'POST', {})).status).toBe(200)

    created.notifications.detectChats = async () => ({ ok: false, chats: [], error: 'no bot token configured' })
    const detect = await request(created.app, '/api/notifications/detect-chats', 'POST', {})
    expect(detect.status).toBe(400)
    expect(await detect.json()).toMatchObject({ code: 'TELEGRAM_LIST_FAILED' })

    created.notifications.detectChats = async () => ({ ok: true, chats: [{ id: 42, title: 'Group' }] })
    const chats = await request(created.app, '/api/notifications/detect-chats', 'POST', {})
    expect(chats.status).toBe(200)
    expect(await chats.json()).toEqual({ chats: [{ id: 42, title: 'Group' }] })
  })
})

describe('tls route', () => {
  let cert = ''
  let key = ''
  let openssl = true

  beforeAll(async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-api-tls-'))
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '3', '-subj', '/CN=hh.test'], { stdio: 'ignore' })
      cert = await fs.promises.readFile(path.join(dir, 'cert.pem'), 'utf8')
      key = await fs.promises.readFile(path.join(dir, 'key.pem'), 'utf8')
    }
    catch {
      openssl = false
    }
    finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a pair it cannot parse', async () => {
    const created = await fixture()
    const response = await request(created.app, '/api/settings/tls', 'POST', {
      certificate: 'not a certificate',
      privateKey: 'not a key',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_CERTIFICATE' })
  })

  it('stores a real pair and clears it again', async () => {
    if (!openssl)
      return

    const created = await fixture()
    const saved = await request(created.app, '/api/settings/tls', 'POST', { certificate: cert, privateKey: key })
    expect(saved.status).toBe(200)
    expect(created.tls.present).toBe(true)

    const cleared = await request(created.app, '/api/settings/tls', 'DELETE')
    expect(cleared.status).toBe(200)
    expect(created.tls.present).toBe(false)
  })

  it('rebuilds the listener after uploading while https is already on', async () => {
    if (!openssl)
      return

    const created = await fixture()
    created.store.updateControl({ tls: { enabled: true } })
    let restarts = 0
    created.controlServer.restart = async () => {
      restarts += 1
      return { ok: true }
    }

    expect((await request(created.app, '/api/settings/tls', 'POST', { certificate: cert, privateKey: key })).status).toBe(200)
    // Deferred: rebuilding the listener kills the connection answering this request.
    expect(restarts).toBe(0)
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)))
    expect(restarts).toBe(1)
  })
})

describe('settings route: listener and UI upload', () => {
  it('reports where the panel is about to be and moves it after the response', async () => {
    const created = await fixture()
    const moves: Array<{ host: string, port: number }> = []
    created.controlServer.rebind = async (next) => {
      moves.push(next)
      return { ok: true }
    }

    const response = await request(created.app, '/api/settings', 'PATCH', { control: { port: 4123 } })
    expect(response.status).toBe(200)

    const body = await response.json() as { rebinding: boolean, targetUrl: string | null }
    expect(body.rebinding).toBe(true)
    expect(body.targetUrl).toBe('http://127.0.0.1:4123')
    expect(moves).toHaveLength(0)

    await new Promise(resolve => setImmediate(() => setImmediate(resolve)))
    expect(moves).toEqual([{ host: 'local', port: 4123 }])
  })

  it('refuses to move the panel beyond loopback without a password', async () => {
    const created = await fixture()
    created.store.updateControl({ auth: { enabled: false } })

    const response = await request(created.app, '/api/settings', 'PATCH', { control: { host: 'lan' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'EXPOSURE_BLOCKED' })
    expect(created.store.config.control.host).toBe('local')
  })

  it('rejects a UI upload with no file field', async () => {
    const created = await fixture()
    const form = new FormData()
    form.append('notAFile', 'x')

    const response = await created.app.request('/api/settings/ui', { method: 'POST', body: form })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'MISSING_FILE' })
  })

  it('rejects an upload that is not a zip archive', async () => {
    const created = await fixture()
    const form = new FormData()
    form.append('file', new File(['not a zip'], 'ui.zip', { type: 'application/zip' }))

    const response = await created.app.request('/api/settings/ui', { method: 'POST', body: form })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_UI' })
  })

  it('installs a real archive and reverts back to the stock UI', async () => {
    const created = await fixture()
    const zip = await makeZip(path.join(created.dir, 'ui.zip'), {
      'index.html': '<!doctype html><title>mine</title>',
      'ui.json': JSON.stringify({ name: 'my-panel', version: '2.0.0' }),
    })

    const form = new FormData()
    form.append('file', new File([fs.readFileSync(zip)], 'my-panel.zip', { type: 'application/zip' }))
    const response = await created.app.request('/api/settings/ui', { method: 'POST', body: form })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, meta: { name: 'my-panel' } })
    expect(created.ui.custom).toBe(true)
    // The staging file is cleaned up whatever happened.
    expect(fs.readdirSync(created.dir).filter(name => name.startsWith('.ui-upload-'))).toEqual([])

    const reverted = await created.app.request('/api/settings/ui', { method: 'DELETE' })
    expect(reverted.status).toBe(200)
    expect(await reverted.json()).toMatchObject({ ok: true, removed: true })
    expect(created.ui.custom).toBe(false)
  })

  it('refuses an upload that declares an impossible size', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/settings/ui', {
      method: 'POST',
      headers: { 'content-length': String(200 * 1024 * 1024) },
      body: 'ignored',
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
  })
})

describe('lifecycle routes', () => {
  it('starts and stops everything', async () => {
    const created = await withServer({ views: [makeView('web')] })
    const calls: string[] = []
    created.supervisor.startAll = async () => {
      calls.push('start')
    }
    created.supervisor.stopAll = async () => {
      calls.push('stop')
    }

    expect((await request(created.app, '/api/servers/start-all', 'POST')).status).toBe(200)
    expect((await request(created.app, '/api/servers/stop-all', 'POST')).status).toBe(200)
    expect(calls).toEqual(['start', 'stop'])
  })
})

describe('server event stream', () => {
  it('404s an unknown server, and streams the snapshot plus the buffered lines', async () => {
    const created = await withServer({ views: [makeView('web')] })
    for (let index = 0; index < 3; index++)
      created.logFiles.append('web', { ts: index, stream: 'stdout', text: `line-${index}` })
    created.logFiles.flush()
    created.supervisor.logLines = id => created.logFiles.readTail(id, 200)

    expect((await request(created.app, '/api/servers/ghost/stream')).status).toBe(404)

    const response = await created.app.request('/api/servers/web/stream')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !text.includes('event: log')) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now()), null)),
      ])
      if (chunk === null || chunk.done)
        break
      text += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel().catch(() => {})

    // Both opening frames: the current view, then the backfill a person expects to see.
    expect(text).toContain('event: server')
    expect(text).toContain('event: log')
    expect(text).toContain('line-2')
  })
})

describe('backups route: archives', () => {
  it('reports a created archive and the list it belongs to', async () => {
    const created = await fixture()
    created.backups.create = async () => ({ ok: true, file: { name: 'x.zip', sizeBytes: 12, createdAt: 1, encrypted: false } })

    const response = await request(created.app, '/api/backups', 'POST', {})
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ file: { name: 'x.zip' } })
  })

  it('downloads and deletes a real archive on disk', async () => {
    const created = await fixture()
    fs.mkdirSync(created.backups.directory, { recursive: true })
    const archive = path.join(created.backups.directory, 'x.zip')
    fs.writeFileSync(archive, 'zipbytes')

    const download = await request(created.app, '/api/backups/x.zip/download')
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/zip')
    expect(download.headers.get('content-disposition')).toContain('x.zip')
    expect(await download.text()).toBe('zipbytes')

    const removed = await request(created.app, '/api/backups/x.zip', 'DELETE')
    expect(removed.status).toBe(200)
    expect(fs.existsSync(archive)).toBe(false)
  })

  it('restores from an uploaded archive with a JSON include selection', async () => {
    const created = await fixture()
    const zip = await makeZip(path.join(created.dir, 'upload.zip'), { 'manifest.json': '{}' })
    const seen: unknown[] = []
    created.backups.restore = async (_archive, options) => {
      seen.push(options)
      return plan({ applied: ['config'], reloaded: true })
    }

    const form = new FormData()
    form.append('file', new File([fs.readFileSync(zip)], 'b.zip', { type: 'application/zip' }))
    form.append('include', JSON.stringify(['config']))

    const response = await created.app.request('/api/backups/restore', { method: 'POST', body: form })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ applied: ['config'] })
    expect(seen[0]).toMatchObject({ include: ['config'], confirm: false })

    // The uploaded copy is 0600 and does not outlive the request.
    expect(fs.readdirSync(path.join(created.backups.directory, 'uploads'))).toEqual([])
  })

  it('refuses a multipart include that is not a JSON array', async () => {
    const created = await fixture()
    const zip = await makeZip(path.join(created.dir, 'upload.zip'), { 'manifest.json': '{}' })
    const form = new FormData()
    form.append('file', new File([fs.readFileSync(zip)], 'b.zip', { type: 'application/zip' }))
    form.append('include', 'not json')

    const response = await created.app.request('/api/backups/restore', { method: 'POST', body: form })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INCLUDE' })
  })
})

afterAll(async () => {
  // The fixture directories are removed per test; nothing else to sweep here.
})
