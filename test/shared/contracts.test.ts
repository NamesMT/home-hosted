import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import {
  appStateSchema,
  authSchema,
  backupCreateSchema,
  bootstrapOrNullSchema,
  ddnsConfigSchema,
  ddnsDomainSchema,
  ddnsStatusSchema,
  defaultsSchema,
  healthSchema,
  logBufferLinesSchema,
  logsSchema,
  onPortConflictSchema,
  passwordSchema,
  passwordValueSchema,
  portSchema,
  proxyCertificateSchema,
  proxyConfigSchema,
  proxyEngineStatusSchema,
  proxyPatchSchema,
  proxyRouteSchema,
  proxyRouteViewSchema,
  proxyStatusSchema,
  proxyViewSchema,
  restartSchema,
  serverCreateSchema,
  serverPatchSchema,
  serverSchema,
  serverViewSchema,
  settingsPatchSchema,
  telegramSchema,
  workspaceSettingsPatchSchema,
  workspaceViewSchema,
} from '#src/shared/contracts'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

type JsonProperties = Record<string, { properties?: Record<string, unknown> }>

function properties(schema: { toJsonSchema: () => unknown }): JsonProperties {
  return (schema.toJsonSchema() as { properties: JsonProperties }).properties
}

function unwrap<T>(value: T | type.errors): T {
  if (value instanceof type.errors)
    throw new Error(value.summary)
  return value
}

describe('server schema', () => {
  it('accepts a port, and null for "no port"', () => {
    expect(portSchema(4000)).toBe(4000)
    expect(portSchema(null)).toBeNull()
    expect(portSchema(0) instanceof type.errors).toBe(true)
    expect(portSchema(70000) instanceof type.errors).toBe(true)
  })

  it('rejects a malformed env map', () => {
    const parsed = serverSchema({ id: 'a', command: 'node', env: { FINE: 'x', BAD: 1 } })
    expect(parsed instanceof type.errors).toBe(true)
  })

  it('accepts a data env map and rejects a non-string path', () => {
    const parsed = serverSchema({ id: 'a', command: 'node', dataEnvs: { DATA_DIR: '/srv/a' } })
    expect(parsed).toMatchObject({ dataEnvs: { DATA_DIR: '/srv/a' } })
    expect(serverSchema({ id: 'a', command: 'node', dataEnvs: { DATA_DIR: 1 } }) instanceof type.errors).toBe(true)
    expect(unwrap(serverSchema({ id: 'a', command: 'node' })).dataEnvs).toEqual({})
  })

  it('accepts null bootstrap and enforces its numeric bounds', () => {
    expect(bootstrapOrNullSchema(null)).toBeNull()
    expect(bootstrapOrNullSchema({ command: 'node' })).toMatchObject({ command: 'node', runOnce: true })
    expect(bootstrapOrNullSchema({ command: 'node', timeoutMs: 10 }) instanceof type.errors).toBe(true)
  })

  it('rejects an unknown bind host but accepts local/lan/ipv4', () => {
    expect(unwrap(serverSchema({ id: 'a', command: 'node', bind: 'lan' })).bind).toBe('lan')
    expect(unwrap(serverSchema({ id: 'a', command: 'node', bind: '10.0.0.5' })).bind).toBe('10.0.0.5')
    expect(serverSchema({ id: 'a', command: 'node', bind: 'not a host' }) instanceof type.errors).toBe(true)
  })

  it('bounds logBufferLines', () => {
    expect(logBufferLinesSchema(500)).toBe(500)
    expect(logBufferLinesSchema(10) instanceof type.errors).toBe(true)
  })

  it('pins every onPortConflict value, and defaults to block', () => {
    for (const value of ['block', 'warn', 'follow', 'reclaim', 'kill'] as const)
      expect(onPortConflictSchema(value)).toBe(value)

    expect(onPortConflictSchema('nuke') instanceof type.errors).toBe(true)
    expect(unwrap(serverSchema({ id: 'a', command: 'node' })).onPortConflict).toBe('block')
    // A patch carries only what changed, so it must not fill the default in.
    expect(unwrap(serverPatchSchema({}))).toEqual({})
    expect(unwrap(serverPatchSchema({ onPortConflict: 'kill' }))).toEqual({ onPortConflict: 'kill' })
  })
})

