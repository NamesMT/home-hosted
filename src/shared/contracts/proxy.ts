/**
 * The reverse proxy: routes, certificates, the engine's state, and the config and patch shapes.
 *
 * `proxyRouteSchema` is the file's shape and `proxyRoutePatchSchema` the PATCH's — a patch carries no
 * defaults, and its `routes`/`certificates` lists are replaced whole because a key-by-key merge cannot
 * express removing one.
 */
import { type } from 'arktype'
import { lazy } from '../lazy'

/**
 * The reverse-proxy engine this panel can drive. One engine ships today; the
 * field exists so a config written now keeps working if a second one lands.
 */
const proxyEngineSchema = lazy(() => type.enumerated('caddy'))

/** What a route forwards to: a supervised entry, the panel itself, or a literal upstream. */
const proxyTargetSchema = lazy(() => type.enumerated('server', 'panel', 'external'))
export type ProxyTarget = typeof proxyTargetSchema.infer

/** `auto` lets the engine decide: a public name gets ACME, a local one its own CA. */
const proxyTlsModeSchema = lazy(() => type.enumerated('auto', 'off', 'manual'))
export type ProxyTlsMode = typeof proxyTlsModeSchema.infer

/**
 * One public hostname, and where it goes. A route is panel-wide on purpose — the
 * point is one domain per service across every workspace — so a target that
 * names an entry names its workspace too.
 */
export const proxyRouteSchema = lazy(() => type({
  'id': '/^[a-z0-9][a-z0-9_-]*$/',
  /** The public hostname this route answers for. */
  'host': '/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/',
  'enabled': 'boolean = true',
  'target': proxyTargetSchema.default(() => 'server' as const),
  /** `target: "server"` — an id is only unique inside its workspace. */
  'workspace': 'string = ""',
  'server': 'string = ""',
  /** `target: "external"` — a literal upstream such as `http://10.0.0.5:8080`. */
  'url': 'string = ""',
  /** Optional path prefix; empty serves the whole host. */
  'path': 'string = ""',
  'tls': proxyTlsModeSchema.default(() => 'auto' as const),
  /**
   * Which DNS account answers a DNS-01 challenge for this hostname, as
   * `<workspace>/<account>` — the account belongs to a workspace, so the proxy
   * references it rather than owning it. Empty picks the workspace's only
   * account that can write TXT records.
   */
  'dnsAccount': 'string = ""',
  /**
   * An `https://` upstream's certificate is verified unless this is `true` — the opt-in for an
   * upstream behind a self-signed certificate. A route to the panel itself never needs it. Optional
   * with no default, so a config that never set it is not rewritten with it.
   */
  'upstreamSkipVerify?': 'boolean',
}).onUndeclaredKey('reject'))
export type ProxyRoute = typeof proxyRouteSchema.infer

/**
 * One uploaded PEM pair. The pair itself lives on disk (0600) beside the panel's
 * own; this is the entry that names it, so a route can be checked against it.
 */
export const proxyCertificateSchema = lazy(() => type({
  id: '/^[a-z0-9][a-z0-9_-]*$/',
  label: 'string = ""',
}).onUndeclaredKey('reject'))

/**
 * What a route's certificate situation is, for the page to show. `fallback` is a
 * public name the CA would not issue for, so the engine is serving its own CA.
 */
const proxyCertificateStateSchema = lazy(() => type.enumerated('off', 'local', 'uploaded', 'issued', 'pending', 'failed', 'fallback'))
export type ProxyCertificateState = typeof proxyCertificateStateSchema.infer

/**
 * DNS-01, answered by the panel instead of the engine.
 *
 * The engine never holds DNS credentials: it asks the panel over the ACMEProxy
 * protocol, and the panel writes the challenge record through the workspace
 * account a route names. `resolvers` overrides the nameservers Caddy uses to see
 * the record, which is what split-horizon DNS needs.
 */
const proxyDns01Schema = lazy(() => type({
  /** Off means the engine uses HTTP-01/TLS-ALPN-01, exactly as before. */
  enabled: 'boolean = false',
  /** Nameservers Caddy checks the TXT record against; empty uses its own defaults. */
  resolvers: type('string[]').default(() => []),
}).onUndeclaredKey('reject'))

