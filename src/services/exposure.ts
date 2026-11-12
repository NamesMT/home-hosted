import type { ControlConfig, ProxyConfig } from '#src/shared/contracts'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { invocation } from '#src/cli/io'
import { isExposed } from '#src/helpers/bind'
import { EXPOSED_PASSWORD_MIN_LENGTH } from '#src/shared/password-policy'
import { upstreamTarget } from '#src/shared/proxy-form'

export interface ExposureState {
  /** The control panel listens beyond loopback. */
  exposed: boolean
  /** Non-null when that exposure is not backed by a password. */
  blockedReason: string | null
}

/** The command that sets the password, spelled the way this process was invoked (`--home` included). */
function setPasswordCommand(): string {
  return `\`${invocation()} set-password\``
}

/**
 * Exposing the panel beyond loopback is only allowed with authentication fully
 * configured — this is checked at startup, on every settings write, and shown in
 * the UI, so the three can never disagree.
 *
 * "Fully configured" includes a password long enough to stand up to guessing from the network:
 * `passwordTooShort` is the stored record's own flag (set when it was hashed), because the hash
 * cannot be measured afterwards. A record written before the flag existed reads as long enough.
 */
export function checkExposure(control: ControlConfig, passwordSet: boolean, usingDefaultPassword = false, passwordTooShort = false): ExposureState {
  const exposed = isExposed(control.host)
  if (!exposed)
    return { exposed, blockedReason: null }

  if (!control.auth.enabled && !passwordSet) {
    return {
      exposed,
      blockedReason: `the control panel is bound to ${control.host} but authentication is disabled and no password is set`,
    }
  }
  if (!control.auth.enabled) {
    return { exposed, blockedReason: `the control panel is bound to ${control.host} but authentication is disabled` }
  }
  if (!passwordSet) {
    return {
      exposed,
      blockedReason: `the control panel is bound to ${control.host} but no password is set (run ${setPasswordCommand()})`,
    }
  }
  if (usingDefaultPassword) {
    return {
      exposed,
      blockedReason: `can't listen on ${control.host} while the panel still has its first-run password — run ${setPasswordCommand()} or change it in Global settings → Authentication`,
    }
  }
  if (passwordTooShort) {
    return {
      exposed,
      blockedReason: `can't listen on ${control.host} with a password shorter than ${EXPOSED_PASSWORD_MIN_LENGTH} characters — set a longer one with ${setPasswordCommand()} or in Global settings → Authentication`,
    }
  }
  return { exposed, blockedReason: null }
}

/**
 * A route pointing at the panel puts it on the internet, which is the same
 * exposure the listener rule guards — so it answers to the same bar. Said here
 * rather than in the proxy service because that rule must not have two homes.
 */
export function checkProxyExposure(
  proxy: ProxyConfig,
  authEnabled: boolean,
  passwordSet: boolean,
  usingDefaultPassword = false,
  /** The ports the panel listens on (live, and configured): an `external` route dialing one on this machine is a panel route. */
  panelPorts: readonly number[] = [],
  passwordTooShort = false,
): string | null {
  if (!proxy.enabled)
    return null
  // Every enabled route to the panel, whatever its `tls` says. `tls: "off"` was excluded here, and
  // that was backwards: the engine dials the panel on `127.0.0.1`, the `/api` guard reads a
  // loopback request as local while auth is enabled but unarmed, and so a plain-HTTP panel route
  // with no password set served the whole panel to anyone reaching that hostname — the same
  // exposure as a `tls: "auto"` one, but in the clear. A route pointing at the panel is exposure
  // and obeys this bar, which is what the rule already said in prose.
  //
  // An `external` route whose upstream is the panel's own listener (`http://127.0.0.1:<port>`,
  // `localhost`, `[::1]`, `0.0.0.0`) is the same exposure under another name, so it counts too.
  const panelRoutes = proxy.routes.filter(route => route.enabled
    && (route.target === 'panel' || (route.target === 'external' && dialsPanel(route.url, panelPorts))))
  if (panelRoutes.length === 0)
    return null

  const hosts = panelRoutes.map(route => route.host).join(', ')
  if (!authEnabled && !passwordSet)
    return `the reverse proxy would serve the control panel at ${hosts} but authentication is disabled and no password is set`
  if (!authEnabled)
    return `the reverse proxy would serve the control panel at ${hosts} but authentication is disabled`
  if (!passwordSet)
    return `the reverse proxy would serve the control panel at ${hosts} but no password is set (run ${setPasswordCommand()})`
  if (usingDefaultPassword)
    return `the reverse proxy can't serve the control panel at ${hosts} while it still has its first-run password — run ${setPasswordCommand()} or change it in Global settings → Authentication`
  if (passwordTooShort)
    return `the reverse proxy can't serve the control panel at ${hosts} with a password shorter than ${EXPOSED_PASSWORD_MIN_LENGTH} characters — set a longer one with ${setPasswordCommand()} or in Global settings → Authentication`
  return null
}

