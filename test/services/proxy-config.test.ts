import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { proxyEngine, proxyEngineInfos } from '#src/providers/proxy'
import { caddyEngine } from '#src/providers/proxy/caddy'
import { renderCaddyConfig } from '#src/services/proxy-config'
import { proxyConfigSchema, proxyRouteSchema } from '#src/shared/contracts'

function config(input: Record<string, unknown>) {
  const parsed = proxyConfigSchema({ enabled: true, ...input })
  if (parsed instanceof type.errors)
    throw parsed
  return parsed
}

function route(input: Record<string, unknown>) {
  const parsed = proxyRouteSchema(input)
  if (parsed instanceof type.errors)
    throw parsed
  return parsed
}

const unixAdmin = { kind: 'unix', path: '/tmp/hh/admin.sock' } as const

describe('caddy engine', () => {
  it('is the engine this build offers', () => {
    expect(proxyEngineInfos().map(engine => engine.id)).toEqual(['caddy'])
    expect(proxyEngine('caddy')).toBe(caddyEngine)
    expect(proxyEngine('nginx')).toBeNull()
    expect(caddyEngine.info.acme).toBe(true)
    // The stock binary ships no DNS provider module, so DNS-01 is a plugin build.
    expect(caddyEngine.info.dns01).toBe(false)
  })

  it('downloads a pinned release from the build service, with no plugin by default', () => {
    const pinned = caddyEngine.download({ platform: 'linux', arch: 'x64', version: '' })
    expect(pinned).toEqual({
      url: `https://caddyserver.com/api/download?os=linux&arch=amd64&version=${caddyEngine.pinnedVersion}`,
      version: caddyEngine.pinnedVersion,
    })

    const asked = caddyEngine.download({ platform: 'darwin', arch: 'arm64', version: '2.9.1' })
    expect(asked?.url).toContain('os=darwin&arch=arm64&version=2.9.1')
    expect(asked?.version).toBe('2.9.1')
    expect(asked?.url).not.toContain('&p=')
  })

  it('has no build for a platform or architecture it cannot serve', () => {
    expect(caddyEngine.download({ platform: 'aix', arch: 'x64', version: '' })).toBeNull()
    expect(caddyEngine.download({ platform: 'linux', arch: 'ppc64', version: '' })).toBeNull()
    expect(caddyEngine.download({ platform: 'win32', arch: 'x64', version: '' })?.url).toContain('os=win32&arch=amd64')
  })

  it('names the binary per platform and runs it without an adapter flag', () => {
    expect(caddyEngine.binaryName('win32')).toBe('hh-caddy.exe')
    expect(caddyEngine.binaryName('linux')).toBe('hh-caddy')
    // `--adapter json` is not a thing: the `.json` extension selects the adapter.
    expect(caddyEngine.runArgs({ configPath: '/tmp/c.json', engineDir: '/tmp', admin: unixAdmin })).toEqual(['run', '--config', '/tmp/c.json'])
  })

  it('keeps engine state inside our directory on every platform', () => {
    const env = caddyEngine.env({ configPath: '/tmp/c.json', engineDir: '/state', admin: unixAdmin })
    expect(env.XDG_DATA_HOME).toBe('/state/data')
    expect(env.XDG_CONFIG_HOME).toBe('/state/config')
    expect(env.APPDATA).toBe('/state/appdata')
  })

  it('reads the version out of what the binary prints', () => {
    expect(caddyEngine.parseVersion('v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=')).toBe('2.11.4')
    expect(caddyEngine.parseVersion('2.9.0\n')).toBe('2.9.0')
    expect(caddyEngine.parseVersion('not a version')).toBeNull()
  })
})

