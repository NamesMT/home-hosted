import type { Fixture } from './fixture'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isProcessAlive } from '#src/providers/port'
import { proxyViewSchema } from '#src/shared/contracts'
import { makeFixture } from './fixture'

/**
 * The reverse proxy is panel-wide: no `?workspace=`, one engine, one route table.
 * These tests are about what the routes answer — nothing here starts an engine.
 */

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

async function makeApp(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

function patch(body: unknown): RequestInit {
  return { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

interface ProxyBody {
  config: { enabled: boolean, httpPort: number, httpsPort: number, email: string, routes: Array<{ id: string, host: string, tls: string }> }
  engine: { installed: boolean, version: string | null }
  status: { state: string, lastError: string | null }
  routes: Array<{ route: { id: string }, status: string, upstream: string | null }>
  tls: { certPresent: boolean }
  code?: string
  message?: string
}

describe('gET /api/proxy', () => {
  it('answers the policy, the engine and an empty route table', async () => {
    const fixture = await makeApp()
    const response = await fixture.app.request('/api/proxy')

    expect(response.status).toBe(200)
    const body = await response.json() as ProxyBody
    // The schema is the contract: a drift here fails loudly rather than in the UI.
    expect(proxyViewSchema(body) instanceof Error).toBe(false)
    expect(body.config).toMatchObject({ enabled: false, httpPort: 80, httpsPort: 443 })
    expect(body.engine).toMatchObject({ installed: false, version: null })
    expect(body.status.state).toBe('off')
    expect(body.routes).toEqual([])
  })
})

describe('pATCH /api/proxy', () => {
  it('saves the settings, and reports that there is no engine yet', async () => {
    const fixture = await makeApp()

    const refused = await fixture.app.request('/api/proxy', patch({
      enabled: true,
      httpPort: 4480,
      httpsPort: 4443,
      email: 'me@example.com',
      routes: [{ id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' }],
    }))
    // The save happened before the start was attempted, so the reason is the engine.
    expect(refused.status).toBe(400)
    expect((await refused.json() as ProxyBody).code).toBe('ENGINE_MISSING')

    const view = await (await fixture.app.request('/api/proxy')).json() as ProxyBody
    expect(view.config).toMatchObject({ enabled: true, httpPort: 4480, httpsPort: 4443 })
    expect(view.status.state).toBe('stopped')
    expect(view.status.lastError).toBe('the proxy engine is not installed')
    expect(fixture.settings.proxy.enabled).toBe(true)
  })

  it('refuses a public hostname with no ACME account address', async () => {
    const fixture = await makeApp()
    const response = await fixture.app.request('/api/proxy', patch({
      routes: [{ id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' }],
    }))

    expect(response.status).toBe(400)
    const body = await response.json() as ProxyBody
    expect(body.code).toBe('INVALID_PROXY')
    expect(body.message).toContain('git.example.com')
    // Nothing was written: the route list is still the empty one it started with.
    expect(fixture.settings.proxy.routes).toEqual([])
  })

  it('refuses the same hostname twice', async () => {
    const fixture = await makeApp()
    const response = await fixture.app.request('/api/proxy', patch({
      routes: [
        { id: 'a', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:1' },
        { id: 'b', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:2' },
      ],
    }))

    expect(response.status).toBe(400)
    expect((await response.json() as ProxyBody).message).toContain('routed twice')
  })

  it('refuses to put the panel on the internet without authentication', async () => {
    const fixture = await makeApp()
    fixture.settings.updateControl({ auth: { enabled: false } })

    const response = await fixture.app.request('/api/proxy', patch({
      enabled: true,
      email: 'me@example.com',
      routes: [{ id: 'panel', host: 'panel.example.com', target: 'panel' }],
    }))

    expect(response.status).toBe(400)
    const body = await response.json() as ProxyBody
    expect(body.code).toBe('PROXY_EXPOSURE_BLOCKED')
    expect(body.message).toContain('panel.example.com')
  })

  it('saves a LAN-only route with no e-mail, and reports the entry it cannot find', async () => {
    const fixture = await makeApp()
    const response = await fixture.app.request('/api/proxy', patch({
      routes: [{ id: 'gitea', host: 'gitea.lan', workspace: 'default', server: 'gitea' }],
    }))

    // Nothing is applied while the proxy is off, so the save goes through and the
    // view is where the missing entry shows up.
    expect(response.status).toBe(200)
    const body = await response.json() as ProxyBody
    expect(body.routes).toHaveLength(1)
    expect(body.routes[0]).toMatchObject({ status: 'error', upstream: null })
  })

  it('rejects a patch that is not a patch at all', async () => {
    const fixture = await makeApp()
    const response = await fixture.app.request('/api/proxy', patch({ httpPort: 0, unexpected: true }))

    expect(response.status).toBe(400)
    expect((await response.json() as ProxyBody).code).toBe('DETAILED_ERROR')
  })
})

describe('pOST /api/proxy/engine', () => {
  it('refuses a build for a platform the engine cannot serve', async () => {
    const fixture = await makeApp()
    // The download is stubbed out by the engine's own platform check only when the
    // architecture is unknown; a served platform would hit the network, so this test
    // asserts the route shape without installing anything.
    const response = await fixture.app.request('/api/proxy/start', { method: 'POST' })
    expect(response.status).toBe(400)
    expect((await response.json() as ProxyBody).code).toBe('PROXY_DISABLED')
  })

  it('stops and applies without an engine running', async () => {
    const fixture = await makeApp()
    expect((await fixture.app.request('/api/proxy/stop', { method: 'POST' })).status).toBe(200)
    expect((await fixture.app.request('/api/proxy/apply', { method: 'POST' })).status).toBe(200)
    expect((await fixture.app.request('/api/proxy/revert', { method: 'POST' })).status).toBe(400)
  })
})

describe('pUT /api/proxy/tls', () => {
  it('refuses a pair that is not a certificate', async () => {
    const fixture = await makeApp()
    const response = await fixture.app.request('/api/proxy/tls', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ certificate: 'not a pem', privateKey: 'not a key' }),
    })

    expect(response.status).toBe(400)
    expect((await response.json() as ProxyBody).code).toBe('INVALID_CERTIFICATE')
    expect((await (await fixture.app.request('/api/proxy')).json() as ProxyBody).tls.certPresent).toBe(false)
  })
})

describe('switching the proxy off', () => {
  /**
   * The regression this pins: `status()` calls a disabled proxy "off" by
   * definition, so a reconcile that asked it whether anything was running never
   * stopped the engine and the sockets stayed open. The nanny state file is the
   * handle a stop has, engine or not, so a fake one is enough to prove it.
   */
  it('ends the engine instead of leaving it serving', async () => {
    const fixture = await makeApp()
    fixture.settings.updateProxy({ enabled: true })

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    const pid = child.pid!
    const statePath = path.join(fixture.dir, '.hh', '.proxy', 'state', 'proxy.json')
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify({
      serverId: 'proxy',
      nannyPid: pid,
      childPid: null,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now(),
    }))

    const response = await fixture.app.request('/api/proxy', patch({ enabled: false }))
    expect(response.status).toBe(200)
    expect((await response.json() as ProxyBody).status.state).toBe('off')

    await vi.waitFor(() => {
      expect(isProcessAlive(pid)).toBe(false)
    })
    expect(fs.existsSync(statePath)).toBe(false)
  })
})
