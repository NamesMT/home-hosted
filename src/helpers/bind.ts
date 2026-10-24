import os from 'node:os'

/**
 * How long the LAN address stays good.
 *
 * `os.networkInterfaces()` is not free: it was measured at **34–62 ms per call** on a machine
 * with three interfaces (median 51 ms, 30 calls), because libuv enumerates every interface and
 * every address each time. `lanAddress()` is called from `serverTemplateVars`, which runs once per
 * server inside a state frame — so a 40-entry panel called it 82 times per build and spent ~4.2 s
 * of a 4.3 s window blocked inside it, with the tick publishing once a second. `/healthz` took
 * 3.1–4.2 s and every `/api` route waited behind the same loop.
 *
 * A home server's LAN address changes when DHCP moves it, a cable moves, or a VPN comes up, and a
 * half-minute of staleness costs one stale "open server" link that the next frame corrects. So the
 * value is cached, and the cache is short enough that a network change is picked up without a
 * restart.
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