describe('renderCaddyConfig', () => {
  it('serves a route on both ports and redirects to the configured https port', () => {
    const rendered = renderCaddyConfig({
      config: config({ httpPort: 4480, httpsPort: 4443, email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: null,
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })

    const admin = rendered.admin as Record<string, unknown>
    expect(admin.listen).toBe('unix//tmp/hh/admin.sock')
    expect(admin.enforce_origin).toBeUndefined()
    expect((admin.config as Record<string, unknown>).persist).toBe(false)
    expect(rendered.storage).toEqual({ module: 'file_system', root: '/state/engine/data' })

    const http = (rendered.apps as any).http
    expect(http.http_port).toBe(4480)
    expect(http.https_port).toBe(4443)
    expect(http.servers.https.listen).toEqual([':4443'])
    expect(http.servers.https.routes[0].match[0]).toEqual({ host: ['git.example.com'] })
    expect(http.servers.https.routes[0].handle[0]).toEqual({ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:3000' }] })

    // The cleartext side keeps the ACME challenge listener and does our redirect.
    expect(http.servers.http.listen).toEqual([':4480'])
    expect(http.servers.http.automatic_https).toEqual({ disable_redirects: true, skip: [] })
    expect(http.servers.http.routes[0].handle[0].status_code).toBe(308)
    expect(http.servers.http.routes[0].handle[0].headers.Location).toEqual(['https://{http.request.host}:4443{http.request.uri}'])
  })

  it('omits the port from the redirect when it is the default one', () => {
    const rendered = renderCaddyConfig({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: null,
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.http.routes[0].handle[0].headers.Location).toEqual(['https://{http.request.host}{http.request.uri}'])
  })

  it('skips the https server for a host that asked for no TLS', () => {
    const rendered = renderCaddyConfig({
      config: config({}),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: null,
      routes: [{ host: 'plain.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'off' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.https).toBeUndefined()
    expect(http.servers.http.routes).toHaveLength(1)
    // A host we do not manage must not have a certificate attempted for it.
    expect(http.servers.http.automatic_https.skip).toEqual(['plain.example.com'])
    expect(http.servers.http.routes[0].handle[0].handler).toBe('reverse_proxy')
  })

  it('matches a path prefix with and without a trailing segment', () => {
    const rendered = renderCaddyConfig({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: null,
      routes: [{ host: 'app.example.com', path: 'gitea', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.https.routes[0].match[0].path).toEqual(['/gitea', '/gitea/*'])
  })

  it('verifies nothing on a local upstream that speaks TLS', () => {
    const rendered = renderCaddyConfig({
      config: config({}),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: null,
      routes: [{ host: 'panel.example.com', path: '', dial: '127.0.0.1:3999', upstreamTls: true, tls: 'auto' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.https.routes[0].handle[0].transport).toEqual({ protocol: 'http', tls: { insecure_skip_verify: true } })
  })

  it('loads the uploaded pair from disk instead of inlining a private key', () => {
    const rendered = renderCaddyConfig({
      config: config({}),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: { certificate: '/state/tls/proxy.crt.pem', key: '/state/tls/proxy.key.pem' },
      routes: [{ host: 'manual.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'manual' }],
    })
    expect((rendered.apps as any).tls).toEqual({
      certificates: { load_files: [{ certificate: '/state/tls/proxy.crt.pem', key: '/state/tls/proxy.key.pem' }] },
    })
  })

  it('asks a TCP admin endpoint for the origin its own check requires', () => {
    const rendered = renderCaddyConfig({
      config: config({}),
      admin: { kind: 'tcp', host: '127.0.0.1', port: 46_000, origin: 'http://127.0.0.1:46000' },
      engineDir: '/state/engine',
      manual: null,
      routes: [],
    })
    expect(rendered.admin).toEqual({
      config: { persist: false },
      listen: '127.0.0.1:46000',
      enforce_origin: true,
      origins: ['http://127.0.0.1:46000'],
    })
    // No routes means no listeners at all: nothing to serve, nothing to bind.
    expect((rendered.apps as any).http.servers).toEqual({})
  })
})

describe('proxy route schema', () => {
  it('defaults a route to a whole-host, automatically-TLS route', () => {
    expect(route({ id: 'a', host: 'a.example.com' })).toMatchObject({
      enabled: true,
      target: 'server',
      tls: 'auto',
      path: '',
    })
  })
})
