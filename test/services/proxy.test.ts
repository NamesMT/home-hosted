import type { ProxyServiceOptions } from '#src/services/proxy'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GlobalSettingsStore } from '#src/config/settings'
import { isPublicHost, parseUpstream, ProxyService, validateProxyConfig } from '#src/services/proxy'
import { proxyConfigSchema } from '#src/shared/contracts'

const dirs: string[] = []

let openssl = true

beforeAll(() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
  }
  catch {
    openssl = false
  }
})

/** A real pair, valid or long expired — the second is what an in-place expiry looks like. */
function makePair(host: string, expired = false): { certificate: string, privateKey: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-proxy-pair-'))
  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(dir, 'key.pem'),
    '-out',
    path.join(dir, 'cert.pem'),
    '-subj',
    `/CN=${host}`,
    '-addext',
    `subjectAltName=DNS:${host}`,
    ...(expired ? ['-not_before', '20200101000000Z', '-not_after', '20200102000000Z'] : ['-days', '3']),
  ]
  try {
    execFileSync('openssl', args, { stdio: 'ignore' })
    return {
      certificate: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
      privateKey: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
    }
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Writes a pair where the store looks for it, without going through the API. */
function writePair(tlsDir: string, id: string, pair: { certificate: string, privateKey: string }): void {
  fs.mkdirSync(tlsDir, { recursive: true })
  fs.writeFileSync(path.join(tlsDir, `${id}.crt.pem`), pair.certificate)
  fs.writeFileSync(path.join(tlsDir, `${id}.key.pem`), pair.privateKey)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-proxy-'))
  dirs.push(dir)
  return dir
}

function config(input: Record<string, unknown>) {
  const parsed = proxyConfigSchema(input)
  if (parsed instanceof type.errors)
    throw parsed
  return parsed
}

interface Harness {
  service: ProxyService
  settings: GlobalSettingsStore
  dir: string
  options: ProxyServiceOptions
}

async function harness(overrides: Partial<ProxyServiceOptions> = {}): Promise<Harness> {
  const dir = await tempDir()
  const settingsFile = path.join(dir, 'settings.json')
  await fs.promises.writeFile(settingsFile, '{"control":{}}\n')
  const settings = new GlobalSettingsStore(settingsFile)
  settings.load()

  const options: ProxyServiceOptions = {
    settings,
    binDir: path.join(dir, 'bin'),
    engineDir: path.join(dir, 'engine'),
    configPath: path.join(dir, 'engine', 'current.json'),
    previousConfigPath: path.join(dir, 'engine', 'previous.json'),
    stateDir: path.join(dir, 'state'),
    adminPath: path.join(dir, 'state', 'admin.json'),
    logDir: path.join(dir, 'logs'),
    tlsDir: path.join(dir, 'tls'),
    control: () => ({ host: 'local', port: 3999, bindHost: '127.0.0.1', url: 'http://127.0.0.1:3999', protocol: 'http' }),
    resolveServer: () => null,
    exposureBlocked: () => null,
    onStateChange: () => undefined,
    ...overrides,
  }
  return { service: new ProxyService(options), settings, dir, options }
}

describe('validateProxyConfig', () => {
  it('rejects the ports a listener cannot tell apart', () => {
    expect(validateProxyConfig(config({ httpPort: 443, httpsPort: 443 }))).toEqual(['the http and https ports must differ'])
    expect(validateProxyConfig(config({ httpPort: 80, httpsPort: 443 }))).toEqual([])
  })

  it('rejects a duplicate id or a host routed twice', () => {
    const twice = config({
      routes: [
        { id: 'a', host: 'one.example.com' },
        { id: 'a', host: 'two.example.com' },
        { id: 'b', host: 'ONE.example.com' },
      ],
    })
    const errors = validateProxyConfig(twice)
    expect(errors).toContain('route id "a" is used twice')
    expect(errors).toContain('"ONE.example.com" is routed twice')
  })

  it('needs a workspace and a server for an entry route, and a url for an external one', () => {
    const errors = validateProxyConfig(config({ routes: [{ id: 'a', host: 'a.example.com' }, { id: 'b', host: 'b.example.com', target: 'external', url: 'not a url' }] }))
    expect(errors).toContain('route "a" needs a workspace and a server')
    expect(errors).toContain('route "b" needs an upstream like http://10.0.0.5:8080')
  })

  it('asks for an ACME address only when a name could get a public certificate', () => {
    const internal = config({ routes: [{ id: 'a', host: 'gitea.lan', target: 'external', url: 'http://10.0.0.5:3000' }] })
    expect(validateProxyConfig(internal)).toEqual([])

    const public_ = config({ routes: [{ id: 'a', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' }] })
    expect(validateProxyConfig(public_)).toEqual(['automatic HTTPS needs an ACME account e-mail for git.example.com'])

    // Staging is a deliberate public-CA rehearsal, so it still needs an address.
    expect(validateProxyConfig({ ...public_, staging: true })).toEqual([])

    // A host that opted out of TLS needs no certificate at all.
    const plain = config({ routes: [{ id: 'a', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000', tls: 'off' }] })
    expect(validateProxyConfig(plain)).toEqual([])
  })
})

describe('host and upstream parsing', () => {
  it('knows which names an ACME CA could issue for', () => {
    expect(isPublicHost('git.example.com')).toBe(true)
    expect(isPublicHost('a.b.example.co.uk')).toBe(true)
    expect(isPublicHost('gitea')).toBe(false)
    expect(isPublicHost('gitea.lan')).toBe(false)
    expect(isPublicHost('box.local')).toBe(false)
    expect(isPublicHost('box.internal')).toBe(false)
    expect(isPublicHost('localhost')).toBe(false)
    expect(isPublicHost('192.168.1.10')).toBe(false)
  })

  it('reads an upstream as host:port, with or without a scheme', () => {
    expect(parseUpstream('127.0.0.1:8080')).toEqual({ dial: '127.0.0.1:8080', tls: false })
    expect(parseUpstream('http://10.0.0.5:3000')).toEqual({ dial: '10.0.0.5:3000', tls: false })
    expect(parseUpstream('https://srv.lan:8443')).toEqual({ dial: 'srv.lan:8443', tls: true })
    expect(parseUpstream(' 127.0.0.1:8080 ')).toEqual({ dial: '127.0.0.1:8080', tls: false })
    expect(parseUpstream('')).toBeNull()
    expect(parseUpstream('10.0.0.5')).toBeNull()
    expect(parseUpstream('not a url')).toBeNull()
  })
})

describe('proxyService', () => {
  it('offers a view that reads as "nothing yet"', async () => {
    const { service } = await harness()
    const view = service.view()
    expect(view.config.enabled).toBe(false)
    expect(view.engine).toMatchObject({ id: 'caddy', installed: false, version: null })
    expect(view.status.state).toBe('off')
    expect(view.routes).toEqual([])
    expect(view.certificates).toEqual([])
  })

  it('reports an installed engine with what was written beside it', async () => {
    const { service, options } = await harness()
    fs.mkdirSync(options.binDir, { recursive: true })
    fs.writeFileSync(path.join(options.binDir, 'hh-caddy'), 'not really a binary')
    fs.writeFileSync(path.join(options.binDir, 'engine.json'), JSON.stringify({
      engine: 'caddy',
      version: '2.11.4',
      source: 'downloaded',
      url: 'https://example.test/caddy',
      sha256: 'abc',
      bytes: 12,
      installedAt: 1,
    }))

    expect(service.installed()).toBe(true)
    expect(service.engineStatus()).toMatchObject({ installed: true, version: '2.11.4', source: 'downloaded', sha256: 'abc', bytes: 12 })
  })

  it('calls a binary we did not install our own, and reads a garbled record as absent', async () => {
    const { service, options } = await harness()
    fs.mkdirSync(options.binDir, { recursive: true })
    fs.writeFileSync(path.join(options.binDir, 'hh-caddy'), 'x')
    fs.writeFileSync(path.join(options.binDir, 'engine.json'), '{ not json')

    expect(service.engineStatus()).toMatchObject({ installed: true, source: 'custom', version: null, sha256: null })
  })

  it('resolves an entry route, and says which ones are dark', async () => {
    const { service, settings } = await harness({
      resolveServer: (workspace, server) => {
        if (workspace === 'home' && server === 'gitea')
          return { url: '127.0.0.1:3000', message: null }
        if (workspace === 'home' && server === 'sleepy')
          return { url: null, message: '"home/sleepy" is stopped' }
        return null
      },
    })
    settings.updateProxy({
      routes: [
        { id: 'gitea', host: 'git.example.com', workspace: 'home', server: 'gitea' },
        { id: 'sleepy', host: 'sleepy.example.com', workspace: 'home', server: 'sleepy' },
        { id: 'ghost', host: 'ghost.example.com', workspace: 'home', server: 'ghost' },
        { id: 'off', host: 'off.example.com', workspace: 'home', server: 'gitea', enabled: false },
        { id: 'ext', host: 'ext.example.com', target: 'external', url: 'http://10.0.0.5:8080' },
        { id: 'panel', host: 'panel.example.com', target: 'panel' },
      ],
    })

    const views = service.routeViews()
    expect(views.map(view => [view.route.id, view.status])).toEqual([
      ['gitea', 'ok'],
      ['sleepy', 'no-upstream'],
      ['ghost', 'error'],
      ['off', 'disabled'],
      ['ext', 'ok'],
      ['panel', 'ok'],
    ])
    expect(views[0]?.upstream).toBe('127.0.0.1:3000')
    expect(views[1]?.message).toBe('"home/sleepy" is stopped')
    expect(views[5]?.upstream).toBe('127.0.0.1:3999')
  })

  it('refuses two routes for the same host before anything is generated', async () => {
    const { service, settings } = await harness()
    settings.updateProxy({
      routes: [
        { id: 'a', host: 'same.example.com', target: 'external', url: 'http://10.0.0.5:1' },
        { id: 'b', host: 'same.example.com', target: 'external', url: 'http://10.0.0.5:2' },
      ],
    })
    const blocked = service.routeViews().find(view => view.status === 'error')
    expect(blocked?.route.id).toBe('b')
    expect(blocked?.message).toContain('routed twice')
  })

  it('is off, then stopped with a reason once it is switched on without an engine', async () => {
    const { service, settings } = await harness()
    expect(service.status()).toMatchObject({ state: 'off', lastError: null })

    settings.updateProxy({ enabled: true })
    expect(service.status()).toMatchObject({ state: 'stopped', lastError: 'the proxy engine is not installed', urls: ['http://localhost:80', 'https://localhost:443'] })

    settings.updateProxy({ httpPort: 4480, httpsPort: 4443 })
    expect(service.status().urls).toEqual(['http://localhost:4480', 'https://localhost:4443'])
  })

  it('writes the settings a patch asks for, through the store', async () => {
    const { service, settings } = await harness()
    service.update({ enabled: true, httpPort: 4480, httpsPort: 4443, email: 'me@example.com' })

    expect(settings.proxy).toMatchObject({ enabled: true, httpPort: 4480, httpsPort: 4443, email: 'me@example.com' })
    expect(service.view().config.httpPort).toBe(4480)
  })

  it('does not start anything for a config that is only switched off', async () => {
    const { service } = await harness()
    await expect(service.start()).rejects.toThrow('switched off')
    await expect(service.apply()).resolves.toBeUndefined()
  })

  it('refuses to serve a pair that expired in place, and says so', async () => {
    if (!openssl)
      return
    const { service, settings, options } = await harness()
    // The upload path rejects an already-expired pair; this is the one it cannot see —
    // a pair that was valid when stored and expired since.
    writePair(options.tlsDir, 'old', makePair('old.example.com', true))
    settings.updateProxy({ certificates: [{ id: 'old', label: 'Old' }] })

    const view = service.certificateViews()[0]
    expect(view).toMatchObject({ id: 'old', present: true, used: false })
    expect(view?.error).toContain('expired')

    settings.updateProxy({
      routes: [{ id: 'h', host: 'old.example.com', target: 'external', url: 'http://10.0.0.5:1', tls: 'manual' }],
    })
    const route = service.routeViews()[0]
    expect(route?.status).toBe('error')
    expect(route?.certificate?.state).toBe('failed')
    expect(route?.certificate?.message).toContain('expired')
  })

  it('serves the usable pair, and marks the shadowed one unused', async () => {
    if (!openssl)
      return
    const { service, settings, options } = await harness()
    writePair(options.tlsDir, 'good', makePair('good.example.com'))
    writePair(options.tlsDir, 'old', makePair('good.example.com', true))
    settings.updateProxy({ certificates: [{ id: 'good', label: 'Good' }, { id: 'old', label: 'Old' }] })
    settings.updateProxy({
      routes: [{ id: 'h', host: 'good.example.com', target: 'external', url: 'http://10.0.0.5:1', tls: 'manual' }],
    })

    // Only the usable pair is a candidate, so the route is fine and the expired copy is
    // reported as unused rather than as a second healthy certificate.
    expect(service.routeViews()[0]?.status).toBe('ok')
    expect(service.routeViews()[0]?.certificate?.state).toBe('uploaded')
    expect(service.certificateViews().map(entry => [entry.id, entry.used])).toEqual([['good', true], ['old', false]])
  })

  it('refuses a pair that is not a certificate, and stores none', async () => {
    const { service, settings } = await harness()
    // The same validator the panel's own TLS uses, so a bad pair never reaches disk.
    expect(service.saveCertificate('m', 'Mine', '', '').ok).toBe(false)
    expect(settings.proxy.certificates).toEqual([])
    expect(service.view().certificates).toEqual([])
  })
})
