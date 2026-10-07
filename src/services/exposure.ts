import type { ControlConfig, ProxyConfig } from '#src/shared/contracts'
import { isExposed } from '#src/helpers/bind'

export interface ExposureState {
  /** The control panel listens beyond loopback. */
  exposed: boolean
  /** Non-null when that exposure is not backed by a password. */
  blockedReason: string | null
}

/**
 * Exposing the panel beyond loopback is only allowed with authentication fully
 * configured — this is checked at startup, on every settings write, and shown in
 * the UI, so the three can never disagree.
 */
export function checkExposure(control: ControlConfig, passwordSet: boolean, usingDefaultPassword = false): ExposureState {
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
      blockedReason: `the control panel is bound to ${control.host} but no password is set (run \`pnpm run set-password\`)`,
    }
  }
  if (usingDefaultPassword) {
    return {
      exposed,
      blockedReason: `the control panel is bound to ${control.host} but still uses the default password — change it first`,
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
): string | null {
  if (!proxy.enabled)
    return null
  // Every enabled route to the panel, whatever its `tls` says. `tls: "off"` was excluded here, and
  // that was backwards: the engine dials the panel on `127.0.0.1`, the `/api` guard reads a
  // loopback request as local while auth is enabled but unarmed, and so a plain-HTTP panel route
  // with no password set served the whole panel to anyone reaching that hostname — the same
  // exposure as a `tls: "auto"` one, but in the clear. A route pointing at the panel is exposure
  // and obeys this bar, which is what the rule already said in prose.
  const panelRoutes = proxy.routes.filter(route => route.enabled && route.target === 'panel')
  if (panelRoutes.length === 0)
    return null

  const hosts = panelRoutes.map(route => route.host).join(', ')
  if (!authEnabled && !passwordSet)
    return `the reverse proxy would serve the control panel at ${hosts} but authentication is disabled and no password is set`
  if (!authEnabled)
    return `the reverse proxy would serve the control panel at ${hosts} but authentication is disabled`
  if (!passwordSet)
    return `the reverse proxy would serve the control panel at ${hosts} but no password is set (run \`home-hosted set-password\`)`
  if (usingDefaultPassword)
    return `the reverse proxy would serve the control panel at ${hosts} but it still uses the default password — change it first`
  return null
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
