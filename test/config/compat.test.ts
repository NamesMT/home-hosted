import type { ConfigMigration } from '#src/config/migrations'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyConfigMigrations, CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import { parseGlobalSettings, parseServersFile, parseWorkspaceSettings, stampConfig } from '#src/config/parse'
import { appVersion } from '#src/helpers/version'

const fixtures = fileURLToPath(new URL('../fixtures/config/', import.meta.url))

/**
 * A released config must keep loading, forever. The old all-in-one file is now
 * split three ways by the layout migration, so each released shape is read through
 * the reader that owns it — the end-to-end version of this (a real legacy home
 * migrated, then loaded) lives in `layout.test.ts`.
 */
function fixture(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8')) as Record<string, any>
}

function pick(raw: Record<string, any>, keys: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of keys) {
    if (raw[key] !== undefined)
      out[key] = raw[key]
  }
  return out
}

const GLOBAL_KEYS = ['$schema', 'meta', 'control', 'host', 'backups'] as const
const WORKSPACE_KEYS = ['$schema', 'meta', 'defaults', 'logs', 'notifications', 'ddns'] as const
const SERVERS_KEYS = ['$schema', 'meta', 'servers'] as const

describe('reading configs from other releases', () => {
  it('loads a config written by the last release, unchanged', () => {
    const raw = fixture('v0.3.0.json')

    const global = parseGlobalSettings(pick(raw, GLOBAL_KEYS))
    expect(global.errors).toEqual([])
    expect(global.warnings).toEqual([])
    expect(global.unknownKeys).toEqual([])
    expect(global.schemaVersion).toBe(CONFIG_SCHEMA)
    expect(global.config?.control.port).toBe(3999)
    expect(global.config?.control.label).toBe('Home server')

    const workspace = parseWorkspaceSettings(pick(raw, WORKSPACE_KEYS))
    expect(workspace.errors).toEqual([])
    expect(workspace.config?.defaults.bind).toBe('local')
    expect(workspace.config?.logs.keep).toBe(3)

    const servers = parseServersFile(pick(raw, SERVERS_KEYS), workspace.config?.defaults as unknown as Record<string, unknown> ?? {})
    expect(servers.errors).toEqual([])
    expect(servers.servers.map(server => server.id)).toEqual(['omniroute', 'static'])
    expect(servers.servers[1]?.port).toBe(4010)
    // The workspace's own default reached the entry that did not decide it.
    expect(servers.servers[1]?.bind).toBe('local')
  })

  it('treats an unstamped file as the current schema', () => {
    const parsed = parseGlobalSettings({ control: { port: 3999 } })

    expect(parsed.writtenBy).toBeNull()
    expect(parsed.schemaVersion).toBe(CONFIG_SCHEMA)
    expect(parsed.config?.meta).toEqual({ writtenBy: '', schema: CONFIG_SCHEMA })
    expect(parsed.config?.control.port).toBe(3999)
  })

  it('keeps what it knows of a config from a newer release, and lists the rest', () => {
    const raw = fixture('newer-release.json')

    const global = parseGlobalSettings(pick(raw, GLOBAL_KEYS))
    expect(global.errors).toEqual([])
    expect(global.writtenBy).toBe('0.4.0')
    // The values around the unknown keys survived, including nested groups.
    expect(global.config?.control.port).toBe(4123)
    expect(global.config?.control.auth.enabled).toBe(true)
    expect(global.unknownKeys).toEqual(expect.arrayContaining([
      'control.futurePanelFlag',
      'control.auth.futureAuthField',
    ]))

    const servers = parseServersFile(pick(raw, SERVERS_KEYS), {})
    expect(servers.errors).toEqual([])
    expect(servers.servers[0]?.port).toBe(4200)
    expect(servers.servers[0]?.health.enabled).toBe(true)
    expect(servers.unknownKeys).toEqual(expect.arrayContaining([
      'servers[0].futureEntryField',
      'servers[0].health.futureHealthField',
    ]))
  })

  it('reports a top-level key a newer release added instead of failing the file', () => {
    const global = parseGlobalSettings({ control: { port: 4123 }, futureTopLevelBlock: { anything: true } })

    expect(global.errors).toEqual([])
    expect(global.unknownKeys).toContain('futureTopLevelBlock')
    expect(global.config?.control.port).toBe(4123)

    const workspace = parseWorkspaceSettings({ defaults: { autostart: true }, futureWorkspaceBlock: 1 })
    expect(workspace.errors).toEqual([])
    expect(workspace.unknownKeys).toContain('futureWorkspaceBlock')
    expect(workspace.config?.defaults.autostart).toBe(true)
  })

  it('refuses a config from a release it cannot understand', () => {
    const global = parseGlobalSettings(fixture('from-the-future.json'))
    expect(global.config).toBeNull()
    expect(global.schemaVersion).toBe(99)
    expect(global.errors.join(' ')).toContain('9.9.9')
    expect(global.errors.join(' ')).toContain('schema 99')

    const servers = parseServersFile(fixture('from-the-future.json'), {})
    expect(servers.servers).toEqual([])
    expect(servers.errors.join(' ')).toContain('schema 99')
  })

  it('refuses a config that needs a migration, before running one', () => {
    // A synthetic step stands in for the first real migration this project ships.
    const options = {
      to: 2,
      migrations: [{ to: 2, describe: 'add the thing', apply: (config: Record<string, unknown>) => config }] as ConfigMigration[],
    }
    const global = parseGlobalSettings({ meta: { schema: 1 }, control: { port: 3999 } }, options)
    expect(global.config).toBeNull()
    expect(global.errors.join(' ')).toContain('needs 1 migration')

    const servers = parseServersFile({ meta: { schema: 1 }, servers: [] }, {}, options)
    expect(servers.servers).toEqual([])
    expect(servers.errors.join(' ')).toContain('needs 1 migration')
  })

  it('refuses a file that is not an object at all', () => {
    expect(parseGlobalSettings(null).errors.join(' ')).toContain('must contain a JSON object')
    expect(parseWorkspaceSettings([]).errors.join(' ')).toContain('must contain a JSON object')
    expect(parseServersFile('nope', {}).errors.join(' ')).toContain('must contain a JSON object')
  })
})