/** Reverse proxy: expose the stack through one engine, with automatic HTTPS. */
export const proxyConfigSchema = lazy(() => type({
  enabled: 'boolean = false',
  engine: proxyEngineSchema.default(() => 'caddy' as const),
  /** Cleartext side: ACME HTTP-01 challenges and the redirect to HTTPS. */
  httpPort: '1 <= number.integer <= 65535 = 80',
  httpsPort: '1 <= number.integer <= 65535 = 443',
  /** ACME account address; a public certificate needs one. */
  email: 'string = ""',
  /** The ACME staging endpoint: untrusted certificates, no rate-limit burn. */
  staging: 'boolean = false',
  dns01: proxyDns01Schema.default(() => ({})),
  /** PEM pairs a route with `tls: "manual"` may serve; the engine picks by SNI. */
  certificates: proxyCertificateSchema.array().default(() => []),
  routes: proxyRouteSchema.array().default(() => []),
}).onUndeclaredKey('reject'))
export type ProxyConfig = typeof proxyConfigSchema.infer

/** Where the binary came from: the release we downloaded, or a path a person set. */
const proxyEngineSourceSchema = lazy(() => type.enumerated('downloaded', 'custom'))

/** What the panel knows about the installed engine. */
export const proxyEngineStatusSchema = lazy(() => type({
  id: proxyEngineSchema,
  installed: 'boolean',
  /** The version the binary reports; `null` until it has been probed. */
  version: 'string | null',
  source: proxyEngineSourceSchema.or(type('null')),
  path: 'string | null',
  bytes: 'number | null',
  error: 'string | null',
}))
export type ProxyEngineStatus = typeof proxyEngineStatusSchema.infer

/** Engine capabilities, so the page knows which options to offer. */
const proxyEngineInfoSchema = lazy(() => type({
  id: proxyEngineSchema,
  label: 'string',
  docsUrl: 'string',
  releaseUrl: 'string',
  acme: 'boolean',
  internalCa: 'boolean',
  dns01: 'boolean',
  tcp: 'boolean',
}))
export type ProxyEngineInfo = typeof proxyEngineInfoSchema.infer

const proxyRouteStatusSchema = lazy(() => type.enumerated('ok', 'disabled', 'no-upstream', 'error'))
export type ProxyRouteStatus = typeof proxyRouteStatusSchema.infer

/** A route as the page reads it: the config, plus the upstream resolved live. */
export const proxyRouteViewSchema = lazy(() => type({
  'route': proxyRouteSchema,
  'status': proxyRouteStatusSchema,
  'upstream': 'string | null',
  'message': 'string | null',
  /** Where this hostname's certificate stands. Optional: an older panel omits it. */
  'certificate?': type({
    'state': proxyCertificateStateSchema,
    'message': 'string | null',
    /**
     * For `fallback`: minutes until the engine tries the CA again by itself, read
     * from the certificate it fell back to. Optional, so an older client ignores it.
     */
    'retryInMinutes?': 'number',
  }),
}).onDeepUndeclaredKey('ignore'))
export type ProxyRouteView = typeof proxyRouteViewSchema.infer

const proxyRunStateSchema = lazy(() => type.enumerated('off', 'stopped', 'starting', 'running', 'error', 'unsupported'))
export type ProxyRunState = typeof proxyRunStateSchema.infer

/** Live engine state. */
export const proxyStatusSchema = lazy(() => type({
  state: proxyRunStateSchema,
  pid: 'number | null',
  /** The addresses the engine serves on, for the page to show. */
  urls: type('string[]'),
  /** Days until the soonest publicly-issued certificate expires; `null` when none. */
  certExpiryDays: 'number | null',
  since: 'number | null',
  lastError: 'string | null',
}))
export type ProxyStatus = typeof proxyStatusSchema.infer

