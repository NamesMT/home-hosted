import type { AddressInfo } from 'node:net'
import type { ProxyServiceOptions } from '#src/services/proxy'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalSettingsStore } from '#src/config/settings'
import { logger } from '#src/helpers/logger'
import { nannyStatePath, writeNannyState } from '#src/providers/nanny'
import { isProcessAlive } from '#src/providers/port'
import { groupDns01Policies, parseUpstream, ProxyService, validateProxyConfig } from '#src/services/proxy'
import { proxyConfigSchema } from '#src/shared/contracts'
import { isPublicHost } from '#src/shared/proxy-form'
import { hasOpenssl } from '../support/capabilities'

const dirs: string[] = []

/**
 * Detected at module load, not in a hook: `it.runIf` is evaluated when the suite is collected,
 * before `beforeAll` runs. Returning early inside the test instead makes vitest report a *pass*
 * on a machine without hasOpenssl, which claims coverage the run did not have.
 */

/**
 * A real pair. Expiry is tested by moving the clock, not by backdating the
 * certificate: `-not_before`/`-not_after` only exist from OpenSSL 3.2, and the CI
 * runner carries an older one.
 */
function makePair(host: string): { certificate: string, privateKey: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-proxy-pair-'))
  try {
    execFileSync('openssl', [
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
      '-days',
      '3',
    ], { stdio: 'ignore' })
    return {
      certificate: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
      privateKey: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
    }
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** A pair the store cannot read at all: the other way a stored pair stops being usable. */
function brokenPair(): { certificate: string, privateKey: string } {
  return { certificate: 'not a certificate', privateKey: 'not a key' }
}

/** Writes a pair where the store looks for it, without going through the API. */
function writePair(tlsDir: string, id: string, pair: { certificate: string, privateKey: string }): void {
  fs.mkdirSync(tlsDir, { recursive: true })
  fs.writeFileSync(path.join(tlsDir, `${id}.crt.pem`), pair.certificate)
  fs.writeFileSync(path.join(tlsDir, `${id}.key.pem`), pair.privateKey)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-proxy-'))
  dirs.push(dir)
  return dir
}

/**
 * Skips the real listener preflight for a test that is about what happens *after* it.
 * The preflight binds/asks about real ports, so a test that does not care about them
 * must not depend on 80/443 — or on any port — being free on the machine running it.
 * `vi.restoreAllMocks()` in `afterEach` puts the original back.
 */
function stubPortPreflight(): void {
  vi.spyOn(ProxyService.prototype as unknown as { assertPortsFree: () => Promise<void> }, 'assertPortsFree')
    .mockResolvedValue(undefined)
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
  /**
   * Makes the nanny spawn fail, the way a moved `process.execPath` or an exhausted fd
   * table does. Returns the restored property, so the failure lasts exactly one call.
   */
  breakNannySpawn: () => () => void
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
    challengeAuthPath: path.join(dir, 'state', 'challenge.json'),
    logDir: path.join(dir, 'logs'),
    tlsDir: path.join(dir, 'tls'),
    control: () => ({ host: 'local', port: 3999, bindHost: '127.0.0.1', url: 'http://127.0.0.1:3999', protocol: 'http' }),
    resolveServer: () => null,
    exposureBlocked: () => null,
    onStateChange: () => undefined,
    ...overrides,
  }
  // The defaults stay fast at every point where `start()` would otherwise wait on a
  // real engine; the port preflight stays real, and the tests that want it relaxed say so.
  options.waitReady = overrides.waitReady ?? (async () => false)
  options.chooseAdmin = overrides.chooseAdmin ?? (async () => ({ kind: 'unix', path: path.join(dir, 'state', 'admin.sock') }))

  return {
    service: new ProxyService(options),
    settings,
    dir,
    options,
    breakNannySpawn: () => {
      // The spawn itself still has to fail for real: `spawn` resolves the error
      // asynchronously, which is what emits 'error' rather than 'exit'.
      const saved = process.execPath
      Object.defineProperty(process, 'execPath', {
        value: path.join(dir, 'gone-node'),
        configurable: true,
        writable: true,
      })
      return () => Object.defineProperty(process, 'execPath', { value: saved, configurable: true, writable: true })
    },
  }
}

/**
 * A stand-in engine: a real executable that answers `version` and `list-modules`,
 * and records every run beside itself. The panel spawns it for real, so nothing
 * here has to mock `node:child_process`.
 */
/**
 * A stand-in engine: a shell script, so it is spawnable on Linux and macOS but not on
 * Windows. Tests that merely need `installed()` to be true use it anywhere; the ones
 * that actually run it are marked `spawnsStubEngine` below.
 */
function writeStubEngine(enginePath: string, modules: string[]): void {
  const log = path.join(path.dirname(enginePath), 'runs.log')
  fs.mkdirSync(path.dirname(enginePath), { recursive: true })
  const list = modules.map(name => `${name}\n`).join('')
  fs.writeFileSync(enginePath, [
    '#!/bin/sh',
    `echo "$1" >> "${log}"`,
    'if [ "$1" = "version" ]; then echo "v2.11.4 h1:stub"; fi',
    `if [ "$1" = "list-modules" ]; then printf '${list}'; fi`,
    'exit 0',
    '',
  ].join('\n'))
  fs.chmodSync(enginePath, 0o755)
}

describe('dNS-01 policy grouping', () => {
  function upstream(host: string, tls: 'auto' | 'off' | 'manual' = 'auto') {
    return { host, path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls, certificateReady: true }
  }

  const accounts: Record<string, { workspaceId: string, accountId: string, provider: string }> = {
    'git.example.com': { workspaceId: 'default', accountId: 'cf', provider: 'cloudflare' },
    'media.example.com': { workspaceId: 'default', accountId: 'cf', provider: 'cloudflare' },
    'vault.example.net': { workspaceId: 'default', accountId: 'r53', provider: 'route53' },
  }
  const accountFor = (host: string) => accounts[host] ?? null

  it('gives names that share an account one policy', () => {
    const policies = groupDns01Policies(
      [upstream('git.example.com'), upstream('media.example.com'), upstream('vault.example.net')],
      accountFor,
    )

    expect(policies).toEqual([
      { account: 'default/cf', provider: 'cloudflare', subjects: ['git.example.com', 'media.example.com'] },
      { account: 'default/r53', provider: 'route53', subjects: ['vault.example.net'] },
    ])
  })

  it('leaves out the names no account answers, and the ones not on automatic TLS', () => {
    const policies = groupDns01Policies(
      [upstream('git.example.com'), upstream('plain.example.com'), upstream('manual.example.com', 'manual'), upstream('off.example.com', 'off')],
      accountFor,
    )

    expect(policies).toEqual([{ account: 'default/cf', provider: 'cloudflare', subjects: ['git.example.com'] }])
  })

  it('is empty when nothing is answered', () => {
    expect(groupDns01Policies([upstream('nothing.example.com')], accountFor)).toEqual([])
  })
})

/**
 * Two live processes that ignore SIGTERM, standing in for a nanny and its child. Each
 * writes its pid only after the handler is installed, so a stop cannot race the spawn
 * and reach a process that still dies on the default action.
 */
async function twoStubbornProcesses(dir: string): Promise<{ pids: number[], stop: () => void }> {
  const launch = (name: string): number => {
    const pidFile = path.join(dir, name)
    const script = [
      'process.on("SIGTERM", () => {})',
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    return child.pid!
  }
  const pids = [launch('nanny.pid'), launch('child.pid')]
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !['nanny.pid', 'child.pid'].every(name => fs.existsSync(path.join(dir, name))))
    await new Promise(resolve => setTimeout(resolve, 25))

  return {
    pids,
    stop: () => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        }
        catch {
          // Already dead.
        }
      }
    },
  }
}

