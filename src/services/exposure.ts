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
  const panelRoutes = proxy.routes.filter(route => route.enabled && route.target === 'panel' && route.tls !== 'off')
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