/** One uploaded pair, described: what it is for, and whether it is usable. */
const proxyCertificateViewSchema = lazy(() => type({
  id: 'string',
  label: 'string',
  /** Both halves are on disk. */
  present: 'boolean',
  /** The engine would serve this pair for at least one manual route. */
  used: 'boolean',
  subject: 'string | null',
  issuer: 'string | null',
  validTo: 'string | null',
  daysRemaining: 'number | null',
  /** Hostnames the pair covers, read from its SANs. */
  hosts: type('string[]'),
  error: 'string | null',
}))
export type ProxyCertificateView = typeof proxyCertificateViewSchema.infer

/**
 * A DNS account the route table may name, flattened across workspaces so the proxy
 * page can offer one list. The account itself stays in its workspace.
 */
const proxyDnsAccountViewSchema = lazy(() => type({
  'workspace': 'string',
  'account': 'string',
  'provider': 'string',
  'label': 'string',
  /** The credentials can write a TXT record, so this account can answer a challenge. */
  'writesTxt': 'boolean',
  /** Credentials are stored; an account without them cannot answer yet. */
  'hasCredentials': 'boolean',
  /**
   * The zones the account is known to hold, from its Dynamic DNS hostnames. "Automatic" uses an
   * account only for names inside one of them. Optional: an older panel omits it.
   */
  'zones?': 'string[]',
}))
export type ProxyDnsAccountView = typeof proxyDnsAccountViewSchema.infer

/** `GET /api/proxy`: the policy, the engine, the live state and the resolved routes. */
export const proxyViewSchema = lazy(() => type({
  'config': proxyConfigSchema,
  'engine': proxyEngineStatusSchema,
  'engines': proxyEngineInfoSchema.array(),
  'status': proxyStatusSchema,
  'routes': proxyRouteViewSchema.array(),
  /** Every uploaded pair, with what it covers and when it expires. */
  'certificates': proxyCertificateViewSchema.array(),
  /** Every DNS account a route may name. Optional: an older panel omits it. */
  'dnsAccounts?': proxyDnsAccountViewSchema.array(),
}).onDeepUndeclaredKey('ignore'))
export type ProxyView = typeof proxyViewSchema.infer

/**
 * A route as a patch sends it: every field optional, so a client may change one
 * member of a route — or add a route with only the two fields that matter.
 */
const proxyRoutePatchSchema = lazy(() => type({
  id: 'string',
  host: 'string',
  enabled: 'boolean?',
  target: proxyTargetSchema.optional(),
  workspace: 'string?',
  server: 'string?',
  url: 'string?',
  path: 'string?',
  tls: proxyTlsModeSchema.optional(),
  dnsAccount: 'string?',
  upstreamSkipVerify: 'boolean?',
}).onUndeclaredKey('reject'))
export type ProxyRoutePatch = typeof proxyRoutePatchSchema.infer

/**
 * The proxy block as a patch: no defaults, and `routes` is a list a patch
 * **replaces** — a key-by-key merge cannot express removing a route.
 */
export const proxyPatchSchema = lazy(() => type({
  enabled: 'boolean?',
  engine: proxyEngineSchema.optional(),
  httpPort: '1 <= number.integer <= 65535?',
  httpsPort: '1 <= number.integer <= 65535?',
  email: 'string?',
  staging: 'boolean?',
  /**
   * A patch shape, not the config's: both keys are optional and merge, so a client
   * may send one without resetting the other, and an explicit `null` clears a key.
   */
  dns01: type({
    enabled: 'boolean | null?',
    resolvers: 'string[] | null?',
  }).onUndeclaredKey('reject').optional(),
  certificates: proxyCertificateSchema.array().optional(),
  routes: proxyRoutePatchSchema.array().optional(),
}).onUndeclaredKey('reject'))
export type ProxyPatch = typeof proxyPatchSchema.infer

/** `PUT /api/proxy/certificates/:id`: the pair itself, plus what to call it. */
export const proxyCertificateUploadSchema = lazy(() => type({
  label: 'string = ""',
  certificate: 'string >= 1',
  privateKey: 'string >= 1',
}).onUndeclaredKey('reject'))

/** `POST /api/proxy/engine`: which release to install; empty means the current one. */
export const proxyEngineInstallSchema = lazy(() => type({
  version: 'string = ""',
}).onUndeclaredKey('reject'))
