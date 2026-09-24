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
  defaultsSchema,
  healthSchema,
  logBufferLinesSchema,
  logsSchema,
  passwordSchema,
  passwordValueSchema,
  portSchema,
  restartSchema,
  serverCreateSchema,
  serverPatchSchema,
  serverSchema,
  serverViewSchema,
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
      defaults: unwrap(defaultsSchema({})),
      logs: unwrap(logsSchema({})),
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
      backups: { enabled: true, dir: '/repo/.backups', keep: 5, includePaths: [], paths: [], files: [] },
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
          cooldownMs: 120000,
          lastResult: null,
          lastResultAt: null,
        },
      },
      configPath: '/tmp/servers.config.json',
      configError: null,
      projectDir: '/repo',
      dataRoot: '/repo/.home-hosted',
      logsDir: '/repo/.logs',
      servers: [view],
    })
    expect(state instanceof type.errors).toBe(false)
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
      expect(text, `${file} must not know about 9router`).not.toMatch(/9router/i)
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
