import type { ProxyConfig, ProxyRoute } from '@shared/contracts'
import { proxyConfigSchema, proxyRouteSchema } from '@shared/contracts'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import {
  cloneListenerDraft,
  cloneRoutes,
  dnsAccountOptions,
  firstPublicHost,
  formatBytes,
  isPrivilegedPort,
  isPublicHost,
  listenerPatch,
  newRouteDraft,
  parseResolvers,
  parseUpstream,
  proxyPatch,
  requiresEmail,
  routesEqual,
  routesPatch,
  slugifyRouteId,
  targetSummary,
  tlsSummary,
  toProxyRoutes,
  uniqueRouteId,
  UNPRIVILEGED_HTTP_PORT,
  UNPRIVILEGED_HTTPS_PORT,
  usesFallbackPorts,
  validateRouteDraft,
} from '@/lib/proxy'

function route(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  const parsed = proxyRouteSchema({ id: 'gitea', host: 'gitea.example.com', ...overrides })
  if (parsed instanceof type.errors)
    throw parsed
  return parsed as ProxyRoute
}

function config(overrides: Record<string, unknown> = {}): ProxyConfig {
  const parsed = proxyConfigSchema({ routes: [route()], ...overrides })
  if (parsed instanceof type.errors)
    throw parsed
  return parsed as ProxyConfig
}

/**
 * `formatBytes` distinguishes "unknown" from "zero".
 *
 * A byte count is `number | null`: `null` is unknown and renders as an em-dash, and **0 is a real
 * answer** — an empty log file, an empty backup, a just-started engine. Both used to render as the
 * em-dash, so a file that exists with nothing in it read as a file that could not be measured.
 */