describe('stamping', () => {
  it('records what wrote the file', () => {
    const stamped = stampConfig({ control: { port: 4123 }, servers: [] } as { $schema?: string, meta?: unknown, control: unknown, servers: unknown[] })

    expect(stamped.meta).toEqual({ writtenBy: appVersion(), schema: CONFIG_SCHEMA })
    expect(Object.keys(stamped)).toEqual(['meta', 'control', 'servers'])
  })

  it('replaces a stale stamp instead of keeping it', () => {
    const stamped = stampConfig({ $schema: './x.json', meta: { writtenBy: '0.1.0', schema: 0 }, servers: [] })

    expect(stamped.$schema).toBe('./x.json')
    expect(stamped.meta?.writtenBy).toBe(appVersion())
    expect(Object.keys(stamped).indexOf('$schema')).toBeLessThan(Object.keys(stamped).indexOf('meta'))
  })
})

describe('migration runner', () => {
  const migrations: ConfigMigration[] = [
    { to: 3, describe: 'third', apply: config => ({ ...config, control: { ...(config.control as Record<string, unknown>), port: 4321 } }) },
    { to: 2, describe: 'second', apply: config => ({ ...config, control: { ...(config.control as Record<string, unknown>), label: 'migrated' } }) },
  ]

  it('plans only the steps that are still pending, in ascending order', () => {
    expect(planConfigMigrations(1, { migrations, to: 3 }).steps.map(step => step.to)).toEqual([2, 3])
    expect(planConfigMigrations(2, { migrations, to: 3 }).steps.map(step => step.to)).toEqual([3])
    expect(planConfigMigrations(3, { migrations, to: 3 }).steps).toEqual([])
    // With this release's own target, nothing is pending.
    expect(planConfigMigrations(CONFIG_SCHEMA).steps).toEqual([])
  })

  it('flags a file from the future instead of planning anything', () => {
    const plan = planConfigMigrations(99, { migrations, to: 3 })
    expect(plan.tooNew).toBe(true)
    expect(plan.steps).toEqual([])
  })

  it('applies every step in order, leaving later steps to see earlier ones', () => {
    // Each step proves it ran after the previous one: step 3 reads step 2's value.
    const ordered: ConfigMigration[] = [
      { to: 2, describe: 'two', apply: config => ({ ...config, control: { ...(config.control as Record<string, unknown>), label: 'two' } }) },
      { to: 3, describe: 'three', apply: config => ({ ...config, control: { ...(config.control as Record<string, unknown>), port: (config.control as Record<string, unknown> | undefined)?.label === 'two' ? 4333 : 0 } }) },
    ]

    const { config, applied } = applyConfigMigrations({ servers: [] }, 1, { migrations: ordered, to: 3 })

    expect(applied.map(step => step.to)).toEqual([2, 3])
    expect(config.control).toMatchObject({ label: 'two', port: 4333 })
  })

  it('is a no-op once the file is current', () => {
    const { config, applied } = applyConfigMigrations({ servers: [] }, CONFIG_SCHEMA)
    expect(applied).toEqual([])
    expect(config).toEqual({ servers: [] })
  })
})