/** Loopback in every spelling a resolved address can come back as, IPv6-mapped forms included. */
function isLoopbackAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === '::1'
    || value === '::'
    || value === '0.0.0.0'
    || value === 'localhost'
    || value.endsWith('.localhost')
    || /^127(?:\.\d{1,3}){3}$/.test(value)
    // An AAAA record for `::ffff:127.0.0.1`, which is what a dual-stack resolver answers for some
    // names, plus the compressed spellings Node gives back (`::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`).
    || /^::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/.test(value)
    || /^(?:0{1,4}:){1,4}:ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(value)
}

/**
 * The upstream's hostname and port, without dialling anything, through the same parser the engine's
 * render uses — an upstream it refuses is never served, so it is not exposure either.
 */
function upstreamOf(upstream: string): { host: string, port: number } | null {
  const target = upstreamTarget(upstream)
  if (target === null)
    return null
  const host = target.host.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host.length === 0 ? null : { host, port: target.port }
}

/**
 * How long an answer about a hostname stays good, and how long a failure is remembered.
 *
 * A save is a person waiting on a form, so the lookup must never be on that path (see `dialsPanel`).
 * These are the clocks: a positive answer is cached for five minutes — a name that resolves to
 * loopback and then does not is a change of intent a person makes by editing DNS, and the next save
 * clears the entry anyway — while a failure is remembered for thirty seconds only, so a temporary
 * resolver outage does not keep a legitimate route refused after the network comes back.
 */
const RESOLUTION_TTL_MS = 5 * 60_000
const RESOLUTION_FAILURE_TTL_MS = 30_000
/** A resolver that has not answered by then is treated as a failure, which fails closed. */
const RESOLUTION_TIMEOUT_MS = 2_000

/**
 * Answers about upstream hostnames, keyed by the name as it will be resolved.
 *
 * `null` in the value means "does not resolve", which is an answer: the route is refused for the
 * exposure decision. This is module state for the same reason `lanAddress()`'s cache is — the answer
 * is a property of the host's DNS, not of a workspace — and the exposure rule is read from several
 * services that share one process.
 */
const resolved = new Map<string, { addresses: string[] | null, at: number }>()

/** What resolves one hostname: production reads the system resolver, a test substitutes its table. */
type UpstreamResolver = (host: string) => Promise<string[] | null>

/** The real resolver, with the answer shape the cache wants and every failure collapsed to `null`. */
const systemResolver: UpstreamResolver = async (host) => {
  const answers = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), RESOLUTION_TIMEOUT_MS).unref()),
  ])
  // An empty answer is no answer: a failure, not a harmless host.
  return answers.length === 0 ? null : answers.map(answer => answer.address)
}

let resolveHost: UpstreamResolver = systemResolver

/**
 * Replaces the resolver, and drops every cached answer.
 *
 * A seam for tests, like `forgetLanAddress()`: the alternative was patching `node:dns`, which the
 * named import in this module would not see — and a test that believes it stubbed DNS while the real
 * resolver answers is worse than no test.
 */
export function setUpstreamResolver(next?: UpstreamResolver): void {
  resolveHost = next ?? systemResolver
  resolved.clear()
}

/**
 * Resolves one upstream hostname, and remembers the answer on its own clock.
 *
 * Never throws: a resolver error, a timeout and a name with no records are the same answer here, and
 * that answer is `null` — which the exposure decision reads as "points at the panel". Fails closed.
 */
async function resolveUpstream(host: string): Promise<string[] | null> {
  const cached = resolved.get(host)
  if (cached !== undefined) {
    const ttl = cached.addresses === null ? RESOLUTION_FAILURE_TTL_MS : RESOLUTION_TTL_MS
    if (Date.now() - cached.at < ttl)
      return cached.addresses
  }
  let addresses: string[] | null = null
  try {
    addresses = await resolveHost(host)
  }
  catch {
    addresses = null
  }
  // Drop answers that have gone stale before adding one, so a long-lived panel does not accumulate
  // an entry per hostname it has ever been asked about. The table is small (one per `external` route
  // at most), so this is a sweep, not a bounded cache with eviction policy.
  const now = Date.now()
  for (const [name, entry] of resolved) {
    if (now - entry.at >= RESOLUTION_TTL_MS)
      resolved.delete(name)
  }
  resolved.set(host, { addresses, at: now })
  return addresses
}

/**
 * Warms `dialsPanel`'s cache for every `external` upstream in a proxy config.
 *
 * The exposure predicate is synchronous because it is read from the save guards as well as from the
 * engine's apply path, and a save must not wait on DNS. The asynchronous half lives here: the paths
 * that can act on a route (a proxy save, a settings write, the engine's apply and sync) have an
 * `await` to spare, so they resolve first and the predicate reads the answer. A route whose host is
 * not resolved when the predicate runs is treated as pointing at the panel until it is — fail
 * closed, and the next reconcile has the answer.
 */
