import type { ProxyAdminTransport } from '#src/providers/proxy'
import type { ProxyConfig, ProxyTlsMode } from '#src/shared/contracts'

/** One route, resolved to something the engine can actually dial. */
export interface ProxyUpstreamRoute {
  host: string
  path: string
  /** `host:port` the engine forwards to. */
  dial: string
  /** The upstream speaks TLS (the panel itself may), so verification is skipped. */
  upstreamTls: boolean
  tls: ProxyTlsMode
  /** The handshake for this name can complete: a certificate is there or will be. */
  certificateReady: boolean
}

export interface ProxyConfigInput {
  config: ProxyConfig
  admin: ProxyAdminTransport
  /** Where certificates and other engine state live; never a home directory. */
  engineDir: string
  routes: ProxyUpstreamRoute[]
  /** The PEM pairs `tls: "manual"` may serve, as paths on disk; the engine picks by SNI. */
  manual: Array<{ certificate: string, key: string }>
  /**
   * The ACME account, and the names it may issue for. Without this the engine still
   * gets certificates, but registers an account with no contact address and has no
   * way to be pointed at the staging endpoint.
   */
  acme: { email: string, staging: boolean, subjects: string[] }
}

/** The ACME staging directory: untrusted certificates, and no rate limit burnt. */
const ACME_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

/**
 * The issuers for the public names: ACME with the account address, then the engine's
 * own CA as a last resort.
 *
 * The fallback is what keeps a missing certificate from being a dead connection: the
 * handshake completes with an untrusted certificate (the browser offers to continue),
 * instead of failing with a protocol error the visitor cannot read past. The engine
 * keeps trying ACME, and the panel reports which of the two is being served.
 *
 * ZeroSSL is deliberately absent: it needs an EAB key the panel does not collect, so
 * listing it only added a failing issuer and a second retry on every name.
 */
function acmeIssuers(acme: ProxyConfigInput['acme']): Array<Record<string, unknown>> {
  return [
    { module: 'acme', ...(acme.email.length > 0 ? { email: acme.email } : {}), ...(acme.staging ? { ca: ACME_STAGING } : {}) },
    { module: 'internal' },
  ]
}

