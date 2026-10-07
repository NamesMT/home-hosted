/**
 * The address a *browser* should open for a server entry.
 *
 * The panel builds `ServerView.url` from its own view of the network: for a `lan` bind that is this
 * machine's LAN address (`displayHost` → `lanAddress`). Someone who reached the panel over a public
 * hostname or a tunnel — `http://box.example:4999` — has no route to `192.168.1.20:4991`, so every
 * "open server" link was dead for exactly the users the bind was opened for. Only the browser knows
 * the name that reached the panel, so the swap happens here, in the one module both UIs read.
 *
 * The entry's own address is kept unless the swap is *provably* right:
 *
 * - a `lan` bind (`0.0.0.0`) listens on every interface, so whatever name reached the panel also
 *   reaches the entry, on the entry's own port;
 * - any other bind is reachable at that address and nowhere else. A specific IP must be kept, and
 *   rewriting a loopback entry would turn "not reachable from here" into a link to the panel;
 * - and if the page itself is loopback the viewer is on this machine, where the LAN address is
 *   already the right answer.
 *
 * The scheme and the entry's port are never touched: a server port is plain HTTP whatever the panel
 * is served over, and the port belongs to the entry.
 */

/** The fields this reads off a `ServerView`; narrowed so a test needs no whole view. */
export interface ServerLinkSource {
  /** The panel-computed address, or `null` when the entry has no port. */
  url: string | null
  /** The address the entry actually binds: `127.0.0.1` for `local`, `0.0.0.0` for `lan`, else the IP. */
  bindHost: string
}

/** True for a name a browser resolves to this machine: `localhost`, `127.0.0.0/8`, `::1`. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase()
  if (name === 'localhost' || name === '::1' || name === '[::1]')
    return true
  if (name.endsWith('.localhost'))
    return true
  return /^127(?:\.\d{1,3}){3}$/.test(name)
}

/**
 * `url`, with this machine's own address replaced by the hostname the page was reached at — but only
 * when the entry listens on every interface and the viewer is not already on this machine. Anything
 * it must not rewrite comes back unchanged, and so does a `url` it cannot parse: a reachable address
 * is better than a link pointing at nothing.
 */
export function browserServerUrl(server: ServerLinkSource, pageHost: string): string | null {
  const { url, bindHost } = server
  // An empty host means no location to read (a non-DOM render), which is "cannot tell", not "local".
  const host = pageHost.trim()
  if (url === null || bindHost.trim() !== '0.0.0.0' || host === '' || isLoopbackHost(host))
    return url

  try {
    const parsed = new URL(url)
    // `location.hostname` brackets an IPv6 literal already; a bare one needs brackets to parse.
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    const port = parsed.port.length > 0 ? `:${parsed.port}` : ''
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.protocol}//${authority}${port}${path}${parsed.search}${parsed.hash}`
  }
  catch {
    return url
  }
}

/**
 * The hostname this page was reached at, or `''` where there is no location (a test, or a render that
 * never reaches a browser). Read through a narrowed `globalThis` so this module keeps the server
 * package's non-DOM type surface — it is compiled by both `tsconfig`s.
 */
export function pageHostname(): string {
  const location = (globalThis as { location?: { hostname?: string } }).location
  return location?.hostname ?? ''
}