describe('formatBytes', () => {
  it('reports zero bytes as zero, not as unknown', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(null)).toBe('—')
    // A negative count is not a size, so it reads as unknown too.
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('isPublicHost', () => {
  it('accepts a name a public CA could issue for', () => {
    expect(isPublicHost('gitea.example.com')).toBe(true)
    expect(isPublicHost('a-b.example.co.uk')).toBe(true)
  })

  it('reads a local-only name, an IP and a single label as not public', () => {
    for (const host of ['nas.local', 'panel.lan', 'box.home.arpa', 'printer', 'localhost', '192.168.1.10', 'thing.internal', 'demo.example'])
      expect(isPublicHost(host), host).toBe(false)
  })

  it('does not call dotted digits a public name', () => {
    // More than four octets is still an address written out, not a name a CA could
    // issue for — the panel attempted ACME for it and the page showed "acme".
    expect(isPublicHost('1.2.3.4.5')).toBe(false)
  })
})

describe('cloneRoutes', () => {
  it('detaches the rows, so an edit cannot reach live state', () => {
    const live = reactive([route()])
    const [draft] = cloneRoutes(live)

    draft!.host = 'other.example.com'
    expect(live[0]!.host).toBe('gitea.example.com')
  })

  it('gives every cloned row its own stable key', () => {
    const [first] = cloneRoutes([route()])
    const [second] = cloneRoutes([route()])
    expect(first!.key).toBeTruthy()
    expect(first!.key).not.toBe(second!.key)
  })
})

describe('the route patch', () => {
  it('ignores the row key when comparing and when sending', () => {
    const drafts = cloneRoutes([route()])
    drafts[0]!.key = 'a-brand-new-key'

    expect(routesEqual([route()], drafts)).toBe(true)
    expect(routesPatch([route()], drafts)).toBeNull()
    expect(toProxyRoutes(drafts)[0]).toEqual({
      id: 'gitea',
      host: 'gitea.example.com',
      enabled: true,
      target: 'server',
      workspace: '',
      server: '',
      url: '',
      path: '',
      tls: 'auto',
      dnsAccount: '',
    })
  })

  it('replaces the whole list the moment a row changes', () => {
    const drafts = cloneRoutes([route()])
    drafts[0]!.enabled = false

    const patch = routesPatch([route()], drafts)
    expect(patch).not.toBeNull()
    expect(patch!).toHaveLength(1)
    expect(patch![0]!.enabled).toBe(false)
  })

  it('sends only the fields that changed, with the routes replaced', () => {
    const current = config({ email: 'me@example.com' })
    const listener = cloneListenerDraft(current)
    const drafts = cloneRoutes(current.routes)

    expect(proxyPatch(current, listener, drafts)).toBeNull()

    listener.staging = true
    drafts[0]!.host = 'git.example.com'
    const patch = proxyPatch(current, listener, drafts)

    expect(patch).not.toBeNull()
    expect(patch!.staging).toBe(true)
    expect(patch!.email).toBeUndefined()
    expect(patch!.routes).toHaveLength(1)
    expect(patch!.routes![0]!.host).toBe('git.example.com')
  })

  it('catches a port change on its own', () => {
    const current = config()
    expect(listenerPatch(current, { ...cloneListenerDraft(current), httpsPort: 4443 })).toEqual({ httpsPort: 4443 })
  })

  it('sends the DNS-01 group only when it changed', () => {
    const current = config({ dns01: { enabled: true, resolvers: ['1.1.1.1'] } })
    const same = { ...cloneListenerDraft(current) }
    expect(listenerPatch(current, same)).toEqual({})

    expect(listenerPatch(current, { ...same, dns01: false })).toEqual({ dns01: { enabled: false, resolvers: ['1.1.1.1'] } })
    expect(listenerPatch(current, { ...same, resolvers: '1.1.1.1, 8.8.8.8' }))
      .toEqual({ dns01: { enabled: true, resolvers: ['1.1.1.1', '8.8.8.8'] } })
    // The two are sent together: the group is replaced, not merged.
    expect(listenerPatch(current, { ...same, dns01: false, resolvers: '' }))
      .toEqual({ dns01: { enabled: false, resolvers: [] } })
  })
})

describe('dNS-01 resolvers and the account picker', () => {
  it('reads nameservers however they were typed', () => {
    expect(parseResolvers('1.1.1.1, 8.8.8.8')).toEqual(['1.1.1.1', '8.8.8.8'])
    expect(parseResolvers('1.1.1.1\n8.8.8.8')).toEqual(['1.1.1.1', '8.8.8.8'])
    expect(parseResolvers('  1.1.1.1 ,, 8.8.8.8  ')).toEqual(['1.1.1.1', '8.8.8.8'])
    expect(parseResolvers('')).toEqual([])
    expect(parseResolvers('   ')).toEqual([])
  })

  it('offers the fallback first, and marks the accounts that cannot answer', () => {
    const options = dnsAccountOptions([
      { workspace: 'default', account: 'cf', provider: 'cloudflare', label: 'Home zone', writesTxt: true, hasCredentials: true },
      { workspace: 'default', account: 'nc', provider: 'namecheap', label: '', writesTxt: false, hasCredentials: true },
      { workspace: 'lab', account: 'do', provider: 'digitalocean', label: 'Lab', writesTxt: true, hasCredentials: false },
    ])

    // The empty value is the single-account fallback, so a one-account setup is a no-op.
    expect(options[0]).toEqual({ value: '', label: 'Automatic (the only account that can answer)' })
    expect(options[1]).toEqual({ value: 'default/cf', label: 'Home zone · cloudflare · default' })
    // An account that cannot write TXT is still listed, so the reason is visible.
    expect(options[2]!.label).toContain('no TXT support')
    expect(options[3]!.label).toContain('no credentials')
  })
})

describe('the ACME e-mail rule', () => {
  it('is needed for a public name served over TLS', () => {
    const drafts = cloneRoutes([route({ host: 'gitea.example.com' })])
    expect(requiresEmail({ email: '', staging: false }, drafts)).toBe(true)
    expect(firstPublicHost(drafts)).toBe('gitea.example.com')
  })

  it('is not needed for a local name, TLS off, an address, or staging', () => {
    const local = cloneRoutes([route({ host: 'gitea.local' })])
    expect(requiresEmail({ email: '', staging: false }, local)).toBe(false)

    const plain = cloneRoutes([route({ host: 'gitea.example.com', tls: 'off' })])
    expect(requiresEmail({ email: '', staging: false }, plain)).toBe(false)

    const staging = cloneRoutes([route({ host: 'gitea.example.com' })])
    expect(requiresEmail({ email: '', staging: true }, staging)).toBe(false)

    const filled = cloneRoutes([route({ host: 'gitea.example.com' })])
    expect(requiresEmail({ email: 'me@example.com', staging: false }, filled)).toBe(false)
  })
})

describe('route ids', () => {
  it('slugs a hostname into an id the panel accepts', () => {
    expect(slugifyRouteId('gitea.example.com')).toBe('gitea-example-com')
    expect(slugifyRouteId('*.example.com')).toBe('example-com')
    expect(slugifyRouteId('—')).toBe('route')
    expect(slugifyRouteId('_hidden.example.com')).toMatch(/^[a-z0-9]/)
  })

  it('walks past an id another route already holds', () => {
    expect(uniqueRouteId('gitea', [])).toBe('gitea')
    expect(uniqueRouteId('gitea', ['gitea'])).toBe('gitea-2')
    expect(uniqueRouteId('gitea', ['gitea', 'gitea-2'])).toBe('gitea-3')
  })
})

describe('validateRouteDraft', () => {
  const workspaces = [{ id: 'default', label: 'Default', servers: [{ id: 'gitea' }] }]

  it('asks for a hostname and a workspace/server pair', () => {
    const found = validateRouteDraft(newRouteDraft(), { others: [], workspaces })
    expect(found.host).toBeTruthy()
    expect(found.workspace).toBeTruthy()
  })

  /**
   * The field checks that only fire on a specific bad input.
   *
   * These branches were uncovered, and each one is a rule a person can hit: a space in the path, an
   * id that cannot be a URL segment, an id used twice, and a value only the schema rejects.
   */
  it('refuses each malformed field with its own message', () => {
    const base = (over: Record<string, unknown>) => ({ ...newRouteDraft(), host: 'ok.example.com', ...over }) as ReturnType<typeof newRouteDraft>

    // A path prefix cannot contain a space.
    expect(validateRouteDraft(base({ path: '/a b' }), { others: [], workspaces }).path)
      .toBe('a path prefix cannot contain a space')
    // An id must be URL-safe.
    expect(validateRouteDraft(base({ id: 'bad id!' }), { others: [], workspaces }).id)
      .toContain('the id must start with a letter or digit')
    // The same id twice in one table.
    const twice = base({ id: 'gitea', host: 'two.example.com' })
    expect(validateRouteDraft(twice, { others: [{ ...newRouteDraft(), id: 'gitea' }], workspaces }).id)
      .toContain('is used twice')
    // A path that does not start with a slash.
    expect(validateRouteDraft(base({ path: 'app' }), { others: [], workspaces }).path)
      .toBe('a path prefix starts with /')
  })

  it('accepts a server route once both halves are picked', () => {
    const draft = { ...newRouteDraft(), host: 'gitea.example.com', workspace: 'default', server: 'gitea' }
    expect(validateRouteDraft(draft, { others: [], workspaces })).toEqual({})
  })

  it('refuses a hostname routed twice for the same path', () => {
    const existing = { ...newRouteDraft(), id: 'gitea', host: 'gitea.example.com' }
    const draft = { ...newRouteDraft(), id: 'other', host: 'GITEA.example.com' }
    expect(validateRouteDraft(draft, { others: [existing], workspaces }).host).toBeTruthy()
  })

  it('reads `/app` and `/app/` as one path', () => {
    // The panel renders overlapping matchers for them, so one shadows the other.
    const existing = { ...newRouteDraft(), id: 'a', host: 'app.example.com', path: '/app' }
    const draft = { ...newRouteDraft(), id: 'b', host: 'app.example.com', path: '/app/' }
    expect(validateRouteDraft(draft, { others: [existing], workspaces }).host).toBeTruthy()
  })

  it('wants a dialable upstream for an external target', () => {
    const base = { ...newRouteDraft(), host: 'app.example.com', target: 'external' as const }
    // A port is optional — the panel fills in the scheme's default — so only an
    // address that could never be dialled is refused.
    expect(validateRouteDraft({ ...base, url: 'http://10.0.0.5' }, { others: [], workspaces })).toEqual({})
    expect(validateRouteDraft({ ...base, url: 'http://10.0.0.5:8080' }, { others: [], workspaces })).toEqual({})
    expect(validateRouteDraft({ ...base, url: '10.0.0.5:8080' }, { others: [], workspaces })).toEqual({})
    expect(validateRouteDraft({ ...base, url: 'not a url' }, { others: [], workspaces }).url).toBeTruthy()
  })

  it('does not ask for a server when the target is the panel or an upstream', () => {
    const panel = { ...newRouteDraft(), host: 'panel.example.com', target: 'panel' as const }
    expect(validateRouteDraft(panel, { others: [], workspaces })).toEqual({})
  })

  it('wants a path prefix to start with a slash', () => {
    const draft = { ...newRouteDraft(), host: 'gitea.example.com', workspace: 'default', server: 'gitea', path: 'gitea' }
    expect(validateRouteDraft(draft, { others: [], workspaces }).path).toBeTruthy()
  })

  it('refuses a server that is not in the picked workspace', () => {
    const draft = { ...newRouteDraft(), host: 'gitea.example.com', workspace: 'default', server: 'ghost' }
    expect(validateRouteDraft(draft, { others: [], workspaces }).server).toBeTruthy()
  })
})

describe('parseUpstream', () => {
  it('reads a host and port, with or without a scheme', () => {
    expect(parseUpstream('http://10.0.0.5:8080')).toEqual({ host: '10.0.0.5', port: '8080' })
    expect(parseUpstream('10.0.0.5:8080')).toEqual({ host: '10.0.0.5', port: '8080' })
    expect(parseUpstream('https://nas.local:9000/x')).toEqual({ host: 'nas.local', port: '9000' })
  })

  it('fills in the scheme’s default port when none is typed', () => {
    // The panel keeps a default port — `new URL('http://10.0.0.5:80').port` is `''` —
    // so a dialog that called this unusable refused a upstream the panel accepts.
    expect(parseUpstream('http://10.0.0.5')).toEqual({ host: '10.0.0.5', port: '80' })
    expect(parseUpstream('https://srv.lan')).toEqual({ host: 'srv.lan', port: '443' })
    expect(parseUpstream('10.0.0.5')).toEqual({ host: '10.0.0.5', port: '80' })
  })

  it('refuses anything it could not dial', () => {
    expect(parseUpstream('')).toBeNull()
    expect(parseUpstream('http://10.0.0.5:')).toBeNull()
    expect(parseUpstream('http://10.0.0.5:abc')).toBeNull()
  })
})

describe('the copy the page shows', () => {
  const workspaces = [{ id: 'default', label: 'Default', servers: [{ id: 'gitea' }] }]

  it('names the workspace and server a route forwards to', () => {
    expect(targetSummary(route({ workspace: 'default', server: 'gitea' }), workspaces)).toBe('Default / gitea')
    expect(targetSummary(route({ target: 'panel' }), workspaces)).toBe('control panel')
    expect(targetSummary(route({ target: 'external', url: 'http://10.0.0.5:8080' }), workspaces)).toBe('http://10.0.0.5:8080')
    expect(targetSummary(route(), workspaces)).toBe('no server picked')
  })

  it('says which certificate a TLS mode produces', () => {
    expect(tlsSummary(route({ host: 'gitea.example.com' }))).toBe('Let\u2019s Encrypt')
    expect(tlsSummary(route({ host: 'gitea.local' }))).toBe('engine CA (local)')
    expect(tlsSummary(route({ tls: 'off' }))).toBe('plain HTTP')
    expect(tlsSummary(route({ tls: 'manual' }))).toBe('uploaded certificate')
  })

  it('knows the privileged ports and the fallback pair', () => {
    expect(isPrivilegedPort(80)).toBe(true)
    expect(isPrivilegedPort(443)).toBe(true)
    expect(isPrivilegedPort(4480)).toBe(false)
    expect(usesFallbackPorts({ httpPort: UNPRIVILEGED_HTTP_PORT, httpsPort: UNPRIVILEGED_HTTPS_PORT })).toBe(true)
    expect(usesFallbackPorts({ httpPort: 80, httpsPort: 443 })).toBe(false)
  })
})