describe('patch surface', () => {
  it('covers every editable field of the server schema, and only those', () => {
    const full = Object.keys(properties(serverSchema)).sort()
    const patch = Object.keys(properties(serverPatchSchema)).sort()
    expect([...patch, 'id'].sort()).toEqual(full)
  })

  it('mirrors each nested group field for field', () => {
    const full = properties(serverSchema)
    const patch = properties(serverPatchSchema)
    for (const group of ['restart', 'health', 'stop'] as const) {
      expect(Object.keys(patch[group]?.properties ?? {}).sort(), group)
        .toEqual(Object.keys(full[group]?.properties ?? {}).sort())
    }
  })

  it('keeps the nested patch groups free of defaults', () => {
    const patch = serverPatchSchema({ restart: { maxRetries: 9 } })
    expect(patch).toEqual({ restart: { maxRetries: 9 } })
    expect(unwrap(restartSchema({})).enabled).toBe(true)
  })

  it('rejects unknown keys instead of keeping them', () => {
    expect(serverSchema({ id: 'a', command: 'node', typo: true } as unknown) instanceof type.errors).toBe(true)
    expect(serverPatchSchema({ dataDir: '/tmp/x' } as unknown) instanceof type.errors).toBe(true)
    expect(serverPatchSchema({ restart: { maxRetries: 1, typo: 2 } } as unknown) instanceof type.errors).toBe(true)
    expect(serverCreateSchema({ id: 'a', command: 'node', autostartt: true } as unknown) instanceof type.errors).toBe(true)
    expect(unwrap(serverPatchSchema({ restart: { maxRetries: 1 } }))).toEqual({ restart: { maxRetries: 1 } })
  })

  it('mirrors dataEnvs and the backup payloads', () => {
    expect(unwrap(serverPatchSchema({ dataEnvs: { DATA_DIR: '/srv/a' } }))).toEqual({ dataEnvs: { DATA_DIR: '/srv/a' } })
    expect(backupCreateSchema({}) instanceof type.errors).toBe(false)
    expect(backupCreateSchema({ password: 'hunter2' }) instanceof type.errors).toBe(false)
    expect(backupCreateSchema({ password: '' }) instanceof type.errors).toBe(true)
    expect(backupCreateSchema({ include: ['config', 'data:/srv/a'] }) instanceof type.errors).toBe(false)
    expect(backupCreateSchema({ include: [] }) instanceof type.errors).toBe(true)
    expect(backupCreateSchema({ include: 'config' } as unknown) instanceof type.errors).toBe(true)
  })

  it('requires id and command to create', () => {
    expect(serverCreateSchema({ id: 'a' }) instanceof type.errors).toBe(true)
    expect(serverCreateSchema({ id: 'a', command: 'node' })).toMatchObject({ id: 'a', command: 'node' })
    expect(serverCreateSchema({ id: 'Bad Id', command: 'node' }) instanceof type.errors).toBe(true)
  })
})