/**
 * An engine that never answers. `exec` replaces the shell, so the kill reaches the
 * process that is actually sleeping.
 */
function writeHangingEngine(enginePath: string): void {
  fs.mkdirSync(path.dirname(enginePath), { recursive: true })
  fs.writeFileSync(enginePath, '#!/bin/sh\nexec sleep 30\n')
  fs.chmodSync(enginePath, 0o755)
}

/**
 * An engine that ignores SIGTERM and never answers, so only SIGKILL ends it. Writes
 * its own pid where the test can read it.
 */
function writeStubbornEngine(enginePath: string): string {
  const pidFile = path.join(path.dirname(enginePath), 'stubborn.pid')
  fs.mkdirSync(path.dirname(enginePath), { recursive: true })
  fs.writeFileSync(enginePath, [
    '#!/bin/sh',
    'trap "" TERM',
    `echo $$ > "${pidFile}"`,
    'while :; do sleep 1; done',
    '',
  ].join('\n'))
  fs.chmodSync(enginePath, 0o755)
  return pidFile
}

/** Waits for a pid file written by a just-spawned stub engine. */
async function waitForPid(pidFile: string): Promise<number | null> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
      if (Number.isInteger(pid) && pid > 0)
        return pid
    }
    catch {
      // Not written yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return null
}

/** For the tests that spawn that script rather than just placing it. */
const spawnsStubEngine = it.runIf(process.platform !== 'win32')

