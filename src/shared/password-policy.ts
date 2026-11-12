/**
 * The shortest password the panel may be exposed beyond loopback behind — its own listener on a
 * non-loopback bind, or a reverse-proxy route to it. Any length is accepted for a loopback-only
 * panel: this is the exposure bar (`checkExposure`), not a schema floor.
 */
export const EXPOSED_PASSWORD_MIN_LENGTH = 12

/** Below this, `set-password` warns even for a loopback-only panel. */
export const WEAK_PASSWORD_LENGTH = 8

/** Characters, not UTF-16 units: an emoji is one character to the person typing it. */
export function passwordLength(password: string): number {
  return [...password].length
}