describe('view contracts', () => {
  it('parses a state payload that carries the full effective config', () => {
    const config = serverSchema({ id: 'web', command: 'node', port: null })
    const view = {
      id: 'web',
      config,
      bindHost: '127.0.0.1',
      url: null,
      status: 'stopped',
      health: 'unknown',
      portState: 'free',
      pid: null,
      startedAt: null,
      exitCode: null,
      exitSignal: null,
      restarts: 0,
      maxRetries: 3,
      lastError: null,
      nextRetryAt: null,
      unhealthySince: null,
      bufferedLines: 0,
      responseMs: null,
      resources: null,
      history: {
        windowMs: 86400000,
        uptimeRatio: null,
        restarts: 0,
        crashes: 0,
        forcedRestarts: 0,
        lastCrashAt: null,
        lastExitAt: null,
        lastRuntimeMs: null,
        events: [],
      },
    }

    expect(serverViewSchema(view) instanceof type.errors).toBe(false)

    // Everything a workspace owns now lives under `workspaces`, not at the top.
    const workspace = {
      id: 'default',
      label: 'Default',
      configPath: '/repo/.home-hosted/.hh/default/servers.config.json',
      settingsPath: '/repo/.home-hosted/.hh/default/settings.json',
      configError: null,
      logsDir: '/repo/.home-hosted/.hh/default/.logs',
      defaults: unwrap(defaultsSchema({})),
      logs: unwrap(logsSchema({})),
      notifications: {
        telegram: {
          enabled: false,
          tokenSet: false,
          chatId: '',
          onCrash: true,
          onUnhealthy: true,
          onForcedRestart: true,
          onRecovered: false,
          onHost: true,
          onDdns: true,
          cooldownMs: 120000,
          lastResult: null,
          lastResultAt: null,
        },
      },
      serverCount: 1,
      runningCount: 0,
      crashedCount: 0,
      servers: [view],
    }

    expect(workspaceViewSchema(workspace) instanceof type.errors).toBe(false)

    const state = appStateSchema({
      control: {
        label: 'Stock UI',
        port: 3999,
        host: 'local',
        bindHost: '127.0.0.1',
        url: 'http://127.0.0.1:3999',
        openBrowser: false,
        restartRequired: false,
        auth: {
          enabled: false,
          passwordSet: false,
          passwordUpdatedAt: null,
          apiTokenSet: false,
          exposed: false,
          blockedReason: null,
          sessionTtlMs: 604800000,
          cookieSecure: 'auto',
          trustProxy: false,
          maxLoginAttempts: 5,
          lockoutMs: 60000,
          usingDefaultPassword: false,
        },
        tls: {
          enabled: false,
          certPresent: false,
          subject: null,
          issuer: null,
          validFrom: null,
          validTo: null,
          daysRemaining: null,
          fingerprint: null,
          keyMatches: null,
          error: null,
        },
        protocol: 'http',
      },
      host: {
        enabled: true,
        cpus: 4,
        loadAvg: [0.1, 0.2, 0.3],
        uptimeMs: 1000,
        memoryUsedPercent: 10,
        swapUsedPercent: 0,
        tempCelsius: null,
        disks: [],
        alerts: [],
        sampledAt: null,
      },
      backups: { enabled: true, dir: '/repo/.backups', keep: 5, includePaths: [], entries: [], files: [] },
      ui: { custom: false, dir: '/repo/.home-hosted/.hh/.ui', meta: null },
      workspaces: [workspace],
      projectDir: '/repo',
      dataRoot: '/repo/.home-hosted',
    })
    // No `version`: a panel from before the field still frames a state the UI accepts.
    expect(state instanceof type.errors).toBe(false)
    expect(appStateSchema({ ...(state as Record<string, unknown>), version: '0.7.0' }) instanceof type.errors).toBe(false)
  })
})

/** The control plane must stay server-agnostic: no blessed paths, no blessed ids. */
describe('genericity', () => {
  const coreFiles = [
    'src/index.ts',
    'src/app.ts',
    'src/config/schema.ts',
    'src/config/store.ts',
    'src/services/supervisor.ts',
    'src/services/events.ts',
    'src/services/log-buffer.ts',
    'src/helpers/paths.ts',
    'src/helpers/template.ts',
    'src/providers/process.ts',
    'src/providers/port.ts',
    'src/shared/contracts.ts',
    'src/shared/patch-diff.ts',
    'src/api/state.ts',
    'src/api/events.ts',
    'src/api/static.ts',
    'src/api/servers/$.routes.ts',
  ]

  it('has no server-specific global config or placeholders', async () => {
    for (const file of coreFiles) {
      const text = await fs.promises.readFile(path.join(packageRoot, file), 'utf8')
      expect(text, `${file} must not know about omniroute`).not.toMatch(/omniroute/i)
      expect(text, `${file} must not define a dataDir/staticDir global`).not.toMatch(/\b(dataDir|staticDir)\b/)
    }
  })
})

