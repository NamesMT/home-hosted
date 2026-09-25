import type { ConfigMigration } from '#src/config/migrations'
import type { RawConfig } from '#src/config/schema'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { applyConfigMigrations, CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import { parseConfig, stampConfig } from '#src/config/parse'
import { ConfigStore } from '#src/config/store'
import { appVersion } from '#src/helpers/version'

const fixtures = fileURLToPath(new URL('../fixtures/config/', import.meta.url))
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

/** A released config must keep loading, forever: this is the guard, not a hope. */
function fixture(name: string): RawConfig {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8')) as RawConfig
}

async function tempStore(contents: RawConfig): Promise<{ store: ConfigStore, file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-compat-'))
  dirs.push(dir)
  const file = path.join(dir, 'servers.config.json')
  await fs.promises.writeFile(file, `${JSON.stringify(contents, null, 2)}\n`)
  const store = new ConfigStore(file)
  store.load()
  return { store, file }
}

describe('reading configs from other releases', () => {
  it('loads a config written by the last release, unchanged', () => {
    // Fixtures for each released shape live in test/fixtures/config/: a shape that
    // stops loading here is a breaking change, and this is where that shows up.
    const parsed = parseConfig(fixture('v0.3.0.json'))

    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([])
    expect(parsed.unknownKeys).toEqual([])
    expect(parsed.schemaVersion).toBe(CONFIG_SCHEMA)
    expect(parsed.config?.control.port).toBe(3999)
    expect(parsed.config?.servers.map(server => server.id)).toEqual(['9router', 'static'])
    expect(parsed.config?.servers[1]?.port).toBe(4010)
  })

  it('treats an unstamped file as the current schema', async () => {
    const parsed = parseConfig(fixture('v0.3.0.json'))
    expect(parsed.writtenBy).toBeNull()
    expect(parsed.schemaVersion).toBe(CONFIG_SCHEMA)
    expect(parsed.config?.meta).toEqual({ writtenBy: '', schema: CONFIG_SCHEMA })
  })

  it('keeps what it knows of a config from a newer release, and lists the rest', () => {
    const parsed = parseConfig(fixture('newer-release.json'))

    expect(parsed.errors).toEqual([])
    expect(parsed.writtenBy).toBe('0.4.0')
    // The values around the unknown keys survived, including nested groups.
    expect(parsed.config?.control.port).toBe(4123)
    expect(parsed.config?.control.auth.enabled).toBe(true)
    expect(parsed.config?.servers[0]?.port).toBe(4200)
    expect(parsed.config?.servers[0]?.health.enabled).toBe(true)

    expect(parsed.unknownKeys).toEqual(expect.arrayContaining([
      'control.futurePanelFlag',
      'control.auth.futureAuthField',
      'servers[0].futureEntryField',
      'servers[0].health.futureHealthField',
      'futureTopLevelBlock',
    ]))
  })

  it('refuses a config from a release it cannot understand', () => {
    const parsed = parseConfig(fixture('from-the-future.json'))

    expect(parsed.config).toBeNull()
    expect(parsed.schemaVersion).toBe(99)
    expect(parsed.errors.join(' ')).toContain('9.9.9')
    expect(parsed.errors.join(' ')).toContain('schema 99')
  })

  it('refuses a config that needs a migration, before running one', () => {
    // A synthetic step stands in for the first real migration this project ships.
    const parsed = parseConfig({ meta: { schema: 1 }, servers: [] }, {
      to: 2,
      migrations: [{ to: 2, describe: 'add the thing', apply: config => config }],
    })

    expect(parsed.config).toBeNull()
    expect(parsed.errors.join(' ')).toContain('needs 1 migration')
  })
})

describe('stamping', () => {
  it('records what wrote the file', () => {
    const stamped = stampConfig({ control: { port: 4123 }, servers: [] })

    expect(stamped.meta).toEqual({ writtenBy: appVersion(), schema: CONFIG_SCHEMA })
    expect(Object.keys(stamped)).toEqual(['meta', 'control', 'servers'])
  })

  it('replaces a stale stamp instead of keeping it', () => {
    const stamped = stampConfig({ $schema: './x.json', meta: { writtenBy: '0.1.0', schema: 0 }, servers: [] })

    expect(stamped.$schema).toBe('./x.json')
    expect(stamped.meta?.writtenBy).toBe(appVersion())
    expect(Object.keys(stamped).indexOf('$schema')).toBeLessThan(Object.keys(stamped).indexOf('meta'))
  })

  it('writes the stamp on every store write, so the next release can tell', async () => {
    const { store, file } = await tempStore({ control: { port: 3999 }, servers: [] })
    expect(store.configSchemaVersion).toBe(CONFIG_SCHEMA)
    expect(store.pendingMigrations).toEqual([])

    store.updateControl({ label: 'Stamped' })

    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as RawConfig
    expect(raw.meta).toEqual({ writtenBy: appVersion(), schema: CONFIG_SCHEMA })
    expect(raw.control).toMatchObject({ label: 'Stamped' })
  })
})

describe('migration runner', () => {
  const migrations: ConfigMigration[] = [
    { to: 3, describe: 'third', apply: config => ({ ...config, control: { ...config.control, port: 4321 } }) },
    { to: 2, describe: 'second', apply: config => ({ ...config, control: { ...config.control, label: 'migrated' } }) },
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
      { to: 2, describe: 'two', apply: config => ({ ...config, control: { ...config.control, label: 'two' } }) },
      { to: 3, describe: 'three', apply: config => ({ ...config, control: { ...config.control, port: config.control?.label === 'two' ? 4333 : 0 } }) },
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
