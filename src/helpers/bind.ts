import os from 'node:os'

/**
 * How long the LAN address stays good.
 *
 * `os.networkInterfaces()` is not free — libuv enumerates every interface and address per call
 * (34–62 ms on a three-interface machine) — and `lanAddress()` runs per server inside a state frame,
 * so an uncached call blocks the one-second tick and `/healthz` behind it.
 *
 * A home server's address changes when DHCP moves it, a cable moves, or a VPN comes up; a
 * half-minute of staleness costs one stale link that the next frame corrects.
 */
const LAN_ADDRESS_TTL_MS = 30_000

let cached: { value: string | null, at: number } | null = null

/**
 * This machine's first non-internal IPv4 address, or null when it has none.
 *
 * Cached for `LAN_ADDRESS_TTL_MS`: the call is expensive and its answer is read per server per
 * state frame. The cache is module state, which is acceptable here for the same reason
 * `appVersion()`'s is — the answer is a property of the host, not of a workspace, and nothing in
 * a test changes the interfaces it observes.
 */
export function lanAddress(now = Date.now()): string | null {
  if (cached !== null && now - cached.at < LAN_ADDRESS_TTL_MS)
    return cached.value

  let value: string | null = null
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        value = entry.address
        break
      }
    }
    if (value !== null)
      break
  }

  cached = { value, at: now }
  return value
}

/** Forgets the cached address. A test that simulates a network change calls this first. */
export function forgetLanAddress(): void {
  cached = null
}

/**
 * The address a client on this machine connects to for a listener bound to `bound`: the wildcard
 * binds answer on loopback, a specific address only on itself.
 */
export function dialHost(bound: string): string {
  return bound === '0.0.0.0' || bound === '::' || bound.length === 0 ? '127.0.0.1' : bound
}

export function bindHost(bind: string): string {
  if (bind === 'local')
    return '127.0.0.1'
  if (bind === 'lan')
    return '0.0.0.0'
  return bind
}

/** Address a human should open, which is never `0.0.0.0`. */
export function displayHost(bind: string): string {
  if (bind === 'local')
    return '127.0.0.1'
  if (bind === 'lan')
    return lanAddress() ?? '127.0.0.1'
  return bind
}

/** True when the bind value makes the port reachable from outside this machine. */
export function isExposed(bind: string): boolean {
  return bindHost(bind) !== '127.0.0.1'
}