describe('password payload', () => {
  it('accepts an omitted current password but not an explicit undefined', () => {
    expect(passwordSchema({ newPassword: 'a-good-password' }) instanceof type.errors).toBe(false)
    expect(passwordSchema({ currentPassword: undefined, newPassword: 'a-good-password' } as unknown) instanceof type.errors).toBe(true)
    expect(passwordSchema({ currentPassword: 'old-one', newPassword: 'a-good-password' }) instanceof type.errors).toBe(false)
  })

  it('accepts any non-empty password but rejects an empty one', () => {
    expect(passwordSchema({ newPassword: 'a' }) instanceof type.errors).toBe(false)
    expect(passwordSchema({ newPassword: 'hh' }) instanceof type.errors).toBe(false)
    expect(passwordSchema({ newPassword: '' }) instanceof type.errors).toBe(true)
  })
})

/** Two-sided bounds are written inclusively (`1 <= number <= 512`); these pin them down. */
describe('numeric bounds', () => {
  const ok = (schema: (input: unknown) => unknown, input: unknown): boolean =>
    !(schema(input) instanceof type.errors)

  it('holds the server bounds', () => {
    expect(portSchema(1)).toBe(1)
    expect(portSchema(65535)).toBe(65535)
    expect(ok(portSchema, 0)).toBe(false)
    expect(ok(portSchema, 65536)).toBe(false)

    expect(ok(logBufferLinesSchema, 50)).toBe(true)
    expect(ok(logBufferLinesSchema, 100000)).toBe(true)
    expect(ok(logBufferLinesSchema, 49)).toBe(false)
    expect(ok(logBufferLinesSchema, 100001)).toBe(false)
  })

  it('holds the restart bounds', () => {
    expect(ok(restartSchema, { maxRetries: 0 })).toBe(true)
    expect(ok(restartSchema, { maxRetries: -1 })).toBe(false)
    expect(ok(restartSchema, { baseDelayMs: 0 })).toBe(true)
    expect(ok(restartSchema, { baseDelayMs: -1 })).toBe(false)
    expect(ok(restartSchema, { factor: 1 })).toBe(true)
    expect(ok(restartSchema, { factor: 3 })).toBe(true)
    expect(ok(restartSchema, { factor: 0 })).toBe(false)
    expect(ok(restartSchema, { factor: 0.5 })).toBe(false)
  })

  it('holds the health bounds', () => {
    expect(ok(healthSchema, { intervalMs: 500 })).toBe(true)
    expect(ok(healthSchema, { intervalMs: 499 })).toBe(false)
    expect(ok(healthSchema, { timeoutMs: 100 })).toBe(true)
    expect(ok(healthSchema, { timeoutMs: 99 })).toBe(false)
    expect(ok(healthSchema, { unhealthyThreshold: 1 })).toBe(true)
    expect(ok(healthSchema, { unhealthyThreshold: 0 })).toBe(false)
    expect(ok(healthSchema, { forceRestartAfterMs: 0 })).toBe(true)
    expect(ok(healthSchema, { forceRestartAfterMs: -1 })).toBe(false)
  })

  it('holds the auth and log bounds', () => {
    expect(ok(authSchema, { sessionTtlMs: 60000 })).toBe(true)
    expect(ok(authSchema, { sessionTtlMs: 59999 })).toBe(false)
    expect(ok(authSchema, { maxLoginAttempts: 1 })).toBe(true)
    expect(ok(authSchema, { maxLoginAttempts: 0 })).toBe(false)
    expect(ok(logsSchema, { maxBytes: 10000 })).toBe(true)
    expect(ok(logsSchema, { maxBytes: 9999 })).toBe(false)
    expect(ok(logsSchema, { keep: 1 })).toBe(true)
    expect(ok(logsSchema, { keep: 10 })).toBe(true)
    expect(ok(logsSchema, { keep: 11 })).toBe(false)
  })

  it('treats the password as any non-empty string with a sane cap', () => {
    expect(passwordValueSchema('x')).toBe('x')
    expect(passwordValueSchema('hh')).toBe('hh')
    expect(passwordValueSchema('y'.repeat(512))).toHaveLength(512)
    expect(ok(passwordValueSchema, '')).toBe(false)
    expect(ok(passwordValueSchema, 'y'.repeat(513))).toBe(false)
  })
})

