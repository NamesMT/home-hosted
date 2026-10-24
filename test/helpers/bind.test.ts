import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindHost, displayHost, forgetLanAddress, isExposed, lanAddress } from '#src/helpers/bind'

/**
 * `lanAddress()` is read once per server, inside a state frame.
 *
 * `os.networkInterfaces()` measured 34–62 ms per call on a three-interface machine, and a 40-entry
 * panel called `lanAddress()` 82 times per frame — so the panel spent ~98% of its event loop
 * blocked enumerating interfaces on an idle box with nobody using it: `/healthz` answered in
 * 3.1–4.2 s and every `/api` route queued behind the same loop. The cache below is what makes the
 * cost constant instead of per-server; these cases pin the caching *decisions* (what is reused,
 * what is refreshed, what a network change looks like) rather than a wall-clock number, which no
 * test can assert reliably on a busy runner.
 */

/** Every interface list the fake host answers, so a case can change the network under the cache. */
let interfaces: Record<string, os.NetworkInterfaceInfo[]> = {}

function fakeInterfaces(lists: Array<{ address: string, internal?: boolean }>): void {
  interfaces = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    eth0: lists.map((entry, index) => ({
      address: entry.address,
      netmask: '255.255.255.0',
      // An IPv6 loopback in the list too, so a case proves the family filter rather than a
      // lucky ordering.
      family: entry.address.includes(':') ? 'IPv6' as const : 'IPv4' as const,
      mac: `00:00:00:00:00:0${index}`,
      internal: entry.internal ?? false,
      cidr: entry.address.includes(':') ? `${entry.address}/64` : `${entry.address}/24`,
      // Required by `NetworkInterfaceInfoIPv6` and ignored for IPv4, so one shape covers both.
      scopeid: 0,
    })),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  forgetLanAddress()
})

/** Counts enumerations and answers the fake host. */
function installHost(): { calls: () => number } {
  let calls = 0
  vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
    calls += 1
    return interfaces
  })
  return { calls: () => calls }
}

describe('lanAddress', () => {
  it('answers the first non-internal IPv4 address and skips loopback and IPv6', () => {
    fakeInterfaces([{ address: '::1', internal: true }, { address: 'fe80::1' }, { address: '192.168.1.201' }])
    installHost()
    expect(lanAddress()).toBe('192.168.1.201')
  })

  it('answers null on a host with no non-internal IPv4 address', () => {
    fakeInterfaces([{ address: '::1', internal: true }])
    installHost()
    expect(lanAddress()).toBeNull()
  })

  /**
   * The defect: one frame per second, one enumeration per server inside it. A cache that is not
   * read is indistinguishable from no cache at all, so this asserts the *count*.
   */
  it('enumerates the host once however many times it is asked inside the window', () => {
    fakeInterfaces([{ address: '192.168.1.201' }])
    const host = installHost()
    for (let index = 0; index < 80; index++) lanAddress()
    expect(host.calls()).toBe(1)
  })

  it('asks again once the window has passed, so a DHCP change is picked up without a restart', () => {
    fakeInterfaces([{ address: '192.168.1.201' }])
    const host = installHost()
    const first = 1_000_000
    expect(lanAddress(first)).toBe('192.168.1.201')

    // The address moves, as DHCP, a cable or a VPN brings it up.
    fakeInterfaces([{ address: '10.0.0.42' }])
    expect(lanAddress(first + 1000)).toBe('192.168.1.201')
    expect(host.calls()).toBe(1)

    // Past the TTL the new answer is read.
    expect(lanAddress(first + 30_000)).toBe('10.0.0.42')
    expect(host.calls()).toBe(2)
  })

  it('forgets on request, which is what a simulated network change needs', () => {
    fakeInterfaces([{ address: '192.168.1.201' }])
    const host = installHost()
    lanAddress()
    forgetLanAddress()
    lanAddress()
    expect(host.calls()).toBe(2)
  })
})

describe('the bind helpers around it', () => {
  it('maps the two words to an address, and passes a literal through', () => {
    expect(bindHost('local')).toBe('127.0.0.1')
    expect(bindHost('lan')).toBe('0.0.0.0')
    expect(bindHost('10.1.2.3')).toBe('10.1.2.3')
  })

  it('never shows 0.0.0.0 as the address a person should open', () => {
    fakeInterfaces([{ address: '192.168.1.201' }])
    installHost()
    expect(displayHost('lan')).toBe('192.168.1.201')
    expect(displayHost('local')).toBe('127.0.0.1')
    // A literal address is the address, never resolved through the interface list.
    expect(displayHost('10.1.2.3')).toBe('10.1.2.3')
  })

  it('falls back to loopback for a lan bind on a host with no LAN address', () => {
    fakeInterfaces([])
    installHost()
    expect(lanAddress()).toBeNull()
    expect(displayHost('lan')).toBe('127.0.0.1')
  })

  it('reports exposure from the bind, not from the address', () => {
    expect(isExposed('lan')).toBe(true)
    expect(isExposed('local')).toBe(false)
    expect(isExposed('10.1.2.3')).toBe(true)
  })
})
