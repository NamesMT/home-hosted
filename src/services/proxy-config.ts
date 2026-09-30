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
}

export interface ProxyConfigInput {
  config: ProxyConfig
  admin: ProxyAdminTransport
  /** Where certificates and other engine state live; never a home directory. */
  engineDir: string
  routes: ProxyUpstreamRoute[]
  /** The PEM pair `tls: "manual"` serves, as paths on disk. */
  manual: { certificate: string, key: string } | null
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
        ...managed.map(route => ({
          match: [matchFor(route)],
          handle: [{
            handler: 'static_response',
            status_code: 308,
            headers: { Location: [`https://{http.request.host}${suffix}{http.request.uri}`] },
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

  return {
    admin: adminBlock,
    storage: { module: 'file_system', root: `${engineDir}/data` },
    logging: { logs: { default: { level: 'INFO' } } },
    apps: {
      ...(input.manual === null
        ? {}
        : { tls: { certificates: { load_files: [{ certificate: input.manual.certificate, key: input.manual.key }] } } }),
      http: {
        http_port: config.httpPort,
        https_port: config.httpsPort,
        servers,
      },
    },
  }
}