describe('dynamic DNS schema', () => {
  const ok = (schema: (input: unknown) => unknown, input: unknown): boolean => !(schema(input) instanceof type.errors)

  it('defaults every new block, and keeps IPv6 off until asked for', () => {
    const parsed = unwrap(ddnsConfigSchema({}))
    expect(parsed).toMatchObject({ enabled: false, intervalMs: 300000, ttl: 1 })
    expect(parsed.ipv4).toEqual({ enabled: true, url: '' })
    expect(parsed.ipv6).toEqual({ enabled: false, url: '' })
    expect(parsed.accounts).toEqual([])
    expect(parsed.domains).toEqual([])
  })

  it('defaults a hostname to an A record, not proxied', () => {
    const parsed = unwrap(ddnsConfigSchema({ accounts: [{ id: 'cf', provider: 'cloudflare' }], domains: [{ host: 'home.example.com', account: 'cf' }] }))
    // Proxying belongs to the record, so there is no panel-wide default for it.
    expect(parsed.domains[0]).toMatchObject({ types: ['A'], enabled: true, proxied: false })
    expect(parsed).not.toHaveProperty('proxied')
  })

  it('rejects a hostname that is not one, and an unknown record family', () => {
    expect(ok(ddnsDomainSchema, { host: 'not a host', account: 'cf' })).toBe(false)
    expect(ok(ddnsDomainSchema, { host: 'home', account: 'cf' })).toBe(false)
    expect(ok(ddnsConfigSchema, { domains: [{ host: 'home.example.com', account: 'cf', types: ['TXT'] }] })).toBe(false)
  })

  it('keeps the interval sane', () => {
    expect(ok(ddnsConfigSchema, { intervalMs: 60000 })).toBe(true)
    expect(ok(ddnsConfigSchema, { intervalMs: 59999 })).toBe(false)
    expect(ok(ddnsConfigSchema, { ttl: 0 })).toBe(false)
  })

  it('carries DDNS into the Telegram policy, defaulting on', () => {
    expect(unwrap(telegramSchema({})).onDdns).toBe(true)
    const patch = unwrap(workspaceSettingsPatchSchema({ notifications: { telegram: { onDdns: false } } }))
    expect(patch.notifications?.telegram?.onDdns).toBe(false)
    // Notifications belong to a workspace now: the global patch rejects the block.
    expect(settingsPatchSchema({ notifications: { telegram: {} } } as unknown) instanceof type.errors).toBe(true)
  })

  it('lets a state frame from a panel without DDNS still parse', () => {
    const withDdns = unwrap(ddnsStatusSchema({ enabled: true, running: false, lastRunAt: null, lastResult: null, ipv4: '203.0.113.7', ipv6: null, records: [] }))
    expect(withDdns.records).toEqual([])
    // DDNS moved into the workspace subtree, and stays optional there.
    expect('ddns' in properties(workspaceViewSchema)).toBe(true)
    expect('ddns' in properties(appStateSchema)).toBe(false)
  })
})