export async function primeUpstreamResolutions(proxy: ProxyConfig): Promise<void> {
  const hosts = new Set<string>()
  for (const route of proxy.routes) {
    if (route.target !== 'external')
      continue
    const upstream = upstreamOf(route.url)
    if (upstream !== null && isIP(upstream.host) === 0)
      hosts.add(upstream.host)
  }
  await Promise.all([...hosts].map(host => resolveUpstream(host)))
}

/**
 * True when `upstream` names this machine on one of `panelPorts` — the panel's own listener.
 *
 * **The rule: a route points at the panel when its destination can be established as loopback.**
 * Two answers count as loopback — a literal loopback spelling, and a hostname whose resolution
 * includes a loopback address — and a third, deliberately, also counts: a name that does **not**
 * resolve. A destination the panel cannot establish is not evidence that it is harmless, and the
 * cost of the two mistakes is not symmetric: publishing a route that turns out to dial the panel
 * serves the whole panel to the internet with no credential, while refusing a route the person meant
 * to add is one save they retry once DNS is back.
 *
 * That inversion is the fix for the measured bypass. This predicate used to recognise literal
 * loopback only, so `http://panel.attacker.example:3999` with an A record of `127.0.0.1` — or
 * `127.0.0.1.nip.io` — was an ordinary `external` route: `checkProxyExposure` saw no panel route, the
 * engine published it, and the engine then dialled the panel from `127.0.0.1` with no forwarding
 * headers, which is exactly what `isLoopbackRequest` reads as this machine. Chasing names is not the
 * fix — a blocking list of spellings loses to the next spelling — so the question asked is "where
 * does this go", not "what is it called".
 *
 * `new URL` still normalizes the numeric spellings that need no resolver (`127.1`, `0`,
 * `2130706433`, `0x7f000001`, `[::1]`, `[::ffff:127.0.0.1]`), so those answer without DNS at all.
 * A non-loopback bind is already held to the listener rule (`checkExposure`), which is why an
 * interface address is not enumerated here.
 *
 * The lookup is served from the cache `primeUpstreamResolutions` fills; a name that has not been
 * resolved yet is treated as pointing at the panel, so this can read as over-strict for one reconcile
 * after a route is added — never as permissive.
 */
export function dialsPanel(upstream: string, panelPorts: readonly number[]): boolean {
  if (panelPorts.length === 0)
    return false
  const parsed = upstreamOf(upstream)
  if (parsed === null)
    return false
  if (!panelPorts.includes(parsed.port))
    return false
  const { host } = parsed
  // A literal, in any spelling `new URL` normalizes: no lookup involved, and none needed.
  if (isLoopbackAddress(host))
    return true
  if (isIP(host) !== 0)
    return false
  // A name: whatever the cache says it resolves to. No entry means "not established yet", and that
  // is the fail-closed half — a destination the panel cannot name is not one it publishes blindly.
  const cached = resolved.get(host)
  if (cached === undefined) {
    // Answer "yes" now and ask in the background, so the *next* read has the truth. A guard that
    // merely refused would refuse this route until something else happened to prime the cache; this
    // way a save that arrives before the answer is refused, and retrying it is one click later —
    // the resolve has already landed by then. `resolveUpstream` collapses every failure to `null`,
    // but it is still `.catch`-ed: a `void`-ed promise that rejects ends Node 24.
    void resolveUpstream(host).catch(() => undefined)
    return true
  }
  if (cached.addresses === null)
    return true
  return cached.addresses.some(address => isLoopbackAddress(address))
}

/**
 * A warning for the combination that makes the login lockout advisory.
 *
 * `trustProxy: true` tells srvx to trust `x-forwarded-*` from **any** peer, and it resolves the client
 * address from the leftmost entry of `x-forwarded-for` — a value the caller controls. Login failures are
 * keyed on that address, so a client that rotates the header never accumulates them: measured, 30 wrong
 * passwords from 30 forged addresses produced **zero** 429s, against 27 from a fixed address.
 *
 * This is a warning rather than a refusal because `true` has legitimate uses — a proxy on another host —
 * and, once the header is trusted, the real peer is not reachable through srvx (`#remoteAddress` is
 * private), so the panel cannot re-key the lockout on it. Prefer `host: local` with the proxy on this
 * machine, or leave `trustProxy` off and reach the panel directly.
 */
export function proxyTrustWarning(control: ControlConfig): string | null {
  // `'loopback'` is not the dangerous case: it trusts `x-forwarded-*` only when the peer *is* loopback,
  // so a forged header from anywhere else is ignored and the lockout keeps counting per real address.
  // Only the blanket `true` believes whoever asks.
  if (control.auth.trustProxy !== true || !isExposed(control.host))
    return null
  return `auth.trustProxy is on while the panel is bound to ${control.host}: the client address comes from `
    + `the caller's own x-forwarded-for header, so the login lockout (maxLoginAttempts/lockoutMs) counts `
    + `per forged address and can be bypassed. Keep the bind on local with the proxy on this machine, or `
    + `put an authenticating gateway in front`
}
