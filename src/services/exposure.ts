import type { ControlConfig } from '#src/shared/contracts'
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
