import type { ProxyConfigInput, ProxyUpstreamRoute } from '#src/services/proxy-config'
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

/**
 * The catch-all page is always the last route on each server, and the fallback
 * certificate's policy is always the last policy. Both are asserted on their own
 * below, so the routing cases here strip them.
 */
function routesOf(rendered: Record<string, unknown>, server: 'http' | 'https'): any[] {
  return ((rendered.apps as any).http.servers[server].routes as any[]).slice(0, -1)
}
function policiesOf(rendered: Record<string, unknown>): any[] {
  return ((rendered.apps as any).tls.automation.policies as any[]).slice(0, -1)
}

/** The renderer with the ACME account left out, for the cases that are not about it. */
type RouteInput = Omit<ProxyUpstreamRoute, 'certificateReady'> & { certificateReady?: boolean }

function render(input: Omit<ProxyConfigInput, 'acme' | 'routes'> & { acme?: ProxyConfigInput['acme'], routes: RouteInput[] }) {
  return renderCaddyConfig({
    acme: { email: '', staging: false, subjects: [] },
    ...input,
    // Most cases are about routing, not about a certificate that is still coming.
    routes: input.routes.map(route => ({ certificateReady: route.certificateReady ?? true, ...route })),
  })
}

describe('caddy engine', () => {
  it('is the engine this build offers', () => {
    expect(proxyEngineInfos().map(engine => engine.id)).toEqual(['caddy'])
    expect(proxyEngine('caddy')).toBe(caddyEngine)
    expect(proxyEngine('nginx')).toBeNull()
    expect(caddyEngine.info.acme).toBe(true)
    // The acmeproxy module is compiled in, so the engine can ask the panel to answer.
    expect(caddyEngine.info.dns01).toBe(true)
  })

  it('asks the build service for its current release, with the one module it needs', () => {
    // No `version`: that is how "whatever Caddy currently serves" is spelled, so a
    // security fix lands by pressing Update instead of waiting for a panel release.
    const current = caddyEngine.download({ platform: 'linux', arch: 'x64', version: '' })
    expect(current).toEqual({
      url: 'https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com%2Fcaddy-dns%2Facmeproxy',
      version: '',
    })
    expect(current?.url).not.toContain('version=')

    // A named release is still only a request, and the module travels with it.
    const asked = caddyEngine.download({ platform: 'darwin', arch: 'arm64', version: '2.9.1' })
    expect(asked?.url).toContain('os=darwin&arch=arm64&version=2.9.1')
    expect(asked?.version).toBe('2.9.1')
    expect(asked?.url).toContain('&p=github.com%2Fcaddy-dns%2Facmeproxy')
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
    const rendered = render({
      config: config({ httpPort: 4480, httpsPort: 4443, email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
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
    const rendered = render({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.http.routes[0].handle[0].headers.Location).toEqual(['https://{http.request.host}{http.request.uri}'])
  })

  it('skips the https server for a host that asked for no TLS', () => {
    const rendered = render({
      config: config({}),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      routes: [{ host: 'plain.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'off' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.https).toBeUndefined()
    // The catch-all is the second route; the reverse proxy is the first.
    expect(http.servers.http.routes).toHaveLength(2)
    // A host we do not manage must not have a certificate attempted for it.
    expect(http.servers.http.automatic_https.skip).toEqual(['plain.example.com'])
    expect(http.servers.http.routes[0].handle[0].handler).toBe('reverse_proxy')
  })

  it('matches a path prefix with and without a trailing segment', () => {
    const rendered = render({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      routes: [{ host: 'app.example.com', path: 'gitea', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.https.routes[0].match[0].path).toEqual(['/gitea', '/gitea/*'])
  })

  it('verifies nothing on a local upstream that speaks TLS', () => {
    const rendered = render({
      config: config({}),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      routes: [{ host: 'panel.example.com', path: '', dial: '127.0.0.1:3999', upstreamTls: true, tls: 'auto' }],
    })
    const http = (rendered.apps as any).http
    expect(http.servers.https.routes[0].handle[0].transport).toEqual({ protocol: 'http', tls: { insecure_skip_verify: true } })
  })

  it('points the public names at an ACME account', () => {
    const rendered = render({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com'] },
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })

    const automation = (rendered.apps as any).tls.automation
    expect(policiesOf(rendered)).toHaveLength(1)
    expect(automation.policies[0].subjects).toEqual(['git.example.com'])
    // The address reaches the issuer, and supplying it does not cost ZeroSSL.
    // The contact goes on the ACME issuer; the engine's own CA is the last resort, so
    // a certificate that has not arrived yet is a warning instead of a dead handshake.
    expect(automation.policies[0].issuers).toEqual([
      { module: 'acme', email: 'me@example.com' },
      { module: 'internal' },
    ])
  })

  it('answers the challenge through the panel when DNS-01 is on', () => {
    const rendered = render({
      config: config({ email: 'me@example.com', dns01: { enabled: true, resolvers: ['1.1.1.1'] } }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com'] },
      dns01: {
        resolvers: ['1.1.1.1'],
        endpoint: 'http://127.0.0.1:3999/_acme',
        username: 'hh',
        password: 'secret',
        policies: [{ account: 'default/cf', provider: 'cloudflare', subjects: ['git.example.com'] }],
      },
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })

    const policies = policiesOf(rendered)
    expect(policies).toHaveLength(1)
    expect(policies[0].subjects).toEqual(['git.example.com'])
    const issuers = policies[0].issuers
    // The panel answers the challenge; the engine holds no DNS credentials of its own.
    expect(issuers[0].challenges.dns.provider).toEqual({
      name: 'acmeproxy',
      endpoint: 'http://127.0.0.1:3999/_acme',
      username: 'hh',
      password: 'secret',
    })
    expect(issuers[0].challenges.dns.resolvers).toEqual(['1.1.1.1'])
    // The engine's own CA stays the last resort.
    expect(issuers[1]).toEqual({ module: 'internal' })
  })

  it('gives each account a policy of its own', () => {
    const rendered = render({
      config: config({ email: 'me@example.com', dns01: { enabled: true } }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com', 'vault.example.net'] },
      dns01: {
        resolvers: [],
        endpoint: 'http://127.0.0.1:3999/_acme',
        username: 'hh',
        password: 'secret',
        policies: [
          { account: 'default/cf', provider: 'cloudflare', subjects: ['git.example.com'] },
          { account: 'default/r53', provider: 'route53', subjects: ['vault.example.net'] },
        ],
      },
      routes: [
        { host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' },
        { host: 'vault.example.net', path: '', dial: '127.0.0.1:8200', upstreamTls: false, tls: 'auto' },
      ],
    })

    // One policy per account: an engine policy carries one challenge provider, so two
    // zones at two registrars cannot share one.
    const policies = policiesOf(rendered)
    expect(policies).toHaveLength(2)
    expect(policies.map((policy: any) => policy.subjects)).toEqual([['git.example.com'], ['vault.example.net']])
    for (const policy of policies)
      expect(policy.issuers[0].challenges.dns.provider.name).toBe('acmeproxy')
  })

  it('keeps a name that is not on DNS-01 on the port challenges', () => {
    const rendered = render({
      config: config({ email: 'me@example.com', dns01: { enabled: true } }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com', 'plain.example.com'] },
      dns01: {
        resolvers: [],
        endpoint: 'http://127.0.0.1:3999/_acme',
        username: 'hh',
        password: 'secret',
        policies: [{ account: 'default/cf', provider: 'cloudflare', subjects: ['git.example.com'] }],
      },
      routes: [
        { host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' },
        { host: 'plain.example.com', path: '', dial: '127.0.0.1:3001', upstreamTls: false, tls: 'auto' },
      ],
    })

    const policies = policiesOf(rendered)
    expect(policies).toHaveLength(2)
    // The DNS-01 policy first, then everything else, still able to use HTTP-01.
    expect(policies[0].subjects).toEqual(['git.example.com'])
    expect(policies[0].issuers[0].challenges).toBeDefined()
    expect(policies[1].subjects).toEqual(['plain.example.com'])
    expect(policies[1].issuers[0].challenges).toBeUndefined()
  })

  it('leaves the challenge alone when DNS-01 is off', () => {
    const rendered = render({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com'] },
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })

    const issuer = policiesOf(rendered)[0].issuers[0]
    expect(issuer.challenges).toBeUndefined()
  })

  it('serves a page instead of redirecting while a certificate is still coming', () => {
    const rendered = render({
      config: config({ email: 'me@example.com', httpPort: 4480, httpsPort: 4443 }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com'] },
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto', certificateReady: false }],
    })

    const httpRoutes = routesOf(rendered, 'http')
    expect(httpRoutes).toHaveLength(1)
    // The challenge path is never ours to answer, on the notice or on a redirect.
    expect(httpRoutes[0].match[0].not).toEqual([{ path: ['/.well-known/acme-challenge/*'] }])
    expect(httpRoutes[0].handle[0].status_code).toBe(503)
    expect(httpRoutes[0].handle[0].headers['content-type']).toEqual(['text/html; charset=utf-8'])
    // The page names the hostname and the ports a router has to forward.
    expect(httpRoutes[0].handle[0].body).toContain('git.example.com')
    expect(httpRoutes[0].handle[0].body).toContain('80 → 4480')
    // And no redirect into a handshake that cannot finish.
    expect(httpRoutes[0].handle[0].headers.Location).toBeUndefined()
  })

  it('covers the whole host with the notice, prefix or not', () => {
    const rendered = render({
      config: config({ email: 'me@example.com', httpPort: 4480, httpsPort: 4443 }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com', 'other.example.com'] },
      routes: [
        // Not ready, with a prefix: the notice must still answer the whole host.
        { host: 'git.example.com', path: '/app', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto', certificateReady: false },
        // Ready, with a prefix: the redirect keeps its prefix.
        { host: 'other.example.com', path: '/api', dial: '127.0.0.1:3001', upstreamTls: false, tls: 'auto', certificateReady: true },
      ],
    })

    const httpRoutes = routesOf(rendered, 'http')
    expect(httpRoutes).toHaveLength(2)
    // The ready one redirects only inside its prefix…
    expect(httpRoutes[0].match[0]).toEqual({
      host: ['other.example.com'],
      path: ['/api', '/api/*'],
      not: [{ path: ['/.well-known/acme-challenge/*'] }],
    })
    expect(httpRoutes[0].handle[0].status_code).toBe(308)
    // …while the notice answers the host, whatever the path.
    expect(httpRoutes[1].match[0]).toEqual({
      host: ['git.example.com'],
      not: [{ path: ['/.well-known/acme-challenge/*'] }],
    })
    expect(httpRoutes[1].handle[0].status_code).toBe(503)
  })

  it('emits one notice per host, not one per route', () => {
    const rendered = render({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com'] },
      routes: [
        { host: 'git.example.com', path: '/app', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto', certificateReady: false },
        { host: 'git.example.com', path: '/other', dial: '127.0.0.1:3001', upstreamTls: false, tls: 'auto', certificateReady: false },
      ],
    })
    expect(routesOf(rendered, 'http')).toHaveLength(1)
  })

  it('sends a staging account to the staging directory, and only there', () => {
    const rendered = render({
      config: config({ email: '', staging: true }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: '', staging: true, subjects: ['git.example.com'] },
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })

    expect(policiesOf(rendered)[0].issuers).toEqual([
      { module: 'acme', ca: 'https://acme-staging-v02.api.letsencrypt.org/directory' },
      { module: 'internal' },
    ])
  })

  it('emits no automation policy when no public name is served', () => {
    const rendered = render({
      config: config({}),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      routes: [{ host: 'gitea.lan', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })
    // No ACME policy for a local-only name: it keeps the engine's own CA. The only
    // automation is the fallback certificate the bare-IP visitor is served.
    expect(policiesOf(rendered)).toEqual([])
    expect((rendered.apps as any).tls.automation.policies).toEqual([
      { subjects: ['hh-fallback.invalid'], issuers: [{ module: 'internal' }] },
    ])
  })

  it('answers an unrouted host with a page on both ports, and never a redirect', () => {
    const rendered = render({
      config: config({ email: 'me@example.com', httpPort: 4480, httpsPort: 4443 }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com'] },
      routes: [{ host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' }],
    })

    for (const server of ['http', 'https'] as const) {
      const routes = (rendered.apps as any).http.servers[server].routes
      const last = routes[routes.length - 1]
      // No host matcher: it catches whatever the routes above it did not.
      expect(last.match).toBeUndefined()
      expect(last.handle[0].status_code).toBe(404)
      expect(last.handle[0].body).toContain('This route is not configured for any target yet')
      expect(last.handle[0].body).toContain('home-hosted')
    }

    // Caddy's own redirect for a host it does not manage points at port 443, not ours;
    // the catch-all above is what stops it being reached.
    const https = (rendered.apps as any).http.servers.https
    expect(https.tls_connection_policies).toEqual([{ default_sni: 'hh-fallback.invalid' }])
  })

  it('carries the manual pair and the ACME account side by side', () => {
    const rendered = render({
      config: config({ email: 'me@example.com' }),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [{ certificate: '/state/tls/proxy.crt.pem', key: '/state/tls/proxy.key.pem' }],
      acme: { email: 'me@example.com', staging: false, subjects: ['git.example.com'] },
      routes: [
        { host: 'git.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'auto' },
        { host: 'manual.example.com', path: '', dial: '127.0.0.1:3001', upstreamTls: false, tls: 'manual' },
      ],
    })
    expect((rendered.apps as any).tls.certificates.load_files[0].certificate).toBe('/state/tls/proxy.crt.pem')
    expect(policiesOf(rendered)[0].subjects).toEqual(['git.example.com'])
  })

  it('loads the uploaded pair from disk instead of inlining a private key', () => {
    const rendered = render({
      config: config({}),
      admin: unixAdmin,
      engineDir: '/state/engine',
      manual: [{ certificate: '/state/tls/proxy.crt.pem', key: '/state/tls/proxy.key.pem' }],
      routes: [{ host: 'manual.example.com', path: '', dial: '127.0.0.1:3000', upstreamTls: false, tls: 'manual' }],
    })
    expect((rendered.apps as any).tls.certificates).toEqual({
      load_files: [{ certificate: '/state/tls/proxy.crt.pem', key: '/state/tls/proxy.key.pem' }],
    })
    // No public name is served, so the only automation is the fallback certificate.
    expect(policiesOf(rendered)).toEqual([])
    expect((rendered.apps as any).tls.automation.policies).toEqual([
      { subjects: ['hh-fallback.invalid'], issuers: [{ module: 'internal' }] },
    ])
  })

  it('asks a TCP admin endpoint for the origin its own check requires', () => {
    const rendered = render({
      config: config({}),
      admin: { kind: 'tcp', host: '127.0.0.1', port: 46_000, origin: 'http://127.0.0.1:46000' },
      engineDir: '/state/engine',
      manual: [],
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