/** The page a visitor gets when a name has no certificate yet and HTTPS cannot work. */
function noticePage(host: string, httpPort: number, httpsPort: number): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Certificate not ready — ${host}</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; font: 15px/1.6 system-ui, sans-serif }
  main { max-width: 34rem; padding: 2rem }
  h1 { font-size: 1.15rem; margin: 0 0 .75rem }
  p { margin: 0 0 .75rem }
  code { font-family: ui-monospace, monospace; font-size: .9em }
  footer { color: #888; font-size: .85em }
</style></head>
<body><main>
  <h1>No certificate yet for ${host}</h1>
  <p>This hostname is routed, but the certificate authority has not issued a certificate
  for it yet, so HTTPS cannot complete a handshake. The engine keeps trying in the
  background and will serve the name as soon as it succeeds.</p>
  <p>The usual cause is that the CA cannot reach this machine: with the proxy on
  <code>${httpPort}</code>/<code>${httpsPort}</code>, forward <code>80 → ${httpPort}</code>
  and <code>443 → ${httpsPort}</code> on your router. Otherwise <code>http://${host}</code>
  will keep landing here.</p>
  <footer>Details, and the engine's own reason, are in the panel: Others → Reverse Proxy.</footer>
</main></body></html>`
}

/**
 * The same match, minus the ACME challenge path: the CA has to be able to read it on
 * the cleartext port, so nothing this panel generates may answer for it. HTTP-01 is
 * always asked at the root of the host (RFC 8555 §8.3), which is why one pattern is
 * enough.
 */
function matchForWithoutChallenge(route: ProxyUpstreamRoute): Record<string, unknown> {
  return { ...matchFor(route), not: [{ path: ['/.well-known/acme-challenge/*'] }] }
}

/**
 * The whole host, for a name whose certificate is not there yet. The prefix is dropped
 * on purpose: readiness is a property of the hostname, so a visitor who lands outside
 * the route's prefix must get the page too, not a redirect into a handshake that
 * cannot finish.
 */
function noticeMatcher(route: ProxyUpstreamRoute): Record<string, unknown> {
  return { host: [route.host], not: [{ path: ['/.well-known/acme-challenge/*'] }] }
}

function matchFor(route: ProxyUpstreamRoute): Record<string, unknown> {
  const match: Record<string, unknown> = { host: [route.host] }
  const prefix = route.path.trim()
  if (prefix.length > 0) {
    const base = prefix.startsWith('/') ? prefix : `/${prefix}`
    match.path = base === '/' ? ['/*'] : [base, `${base.replace(/\/$/, '')}/*`]
  }
  return match
}

function proxyHandler(route: ProxyUpstreamRoute): Record<string, unknown> {
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial: route.dial }],
    // Caddy decides https from the port alone; a local upstream is plain HTTP
    // unless we say otherwise, and the panel's own TLS is self-signed.
    ...(route.upstreamTls
      ? { transport: { protocol: 'http', tls: { insecure_skip_verify: true } } }
      : {}),
  }
}

/**
 * The whole engine configuration, generated from the panel's route table.
 *
 * Two servers on purpose: one terminates TLS for the names that ask for it, the
 * other keeps the cleartext port for ACME HTTP-01 challenges, plaintext routes and
 * an explicit redirect. Caddy's own redirect insertion is off so the redirect
 * carries our `httpsPort`, which is not necessarily 443.
 */
export function renderCaddyConfig(input: ProxyConfigInput): Record<string, unknown> {
  const { config, admin, engineDir, routes } = input
  const managed = routes.filter(route => route.tls !== 'off')
  const plain = routes.filter(route => route.tls === 'off')
  const suffix = config.httpsPort === 443 ? '' : `:${config.httpsPort}`

  const servers: Record<string, unknown> = {}
  if (managed.length > 0) {
    servers.https = {
      listen: [`:${config.httpsPort}`],
      routes: managed.map(route => ({ match: [matchFor(route)], handle: [proxyHandler(route)], terminal: true })),
    }
  }
  if (routes.length > 0) {
    servers.http = {
      listen: [`:${config.httpPort}`],
      // Caddy would redirect every host it manages; we do it, with the real port.
      automatic_https: { disable_redirects: true, skip: plain.map(route => route.host) },
      routes: [
        ...plain.map(route => ({ match: [matchFor(route)], handle: [proxyHandler(route)], terminal: true })),
        // A name whose certificate is not there yet gets the reason as a page rather
        // than a redirect into a handshake that cannot finish — once per host, since
        // that is what the certificate belongs to.
        ...managed.filter(route => route.certificateReady).map(route => ({
          match: [matchForWithoutChallenge(route)],
          handle: [{
            handler: 'static_response',
            status_code: 308,
            headers: { Location: [`https://{http.request.host}${suffix}{http.request.uri}`] },
          }],
        })),
        ...[...new Set(managed.filter(route => !route.certificateReady).map(route => route.host))].map(host => ({
          match: [noticeMatcher({ host } as ProxyUpstreamRoute)],
          handle: [{
            handler: 'static_response',
            status_code: 503,
            headers: { 'content-type': ['text/html; charset=utf-8'] },
            body: noticePage(host, config.httpPort, config.httpsPort),
          }],
        })),
      ],
    }
  }

  const adminBlock: Record<string, unknown> = { config: { persist: false } }
  if (admin.kind === 'unix') {
    adminBlock.listen = `unix/${admin.path}`
  }
  else {
    adminBlock.listen = `${admin.host}:${admin.port}`
    // No auth on the admin API, so a loopback listener still refuses a browser
    // from another origin. Our own client sends the matching `Origin`.
    adminBlock.enforce_origin = true
    adminBlock.origins = [admin.origin]
  }

  const tlsApp: Record<string, unknown> = {}
  if (input.manual.length > 0)
    tlsApp.certificates = { load_files: input.manual }
  // Subjects are the public names only: a local-only name must keep falling to the
  // engine's own CA, which a catch-all policy would take away from it.
  if (input.acme.subjects.length > 0) {
    tlsApp.automation = {
      policies: [{ subjects: input.acme.subjects, issuers: acmeIssuers(input.acme) }],
    }
  }

  return {
    admin: adminBlock,
    storage: { module: 'file_system', root: `${engineDir}/data` },
    logging: { logs: { default: { level: 'INFO' } } },
    apps: {
      ...(Object.keys(tlsApp).length === 0 ? {} : { tls: tlsApp }),
      http: {
        http_port: config.httpPort,
        https_port: config.httpsPort,
        servers,
      },
    },
  }
}