describe('which account answers a challenge', () => {
  /** The panel's one usable account, named by no route. */
  const single = {
    listDnsAccounts: () => [{ workspace: 'default', account: 'cf', provider: 'cloudflare', label: '', writesTxt: true, hasCredentials: true }],
    resolveDnsAccount: () => ({ provider: 'cloudflare', credentials: { apiToken: 'tok' } }),
    defaultWorkspaceId: () => 'default',
  }
  const route = (host: string, dnsAccount = '') =>
    ({ id: 'r', host, target: 'external' as const, url: 'http://10.0.0.5:3000', dnsAccount })

  it('uses the panel’s only usable account when no route names one', async () => {
    // Without this the challenge block was never generated and a public name sat on
    // "waiting for the CA" forever, because Caddy fell back to HTTP-01.
    const { service, settings } = await harness(single)
    settings.updateProxy({ dns01: { enabled: true }, routes: [route('git.example.com')] })

    expect(service.challengeAccount('_acme-challenge.git.example.com.')).toMatchObject({ workspaceId: 'default', accountId: 'cf' })
  })

  it('refuses to guess between two accounts', async () => {
    const { service, settings } = await harness({
      ...single,
      listDnsAccounts: () => [
        { workspace: 'default', account: 'cf', provider: 'cloudflare', label: '', writesTxt: true, hasCredentials: true },
        { workspace: 'default', account: 'do', provider: 'digitalocean', label: '', writesTxt: true, hasCredentials: true },
      ],
    })
    settings.updateProxy({ dns01: { enabled: true }, routes: [route('git.example.com')] })

    expect(service.challengeAccount('_acme-challenge.git.example.com.')).toBeNull()
  })

  it('never answers for a local-only name', async () => {
    // A loopback or `.lan` name is signed by the engine's own CA. Answering would
    // write a bogus TXT record, and listing it made Caddy attempt ACME for an IP.
    const { service, settings } = await harness(single)
    settings.updateProxy({ dns01: { enabled: true }, routes: [route('gitea.lan'), route('127.0.0.1')] })

    expect(service.challengeAccount('_acme-challenge.gitea.lan.')).toBeNull()
    expect(service.challengeAccount('_acme-challenge.127.0.0.1.')).toBeNull()
  })

  it('leaves a local-only name out of the DNS-01 policy', () => {
    const policies = groupDns01Policies(
      [
        { host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto', certificateReady: true },
        { host: 'gitea.lan', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto', certificateReady: true },
        { host: '127.0.0.1', path: '', dial: '127.0.0.1:6010', upstreamTls: false, tls: 'auto', certificateReady: true },
      ],
      () => ({ workspaceId: 'default', accountId: 'cf', provider: 'cloudflare' }),
    )

    expect(policies).toEqual([{ account: 'default/cf', provider: 'cloudflare', subjects: ['git.example.com'] }])
  })
})

/**
 * A stand-in engine: a live process the panel could stop (if it ever tried), and an
 * admin endpoint that records every configuration handed to it.
 */
/**
 * A stand-in for the engine's admin endpoint.
 *
 * `reject` makes `/load` answer the way a real engine does for a configuration it will not
 * accept, which is the only way to reach the refusal handling — the default stub always
 * accepts, so nothing exercised that path's `lastError`.
 */
async function stubEngine(options: ProxyServiceOptions, reject?: { status: number, message: string }): Promise<{ loads: any[], pid: number, stop: () => Promise<void> }> {
  const engine = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const loads: any[] = []
  const admin = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => body += chunk)
    request.on('end', () => {
      loads.push(JSON.parse(body))
      if (reject !== undefined) {
        response.writeHead(reject.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: reject.message }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>(resolve => admin.listen(0, '127.0.0.1', resolve))
  const port = (admin.address() as AddressInfo).port

  fs.mkdirSync(options.stateDir, { recursive: true })
  fs.writeFileSync(options.adminPath, JSON.stringify({ kind: 'tcp', host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}` }))
  writeNannyState(nannyStatePath(options.stateDir, 'proxy'), {
    serverId: 'proxy',
    nannyPid: engine.pid!,
    childPid: engine.pid!,
    startedAt: Date.now(),
    logFile: '',
    heartbeatAt: Date.now(),
  })

  return {
    loads,
    pid: engine.pid!,
    async stop() {
      engine.kill('SIGKILL')
      await new Promise<void>(resolve => admin.close(() => resolve()))
    },
  }
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

  it('reads `/app` and `/app/` as the same path', () => {
    // The two render overlapping matchers, so one silently shadows the other.
    const overlapping = config({
      routes: [
        { id: 'a', host: 'app.example.com', path: '/app' },
        { id: 'b', host: 'app.example.com', path: '/app/' },
      ],
    })
    expect(validateProxyConfig(overlapping)).toContain('"app.example.com" is routed twice')
  })

  /**
   * A foreign scheme is a mistake, not a hostname.
   *
   * `ftp://x.com` used to fall through the "no http(s) prefix, so add one" branch and become
   * `http://ftp://x.com`, which parses: hostname `ftp`, dial target `ftp:80`. The route then reported
   * `status: 'ok'` and the engine was handed a nonsense upstream, with nothing said.
   */
  it('refuses an upstream whose scheme is neither http nor https', () => {
    // A `.lan` host, so the public-name rules (an ACME address) stay out of the way.
    const forUrl = (url: string) => validateProxyConfig(config({ routes: [{ id: 'a', host: 'app.lan', target: 'external', url }] }))

    for (const url of ['ftp://x.com', 'file:///etc/passwd', 'gopher://h.com'])
      expect(forUrl(url), url).toContain('route "a" needs an upstream like http://10.0.0.5:8080')

    // The forms a person actually types still work.
    for (const url of ['http://10.0.0.5:8080', 'https://example.com', '10.0.0.5:8080', 'example.com'])
      expect(forUrl(url), url).toEqual([])
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

  it('checks a named DNS account before the save, not at issuance', () => {
    const withAccount = (dnsAccount: string) => config({
      email: 'me@example.com',
      dns01: { enabled: true },
      routes: [{ id: 'a', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000', dnsAccount }],
    })
    const account = (found: { provider: string, writesTxt: boolean, hasCredentials: boolean } | null) => () => found

    expect(validateProxyConfig(withAccount('cf'), account({ provider: 'cloudflare', writesTxt: true, hasCredentials: true }))).toEqual([])

    expect(validateProxyConfig(withAccount('nope'), account(null)))
      .toEqual(['route "a" names unknown DNS account "nope"'])

    // A router-style Dynamic DNS password cannot write a TXT record at all.
    expect(validateProxyConfig(withAccount('nc'), account({ provider: 'namecheap', writesTxt: false, hasCredentials: true })))
      .toEqual(['route "a": the "namecheap" account cannot write TXT records, so it cannot answer a DNS-01 challenge'])

    expect(validateProxyConfig(withAccount('cf'), account({ provider: 'cloudflare', writesTxt: true, hasCredentials: false })))
      .toEqual(['route "a": the "cloudflare" account has no credentials stored yet'])

    // A bare id belongs to the route's own workspace, not the panel default.
    const scoped = config({
      email: 'me@example.com',
      dns01: { enabled: true },
      routes: [{ id: 'a', host: 'git.example.com', target: 'server', workspace: 'lab', server: 'gitea', dnsAccount: 'cf' }],
    })
    const asked: string[] = []
    validateProxyConfig(scoped, (ref, workspaceId) => {
      asked.push(`${workspaceId}/${ref}`)
      return { provider: 'cloudflare', writesTxt: true, hasCredentials: true }
    })
    expect(asked).toEqual(['lab/cf'])

    // Naming an account while the feature is off is a config that would do nothing.
    const off = config({
      email: 'me@example.com',
      routes: [{ id: 'a', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000', dnsAccount: 'cf' }],
    })
    expect(validateProxyConfig(off, account({ provider: 'cloudflare', writesTxt: true, hasCredentials: true })))
      .toEqual(['route "a" names DNS account "cf", but DNS-01 is switched off'])
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
    // More than four octets is still dotted digits, not a registrable name — ACME was
    // attempted for it and could never succeed.
    expect(isPublicHost('1.2.3.4.5')).toBe(false)
  })

  it('reads an upstream as host:port, with or without a scheme', () => {
    expect(parseUpstream('127.0.0.1:8080')).toEqual({ dial: '127.0.0.1:8080', tls: false })
    expect(parseUpstream('http://10.0.0.5:3000')).toEqual({ dial: '10.0.0.5:3000', tls: false })
    expect(parseUpstream('https://srv.lan:8443')).toEqual({ dial: 'srv.lan:8443', tls: true })
    expect(parseUpstream(' 127.0.0.1:8080 ')).toEqual({ dial: '127.0.0.1:8080', tls: false })
    expect(parseUpstream('')).toBeNull()
    expect(parseUpstream('10.0.0.5')).toEqual({ dial: '10.0.0.5:80', tls: false })
    expect(parseUpstream('not a url')).toBeNull()
  })

  it('keeps the scheme’s default port, which URL normalizes away', () => {
    // `new URL('http://10.0.0.5:80').port` is `''`, so the default port read as "no
    // port" and a usable upstream was refused — and one such route made render()
    // throw PROXY_ROUTE_INVALID for the whole table, blocking every apply and start.
    expect(parseUpstream('http://10.0.0.5:80')).toEqual({ dial: '10.0.0.5:80', tls: false })
    expect(parseUpstream('10.0.0.5:80')).toEqual({ dial: '10.0.0.5:80', tls: false })
    expect(parseUpstream('https://srv.lan:443')).toEqual({ dial: 'srv.lan:443', tls: true })
    // A non-default port on the other scheme is not normalized, and stays as typed.
    expect(parseUpstream('https://srv.lan:80')).toEqual({ dial: 'srv.lan:80', tls: true })
    expect(parseUpstream('http://srv.lan:443')).toEqual({ dial: 'srv.lan:443', tls: false })
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
    // The name the panel would install, so this holds on Windows too.
    fs.writeFileSync(service.enginePath, 'not really a binary')
    fs.writeFileSync(path.join(options.binDir, 'engine.json'), JSON.stringify({
      engine: 'caddy',
      version: '2.11.4',
      source: 'downloaded',
      url: 'https://example.test/caddy',
      bytes: 12,
      installedAt: 1,
    }))

    expect(service.installed()).toBe(true)
    expect(service.engineStatus()).toMatchObject({ installed: true, version: '2.11.4', source: 'downloaded', bytes: 12 })
  })

  it('still reads a record an older release stamped with a checksum', async () => {
    const { service, options } = await harness()
    fs.mkdirSync(options.binDir, { recursive: true })
    fs.writeFileSync(service.enginePath, 'not really a binary')
    fs.writeFileSync(path.join(options.binDir, 'engine.json'), JSON.stringify({
      engine: 'caddy',
      version: '2.11.4',
      source: 'downloaded',
      url: 'https://example.test/caddy',
      sha256: 'abc',
      bytes: 12,
      installedAt: 1,
    }))

    // The dropped key must not turn the record into an unreadable one.
    expect(service.engineStatus()).toMatchObject({ installed: true, version: '2.11.4', source: 'downloaded', bytes: 12 })
  })

  it('says the checksum was dropped once, not on every state frame', async () => {
    const { service, options } = await harness()
    fs.mkdirSync(options.binDir, { recursive: true })
    fs.writeFileSync(service.enginePath, 'not really a binary')
    fs.writeFileSync(path.join(options.binDir, 'engine.json'), JSON.stringify({
      engine: 'caddy',
      version: '2.11.4',
      source: 'downloaded',
      url: 'https://example.test/caddy',
      sha256: 'abc',
      bytes: 12,
      installedAt: 1,
    }))

    // `engineStatus()` runs on every state read, so a warning per call would bury
    // the log the moment an older engine.json is on disk.
    const warnings: string[] = []
    const savedWarn = logger.warn
    logger.warn = ((...args: unknown[]) => { warnings.push(String(args[0])) }) as typeof logger.warn
    try {
      service.engineStatus()
      service.engineStatus()
      service.view()
    }
    finally {
      logger.warn = savedWarn
    }

    expect(warnings.filter(line => line.includes('engine checksum'))).toHaveLength(1)
  })

  it('installs over an engine that is only recorded as failed', async () => {
    // The trap: a state file left by a nanny that is gone made the panel read "error",
    // the install guard refused on that display state, and there was no way to update.
    const { service, options, settings } = await harness()
    settings.updateProxy({ enabled: true })
    fs.mkdirSync(options.stateDir, { recursive: true })
    writeNannyState(nannyStatePath(options.stateDir, 'proxy'), {
      serverId: 'proxy',
      nannyPid: 999_999,
      childPid: 999_998,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now(),
    })
    // Stop at the download: getting that far proves the guard let it through.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))

    await expect(service.install()).rejects.toMatchObject({ code: 'ENGINE_DOWNLOAD_FAILED' })
  })

  it('still refuses while a child outlived its nanny', async () => {
    // `live()` is false there — the heartbeat is gone — but the binary is in use, so
    // replacing it on disk is exactly what must not happen.
    const { service, options, settings } = await harness()
    settings.updateProxy({ enabled: true })
    fs.mkdirSync(options.stateDir, { recursive: true })
    writeNannyState(nannyStatePath(options.stateDir, 'proxy'), {
      serverId: 'proxy',
      nannyPid: 999_999,
      childPid: process.pid,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now(),
    })

    await expect(service.install()).rejects.toMatchObject({ code: 'ENGINE_BUSY' })
  })

  it('refuses to install over an engine that is up', async () => {
    const { service, options, settings } = await harness()
    settings.updateProxy({ enabled: true })
    // An engine cannot be up without being installed, and `status()` says so before it
    // looks at the nanny at all — so this stands in for the binary rather than writing one.
    const realStatSync = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (target === service.enginePath)
        return { isFile: () => true, size: 1 }
      return realStatSync(target, options as never)
    }) as typeof fs.statSync)
    fs.mkdirSync(options.stateDir, { recursive: true })
    writeNannyState(nannyStatePath(options.stateDir, 'proxy'), {
      serverId: 'proxy',
      nannyPid: process.pid,
      childPid: process.pid,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now(),
    })

    await expect(service.install()).rejects.toMatchObject({ code: 'ENGINE_BUSY', statusCode: 409 })
  })

  it('calls a binary we did not install our own, and reads a garbled record as absent', async () => {
    const { service, options } = await harness()
    fs.mkdirSync(options.binDir, { recursive: true })
    fs.writeFileSync(service.enginePath, 'x')
    fs.writeFileSync(path.join(options.binDir, 'engine.json'), '{ not json')

    expect(service.engineStatus()).toMatchObject({ installed: true, source: 'custom', version: null })
  })

  spawnsStubEngine('reads the modules an installed binary carries, and only asks once', async () => {
    const { service, options } = await harness()
    writeStubEngine(service.enginePath, ['dns.providers.acmeproxy', 'http.handlers.reverse_proxy'])

    const modules = await service.installedModules()
    expect([...(modules ?? [])]).toEqual(['dns.providers.acmeproxy', 'http.handlers.reverse_proxy'])
    // A second read is answered from the process, not by running the binary again.
    const again = await service.installedModules()
    expect(again).toBe(modules)
    expect(fs.readFileSync(path.join(options.binDir, 'runs.log'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  spawnsStubEngine('refuses to start DNS-01 on a build that has no ACMEProxy module', async () => {
    const { service, settings } = await harness()
    writeStubEngine(service.enginePath, ['http.handlers.reverse_proxy'])
    settings.updateProxy({ enabled: true, dns01: { enabled: true } })

    await expect(service.start()).rejects.toMatchObject({ code: 'ENGINE_MODULE_NOT_INSTALLED', statusCode: 400 })
  })

  spawnsStubEngine('gives up on an engine that never answers instead of hanging', async () => {
    const { service } = await harness({ engineCommandTimeoutMs: 60 })
    writeHangingEngine(service.enginePath)

    // A replaced or wrapped binary that never exits must not hang `start()` or the
    // request that triggered the probe.
    await expect(service.probeEngineVersion()).resolves.toBeNull()
    await expect(service.installedModules()).resolves.toBeNull()
  })

  spawnsStubEngine('kills an engine that ignores SIGTERM, instead of leaving it running', async () => {
    // `exec sleep 30` dies on the polite SIGTERM, so the old test never saw this: the
    // escalation was scheduled and then cancelled in the same tick by the `finish()`
    // that resolved the probe, leaving the pathological engine alive and another one
    // spawned on every later probe.
    const { service } = await harness({ engineCommandTimeoutMs: 150 })
    const pidFile = writeStubbornEngine(service.enginePath)

    await expect(service.probeEngineVersion()).resolves.toBeNull()
    const pid = await waitForPid(pidFile)
    expect(pid).not.toBeNull()

    try {
      // SIGKILL is scheduled 500 ms after the timeout: wait it out, then check.
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && isProcessAlive(pid!))
        await new Promise(resolve => setTimeout(resolve, 100))
      expect(isProcessAlive(pid!)).toBe(false)
    }
    finally {
      try {
        process.kill(pid!, 'SIGKILL')
      }
      catch {
        // Already dead, which is the point.
      }
    }
  })

  it('does not ask for the module when DNS-01 is off', async () => {
    const { service, options, settings } = await harness()
    writeStubEngine(service.enginePath, ['http.handlers.reverse_proxy'])
    // A port something else holds, so the start fails at the preflight instead of
    // waiting out the readiness timeout.
    const held = net.createServer()
    await new Promise<void>(resolve => held.listen(0, '127.0.0.1', resolve))
    const port = (held.address() as net.AddressInfo).port
    held.unref()
    try {
      settings.updateProxy({ enabled: true, httpPort: port, httpsPort: 1 })

      // It gets past the module guard and fails on the port instead — the point is
      // that a stock build is never refused for a feature nobody switched on.
      await expect(service.start()).rejects.toMatchObject({ code: 'PROXY_PORT_IN_USE' })
      const runs = fs.existsSync(path.join(options.binDir, 'runs.log'))
        ? fs.readFileSync(path.join(options.binDir, 'runs.log'), 'utf8')
        : ''
      expect(runs).not.toContain('list-modules')
    }
    finally {
      await new Promise<void>(resolve => held.close(() => resolve()))
    }
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

  it('refuses `/app` and `/app/` on one host, which would shadow each other', async () => {
    const { service, settings } = await harness()
    settings.updateProxy({
      routes: [
        { id: 'a', host: 'same.example.com', path: '/app', target: 'external', url: 'http://10.0.0.5:1' },
        { id: 'b', host: 'same.example.com', path: '/app/', target: 'external', url: 'http://10.0.0.5:2' },
      ],
    })
    const blocked = service.routeViews().find(view => view.status === 'error')
    expect(blocked?.route.id).toBe('b')
    expect(blocked?.message).toContain('routed twice')
  })

  it('routes an upstream on the scheme’s default port, and does not block the table', async () => {
    // One route on :80 used to read as invalid, and render() throws PROXY_ROUTE_INVALID
    // for the whole table on a single bad route — every apply and start was blocked.
    // No listener is bound here: the bug is about the renderer, and a real preflight
    // against :80/:443 would make this test depend on the host those ports are on.
    const { service, settings } = await harness()
    settings.updateProxy({
      enabled: true,
      httpPort: 4480,
      httpsPort: 4443,
      routes: [
        { id: 'plain', host: 'plain.example.com', target: 'external', url: 'http://10.0.0.5:80' },
        { id: 'secure', host: 'secure.example.com', target: 'external', url: 'https://10.0.0.6:443' },
      ],
    })

    const views = service.routeViews()
    expect(views.map(view => [view.status, view.upstream])).toEqual([
      ['ok', '10.0.0.5:80'],
      ['ok', '10.0.0.6:443'],
    ])
    // The same guard `apply()` and `start()` go through, with nothing to listen on:
    // a table with an unusable route used to make this throw for all of it.
    expect(() => (service as unknown as { render: () => unknown }).render()).not.toThrow()
  })

  it('is off, then stopped with a reason once it is switched on without an engine', async () => {
    const { service, settings } = await harness()
    expect(service.status()).toMatchObject({ state: 'off', lastError: null })

    settings.updateProxy({ enabled: true })
    expect(service.status()).toMatchObject({ state: 'stopped', lastError: 'the proxy engine is not installed', urls: ['http://127.0.0.1:80', 'https://127.0.0.1:443'] })

    settings.updateProxy({ httpPort: 4480, httpsPort: 4443 })
    expect(service.status().urls).toEqual(['http://127.0.0.1:4480', 'https://127.0.0.1:4443'])
  })

  it('writes the settings a patch asks for, through the store', async () => {
    const { service, settings } = await harness()
    service.update({ enabled: true, httpPort: 4480, httpsPort: 4443, email: 'me@example.com' })

    expect(settings.proxy).toMatchObject({ enabled: true, httpPort: 4480, httpsPort: 4443, email: 'me@example.com' })
    expect(service.view().config.httpPort).toBe(4480)
  })

  it('merges a partial DNS-01 patch instead of resetting the group', async () => {
    const { settings } = await harness()
    settings.updateProxy({ dns01: { enabled: true, resolvers: ['1.1.1.1'] } })

    // A client that only toggles the switch must not lose the resolvers it never
    // mentioned — the same rule every other nested group follows.
    settings.updateProxy({ dns01: { enabled: false } })
    expect(settings.proxy.dns01).toEqual({ enabled: false, resolvers: ['1.1.1.1'] })

    // An explicit null clears one key back to its schema default.
    settings.updateProxy({ dns01: { resolvers: null } })
    expect(settings.proxy.dns01).toEqual({ enabled: false, resolvers: [] })
  })

  it('drops the engine certificate for one name, and nothing else', async () => {
    const { service, options, settings } = await harness()
    writeStubEngine(service.enginePath, ['dns.providers.acmeproxy'])
    settings.updateProxy({
      enabled: true,
      routes: [
        { id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' },
        { id: 'media', host: 'media.example.com', target: 'external', url: 'http://10.0.0.5:3001' },
      ],
    })
    // What the engine stores for a name, under one directory per issuer.
    const root = path.join(options.engineDir, 'data', 'certificates')
    for (const issuer of ['acme-v02.api.letsencrypt.org-directory', 'local']) {
      fs.mkdirSync(path.join(root, issuer, 'git.example.com'), { recursive: true })
      fs.writeFileSync(path.join(root, issuer, 'git.example.com', 'git.example.com.crt'), 'x')
      fs.mkdirSync(path.join(root, issuer, 'media.example.com'), { recursive: true })
    }

    await service.retryCertificate('git')

    // The next handshake re-obtains; the other name is untouched.
    expect(fs.existsSync(path.join(root, 'acme-v02.api.letsencrypt.org-directory', 'git.example.com'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'local', 'git.example.com'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'local', 'media.example.com'))).toBe(true)
  })

  it('retries without restarting the engine, by taking the name out and putting it back', async () => {
    const { service, options, settings } = await harness()
    writeStubEngine(service.enginePath, ['dns.providers.acmeproxy'])
    const engine = await stubEngine(options)
    const { loads } = engine

    try {
      settings.updateProxy({
        enabled: true,
        httpPort: 18080,
        httpsPort: 18443,
        routes: [
          { id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' },
          { id: 'media', host: 'media.example.com', target: 'external', url: 'http://10.0.0.5:3001' },
        ],
      })
      const root = path.join(options.engineDir, 'data', 'certificates', 'local')
      fs.mkdirSync(path.join(root, 'git.example.com'), { recursive: true })

      // Boot first: that is what adopts the running engine's admin record, and a
      // panel that has not done that reads the engine as merely starting.
      await service.initialize()
      const before = loads.length

      await service.retryCertificate('git')

      // Two reloads, and the first one leaves the name out — which is what makes the
      // engine let go of the certificate it was holding.
      const sent = loads.slice(before)
      expect(sent).toHaveLength(2)
      const hosts = (config: any): string[] => JSON.stringify(config.apps.http.servers.https.routes)
        .match(/git\.example\.com/g) ?? []
      expect(hosts(sent[0])).toHaveLength(0)
      expect(hosts(sent[1]!).length).toBeGreaterThan(0)
      // The other route is in both, and the engine process was never stopped.
      expect(JSON.stringify(sent[0])).toContain('media.example.com')
      // The engine was never stopped: the name left the configuration, not the process.
      expect(isProcessAlive(engine.pid)).toBe(true)
      expect(fs.existsSync(path.join(root, 'git.example.com'))).toBe(false)
    }
    finally {
      await engine.stop()
    }
  })

  it('drops certificates for names it no longer serves, and keeps the rest', async () => {
    const { service, options, settings } = await harness()
    writeStubEngine(service.enginePath, ['dns.providers.acmeproxy'])
    const engine = await stubEngine(options)

    try {
      const root = path.join(options.engineDir, 'data', 'certificates')
      const make = (issuer: string, host: string): string => {
        const dir = path.join(root, issuer, host)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, `${host}.crt`), 'x')
        return dir
      }
      // A removed route, a route that is only switched off, the engine's fallback
      // name, and a route still in use.
      const gone = make('acme-v02.api.letsencrypt.org-directory', 'gone.example.com')
      const disabled = make('acme-v02.api.letsencrypt.org-directory', 'off.example.com')
      const fallback = make('local', 'hh-fallback.invalid')
      const live = make('acme-v02.api.letsencrypt.org-directory', 'git.example.com')

      settings.updateProxy({
        enabled: true,
        httpPort: 18080,
        httpsPort: 18443,
        routes: [
          { id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' },
          { id: 'off', host: 'off.example.com', target: 'external', url: 'http://10.0.0.5:3001', enabled: false },
        ],
      })
      await service.initialize()
      await service.apply({ force: true })

      expect(fs.existsSync(gone)).toBe(false)
      expect(fs.existsSync(live)).toBe(true)
      // A disabled route is still configured: a temporary switch-off must not cost a
      // new issuance when it is switched back on.
      expect(fs.existsSync(disabled)).toBe(true)
      expect(fs.existsSync(fallback)).toBe(true)
    }
    finally {
      await engine.stop()
    }
  })

  it('refuses to retry a name no CA issues for, or one it does not know', async () => {
    const { service, settings } = await harness()
    writeStubEngine(service.enginePath, ['dns.providers.acmeproxy'])
    settings.updateProxy({
      enabled: true,
      routes: [
        { id: 'lan', host: 'gitea.lan', target: 'external', url: 'http://10.0.0.5:3000' },
        { id: 'off', host: 'plain.example.com', target: 'external', url: 'http://10.0.0.5:3001', tls: 'off' },
      ],
    })

    // A local name is signed by the engine's own CA, and a plain route has no
    // certificate at all: retrying either would restart the engine for nothing.
    await expect(service.retryCertificate('lan')).rejects.toMatchObject({ code: 'PROXY_CERT_NOT_MANAGED' })
    await expect(service.retryCertificate('off')).rejects.toMatchObject({ code: 'PROXY_CERT_NOT_MANAGED' })
    await expect(service.retryCertificate('ghost')).rejects.toMatchObject({ code: 'PROXY_ROUTE_UNKNOWN' })
  })

  /**
   * `status()` reports `lastError` as the proxy's state, so a configuration the engine refused
   * has to record it — otherwise the panel keeps describing a broken proxy as healthy.
   *
   * The retry path loaded its configuration through its own copy of the rejection handling
   * that never assigned `lastError`; the other two paths did. That is why the three are one
   * helper now, and why this drives `retryCertificate` rather than `apply`.
   */
  it('records the refusal when the engine rejects a configuration', async () => {
    const { service, options, settings } = await harness()
    writeStubEngine(service.enginePath, ['dns.providers.acmeproxy'])
    settings.updateProxy({
      enabled: true,
      httpPort: 18080,
      httpsPort: 18443,
      routes: [{ id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' }],
    })
    const engine = await stubEngine(options, { status: 400, message: 'not a valid configuration' })

    try {
      await service.initialize()

      await expect(service.retryCertificate('git')).rejects.toMatchObject({ code: 'PROXY_CONFIG_REJECTED' })

      const status = service.status()
      expect(status.lastError, 'a refused configuration was not recorded').toBeTruthy()
      expect(status.lastError).toContain('not a valid configuration')
      // The engine itself is alive, so `running` is right — what matters is the recorded error,
      // which the panel shows beside a running engine rather than instead of it.
      expect(status.state).toBe('running')
    }
    finally {
      await engine.stop()
    }
  })

  it('does not start anything for a config that is only switched off', async () => {
    const { service } = await harness()
    await expect(service.start()).rejects.toThrow('switched off')
    await expect(service.apply()).resolves.toBeUndefined()
  })

  it('kills every survivor of a stop, not just the first pid', async () => {
    // A nanny and a child that both ignore SIGTERM: killing only `pids.find(...)`
    // left the second one alive holding :80/:443, while the state file was removed
    // right after — a later boot had no record to stop it by.
    // A short grace: the escalation is what this test is about, not the 10s wait.
    const { service, options, dir } = await harness({ stopGraceMs: 300 })
    const stub = await twoStubbornProcesses(dir)
    fs.mkdirSync(options.stateDir, { recursive: true })
    writeNannyState(nannyStatePath(options.stateDir, 'proxy'), {
      serverId: 'proxy',
      nannyPid: stub.pids[0]!,
      childPid: stub.pids[1]!,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now(),
    })

    try {
      await service.stop()

      // The stop waited out its grace and then escalated, so both are dead — polled,
      // because a signalled process takes a moment to actually leave.
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && stub.pids.some(isProcessAlive))
        await new Promise(resolve => setTimeout(resolve, 50))
      for (const pid of stub.pids)
        expect(isProcessAlive(pid)).toBe(false)
    }
    finally {
      stub.stop()
    }
  })

  it('does not signal a pid a stale record names, which is somebody else by now', async () => {
    // `PROXY_ID` is the constant `proxy`, so any leftover `proxy.json` names pids this panel has
    // no handle on — and pids are recycled. `stop()` used to signal whatever those pids pointed at,
    // escalating to SIGKILL, so a stale record could kill an unrelated process. It asks the same
    // identity question the supervisor and `down` ask instead: a heartbeat newer than
    // `HEARTBEAT_STALE_MS`, the `HHOSTED_SERVER_ID` marker, or a nanny-shaped argv.
    const { service, options } = await harness({ stopGraceMs: 100 })
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const strangerPid = stranger.pid!
    fs.mkdirSync(options.stateDir, { recursive: true })
    writeNannyState(nannyStatePath(options.stateDir, 'proxy'), {
      serverId: 'proxy',
      nannyPid: strangerPid,
      childPid: strangerPid,
      startedAt: Date.now() - 3_600_000,
      logFile: '',
      // Stale on purpose: the nanny this record describes is long gone.
      heartbeatAt: Date.now() - 3_600_000,
    })

    try {
      await service.stop()
      expect(isProcessAlive(strangerPid), 'a stale record must not name a process that is not the engine').toBe(true)
      // Nothing the record named was ours, so it is stale garbage and goes: keeping it would make
      // `engineRunning()` report the engine busy on a recycled pid, and block the next install.
      expect(fs.existsSync(nannyStatePath(options.stateDir, 'proxy'))).toBe(false)
    }
    finally {
      try {
        process.kill(strangerPid, 'SIGKILL')
      }
      catch {
        // Already gone.
      }
    }
  })

  it('survives a nanny that cannot be spawned, and reads as a failure', async () => {
    // A spawn that never happens emits 'error' and no 'exit'. Without a handler that
    // event is an uncaught exception, and Node 24 ends the whole panel — which is what
    // an exhausted fd table (EMFILE/ENFILE), EACCES or a moved node binary produces.
    const { service, settings, options, breakNannySpawn } = await harness()
    writeStubEngine(service.enginePath, ['http.handlers.reverse_proxy'])
    // The nanny spawn is what this is about; the listener ports are not, and a real
    // preflight would make it depend on :80/:443 being free on the host.
    stubPortPreflight()
    settings.updateProxy({ enabled: true, httpPort: 4480, httpsPort: 4443 })
    // The real readiness poll, so this also proves it comes back the moment the nanny
    // is gone rather than waiting out the whole 20s deadline.
    delete options.waitReady

    const restore = breakNannySpawn()
    let failure: unknown
    try {
      failure = await service.start().then(() => null, (error: unknown) => error)
    }
    finally {
      restore()
    }

    // The start rejected with the spawn's own reason instead of the generic timeout:
    // `waitReady()` only comes back that fast because the nanny is already gone.
    expect((failure as { code?: string }).code).toBe('ENGINE_NOT_READY')
    expect((failure as Error).message).toContain('could not be started')
    // The nanny was never there, so no stale admin record is left to be reused.
    expect(fs.existsSync(options.adminPath)).toBe(false)
  })

  it('rejects a truncated admin answer instead of waiting for one that never ends', async () => {
    // The engine sends headers and half a body, then destroys the socket. With only
    // 'data' and 'end' on the response, the promise never settled at all — so apply(),
    // waitReady() and the panel tick's sync() awaited forever, and every later tick
    // started another stuck sync.
    const { service, options, settings } = await harness()
    writeStubEngine(service.enginePath, ['http.handlers.reverse_proxy'])
    // Only the admin request is under test; the listener preflight is not.
    stubPortPreflight()
    settings.updateProxy({ enabled: true, httpPort: 4480, httpsPort: 4443 })
    const admin = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"partial":')
      setTimeout(() => response.socket?.destroy(), 50)
    })
    await new Promise<void>(resolve => admin.listen(0, '127.0.0.1', resolve))
    const port = (admin.address() as AddressInfo).port
    fs.mkdirSync(options.stateDir, { recursive: true })
    fs.writeFileSync(options.adminPath, JSON.stringify({ kind: 'tcp', host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}` }))
    try {
      ;(service as unknown as { admin: unknown }).admin = { kind: 'tcp', host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}` }

      await expect(service.apply({ force: true })).rejects.toMatchObject({ code: 'ENGINE_UNREACHABLE' })
    }
    finally {
      await new Promise<void>(resolve => admin.close(() => resolve()))
    }
  })

  it.runIf(hasOpenssl)('calls a public name on the engine’s own CA a fallback, and says when it tries again', async () => {
    const { service, options, settings } = await harness()
    // What the engine leaves behind when the CA will not issue for a public name.
    const pair = makePair('git.example.com')
    const dir = path.join(options.engineDir, 'data', 'certificates', 'local', 'git.example.com')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'git.example.com.crt'), pair.certificate)
    settings.updateProxy({
      routes: [
        { id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' },
        // A local-only name is signed by that same CA on purpose, and is not a fallback.
        { id: 'lan', host: 'gitea.lan', target: 'external', url: 'http://10.0.0.5:3001' },
      ],
    })

    const views = service.routeViews()
    expect(views[0]?.certificate).toMatchObject({ state: 'fallback' })
    // certmagic renews once a third of the lifetime is left, so two thirds of the
    // three days this pair is valid for is the wait.
    expect(views[0]?.certificate?.retryInMinutes).toBe(2880)
    expect(views[1]?.certificate).toMatchObject({ state: 'local' })
    expect(views[1]?.certificate?.retryInMinutes).toBeUndefined()
  })

  it('keeps the CA’s reason when the engine falls back to its own CA', async () => {
    const { service, options, settings } = await harness()
    const pair = makePair('git.example.com')
    const dir = path.join(options.engineDir, 'data', 'certificates', 'local', 'git.example.com')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'git.example.com.crt'), pair.certificate)
    settings.updateProxy({ routes: [{ id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' }] })

    const line = (inner: Record<string, unknown>): string =>
      `${JSON.stringify({ ts: 1, stream: 'stderr', text: JSON.stringify(inner) })}\n`
    fs.mkdirSync(options.logDir, { recursive: true })
    fs.writeFileSync(path.join(options.logDir, 'proxy.log'), [
      line({ logger: 'tls.obtain', msg: 'could not get certificate from issuer', identifier: 'git.example.com', error: 'HTTP 400 urn:ietf:params:acme:error:rejectedIdentifier' }),
      // The fallback's own success must not read as the CA having recovered.
      line({ logger: 'tls.obtain', msg: 'certificate obtained successfully', identifier: 'git.example.com', issuer: 'local' }),
    ].join(''))

    expect(service.routeViews()[0]?.certificate?.message).toContain('rejectedIdentifier')

    // A real CA issuance does clear it.
    fs.appendFileSync(path.join(options.logDir, 'proxy.log'), line({ logger: 'tls.obtain', msg: 'certificate obtained successfully', identifier: 'git.example.com', issuer: 'acme-v02.api.letsencrypt.org-directory' }))
    expect(service.routeViews()[0]?.certificate?.message).not.toContain('rejectedIdentifier')
  })

  it.runIf(hasOpenssl)('refuses to serve a pair that expired in place, and says so', async () => {
    const { service, settings, options } = await harness()
    // The upload path rejects an already-expired pair; this is the one it cannot see —
    // a pair that was valid when stored and expired since, which is a matter of the
    // clock rather than of the file.
    writePair(options.tlsDir, 'old', makePair('old.example.com'))
    settings.updateProxy({
      certificates: [{ id: 'old', label: 'Old' }],
      routes: [{ id: 'h', host: 'old.example.com', target: 'external', url: 'http://10.0.0.5:1', tls: 'manual' }],
    })
    expect(service.routeViews()[0]?.status).toBe('ok')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2035-01-01T00:00:00Z'))
    try {
      const view = service.certificateViews()[0]
      expect(view).toMatchObject({ id: 'old', present: true, used: false })
      expect(view?.error).toContain('expired')

      const route = service.routeViews()[0]
      expect(route?.status).toBe('error')
      expect(route?.certificate?.state).toBe('failed')
      expect(route?.certificate?.message).toContain('expired')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it.runIf(hasOpenssl)('serves the usable pair, and marks the shadowed one unused', async () => {
    const { service, settings, options } = await harness()
    writePair(options.tlsDir, 'good', makePair('good.example.com'))
    writePair(options.tlsDir, 'old', brokenPair())
    // Same hostname on both, so only usability tells them apart.
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

  it.runIf(hasOpenssl)('reflects a route edit in `used` at once, not after the cache turns over', async () => {
    const { service, settings, options } = await harness()
    writePair(options.tlsDir, 'wild', makePair('*.example.com'))
    writePair(options.tlsDir, 'exact', makePair('special.example.com'))
    settings.updateProxy({ certificates: [{ id: 'wild', label: 'Wild' }, { id: 'exact', label: 'Exact' }] })
    // Nothing routes through them yet.
    expect(service.certificateViews().map(entry => entry.used)).toEqual([false, false])

    settings.updateProxy({
      routes: [
        { id: 'a', host: 'a.example.com', target: 'external', url: 'http://10.0.0.5:1', tls: 'manual' },
        { id: 's', host: 'special.example.com', target: 'external', url: 'http://10.0.0.5:1', tls: 'manual' },
      ],
    })
    // The wildcard serves the plain subdomain, the exact pair the specific name.
    expect(service.certificateViews().map(entry => [entry.id, entry.used])).toEqual([['wild', true], ['exact', true]])
  })

  it.runIf(hasOpenssl)('marks only one of two identical pairs as the one being served', async () => {
    const { service, settings, options } = await harness()
    writePair(options.tlsDir, 'wild', makePair('*.example.com'))
    writePair(options.tlsDir, 'exact', makePair('special.example.com'))
    writePair(options.tlsDir, 'copy', makePair('special.example.com'))
    settings.updateProxy({
      certificates: [{ id: 'wild', label: 'Wild' }, { id: 'exact', label: 'Exact' }, { id: 'copy', label: 'Copy' }],
      routes: [{ id: 's', host: 'special.example.com', target: 'external', url: 'http://10.0.0.5:1', tls: 'manual' }],
    })

    expect(service.certificateViews().map(entry => [entry.id, entry.used])).toEqual([
      ['wild', false],
      ['exact', true],
      ['copy', false],
    ])
  })

  it.runIf(hasOpenssl)('notices a stored pair that was replaced by an expired one', async () => {
    const { service, settings, options } = await harness()
    writePair(options.tlsDir, 'p', makePair('p.example.com'))
    settings.updateProxy({
      certificates: [{ id: 'p', label: 'P' }],
      routes: [{ id: 'r', host: 'p.example.com', target: 'external', url: 'http://10.0.0.5:1', tls: 'manual' }],
    })
    expect(service.routeViews()[0]?.status).toBe('ok')

    // Same id, same name, no longer readable — the kind of change only the file says.
    writePair(options.tlsDir, 'p', brokenPair())
    expect(service.certificateViews()[0]?.error).not.toBeNull()
    expect(service.routeViews()[0]?.status).toBe('error')
  })

  it('refuses a pair that is not a certificate, and stores none', async () => {
    const { service, settings } = await harness()
    // The same validator the panel's own TLS uses, so a bad pair never reaches disk.
    expect(service.saveCertificate('m', 'Mine', '', '').ok).toBe(false)
    expect(settings.proxy.certificates).toEqual([])
    expect(service.view().certificates).toEqual([])
  })
})

/**
 * The certificate-failure log is read once per route per state frame, so it is memoised.
 *
 * `obtainFailures()` reads the engine's log (bounded at 2 MB by rotation), splits every line
 * and keeps the last 400 — ~1.3 ms. `routeViews()` calls it **per route**, and `routeViews()`
 * runs in `view()` for every state frame and in `sync()` every tick, so ten routes meant ~13 ms
 * of blocking synchronous I/O per second for a file that changes only when the engine tries to
 * obtain a certificate.
 *
 * The test above already proves the cache is not stale after an append. These pin the other two
 * ways it could be wrong: an unchanged log must not be re-read, and a **rotated** log must be.
 */
describe('the failure-log cache', () => {
  const failureLine = (identifier: string, error: string): string =>
    `${JSON.stringify({ ts: 1, stream: 'stderr', text: JSON.stringify({ logger: 'tls.obtain', msg: 'could not get certificate from issuer', identifier, error }) })}\n`

  it('reads the log once while it is unchanged, and again once it moves', async () => {
    const { service, options, settings } = await harness()
    settings.updateProxy({ routes: [
      { id: 'a', host: 'a.example.com', target: 'external', url: 'http://10.0.0.5:3000' },
      { id: 'b', host: 'b.example.com', target: 'external', url: 'http://10.0.0.5:3001' },
    ] })
    fs.mkdirSync(options.logDir, { recursive: true })
    const logFile = path.join(options.logDir, 'proxy.log')
    fs.writeFileSync(logFile, failureLine('a.example.com', 'first failure'))

    const readSpy = vi.spyOn(fs, 'readFileSync')
    try {
      // Ten passes over two routes, with nothing written: the log is read once in total.
      for (let i = 0; i < 10; i++)
        service.routeViews()
      const logReads = readSpy.mock.calls.filter(([target]) => String(target) === logFile).length
      expect(logReads, `read the log ${logReads} times for an unchanged file`).toBe(1)

      // A change is seen immediately.
      fs.appendFileSync(logFile, failureLine('b.example.com', 'second failure'))
      const after = service.routeViews()
      expect(after.find(view => view.route.id === 'b')?.certificate?.message).toContain('second failure')
    }
    finally {
      readSpy.mockRestore()
    }
  })

  it('notices a rotation that replaces the file', async () => {
    // `up`/the nanny rotates to `.1` and starts a fresh log. A cache keyed on mtime alone can
    // serve the old content when the replacement lands in the same millisecond.
    const { service, options, settings } = await harness()
    settings.updateProxy({ routes: [{ id: 'a', host: 'a.example.com', target: 'external', url: 'http://10.0.0.5:3000' }] })
    fs.mkdirSync(options.logDir, { recursive: true })
    const logFile = path.join(options.logDir, 'proxy.log')
    fs.writeFileSync(logFile, failureLine('a.example.com', 'before rotation'))
    expect(service.routeViews()[0]?.certificate?.message).toContain('before rotation')

    // Rotate: the current file becomes `.1` and a fresh one carries the new reason.
    fs.renameSync(logFile, `${logFile}.1`)
    fs.writeFileSync(logFile, failureLine('a.example.com', 'after rotation'))

    expect(service.routeViews()[0]?.certificate?.message).toContain('after rotation')
  })
})