describe('reverse proxy schema', () => {
  const ok = (schema: (input: unknown) => unknown, input: unknown): boolean => !(schema(input) instanceof type.errors)

  it('is off with no engine installed and nothing routed', () => {
    const parsed = unwrap(proxyConfigSchema({}))
    expect(parsed).toMatchObject({ enabled: false, engine: 'caddy', httpPort: 80, httpsPort: 443, email: '', staging: false })
    expect(parsed.routes).toEqual([])
  })

  it('defaults a route to the supervised entry, automatic TLS, whole host', () => {
    const route = unwrap(proxyRouteSchema({ id: 'gitea', host: 'git.example.com' }))
    expect(route).toMatchObject({ enabled: true, target: 'server', tls: 'auto', path: '', workspace: '', server: '', url: '' })
  })

  it('accepts a single-label local name and refuses something that is not a host', () => {
    expect(ok(proxyRouteSchema, { id: 'a', host: 'gitea' })).toBe(true)
    expect(ok(proxyRouteSchema, { id: 'a', host: 'media.lan' })).toBe(true)
    expect(ok(proxyRouteSchema, { id: 'a', host: 'not a host' })).toBe(false)
    expect(ok(proxyRouteSchema, { id: 'a', host: '*.example.com' })).toBe(false)
    expect(ok(proxyRouteSchema, { id: 'Bad', host: 'git.example.com' })).toBe(false)
  })

  it('keeps both ports inside the range, and the mode set closed', () => {
    expect(ok(proxyConfigSchema, { httpPort: 1, httpsPort: 65535 })).toBe(true)
    expect(ok(proxyConfigSchema, { httpPort: 0 })).toBe(false)
    expect(ok(proxyConfigSchema, { httpsPort: 65536 })).toBe(false)
    expect(ok(proxyConfigSchema, { httpsPort: 443.5 })).toBe(false)
    expect(ok(proxyRouteSchema, { id: 'a', host: 'a.example.com', tls: 'letsencrypt' })).toBe(false)
    expect(ok(proxyConfigSchema, { engine: 'traefik' })).toBe(false)
  })

  it('keeps the uploaded pairs in the config, and replaces the list in a patch', () => {
    const parsed = unwrap(proxyConfigSchema({ certificates: [{ id: 'mine', label: 'Mine' }] }))
    expect(parsed.certificates).toEqual([{ id: 'mine', label: 'Mine' }])
    expect(unwrap(proxyConfigSchema({})).certificates).toEqual([])
    expect(ok(proxyCertificateSchema, { id: 'Bad Id' })).toBe(false)
    expect(unwrap(proxyPatchSchema({ certificates: [] })).certificates).toEqual([])
  })

  it('reports where a route certificate stands', () => {
    const route = unwrap(proxyRouteSchema({ id: 'a', host: 'a.example.com' }))
    const view = unwrap(proxyRouteViewSchema({
      route,
      status: 'ok',
      upstream: '127.0.0.1:3000',
      message: null,
      certificate: { state: 'pending', message: 'the engine is waiting for a certificate' },
    }))
    expect(view.certificate?.state).toBe('pending')
    // Optional: an older panel's frame still parses without it.
    expect(unwrap(proxyRouteViewSchema({ route, status: 'ok', upstream: null, message: null })).certificate).toBeUndefined()
    expect(ok(proxyRouteViewSchema, { route, status: 'ok', upstream: null, message: null, certificate: { state: 'nope', message: null } })).toBe(false)
  })

  it('carries no defaults in the patch, and replaces the route list', () => {
    const patch = unwrap(proxyPatchSchema({ httpPort: 4480 }))
    expect(patch).toEqual({ httpPort: 4480 })
    expect(unwrap(proxyPatchSchema({ routes: [] })).routes).toEqual([])
    expect(proxyPatchSchema({ engine: 'nginx' } as unknown) instanceof type.errors).toBe(true)
  })

  it('describes an engine that has not been installed yet', () => {
    const engine = unwrap(proxyEngineStatusSchema({ id: 'caddy', installed: false, version: null, source: null, path: null, bytes: null, error: null }))
    expect(engine.installed).toBe(false)
    const status = unwrap(proxyStatusSchema({ state: 'off', pid: null, urls: [], certExpiryDays: null, since: null, lastError: null }))
    expect(status.state).toBe('off')
  })

  it('reads without the optional live-state fields', () => {
    const view = unwrap(proxyViewSchema({
      config: {},
      engine: { id: 'caddy', installed: false, version: null, source: null, path: null, bytes: null, error: null },
      engines: [{ id: 'caddy', label: 'Caddy', docsUrl: 'https://caddyserver.com/docs/', releaseUrl: '', acme: true, internalCa: true, dns01: false, tcp: false }],
      status: { state: 'off', pid: null, urls: [], certExpiryDays: null, since: null, lastError: null },
      routes: [],
      certificates: [],
    }))
    expect(view.routes).toEqual([])
    expect(view.certificates).toEqual([])
  })
})
