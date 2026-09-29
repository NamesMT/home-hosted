import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { globalSettingsSchema } from '#src/config/schema'
import { SEED_GLOBAL_SETTINGS } from '#src/config/seed'
import { ConfigError, GlobalSettingsStore } from '#src/config/settings'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
}

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-global-'))
  dirs.push(dir)
  return dir
}

/** The global settings file, plus a workspace's two files to prove they stay apart. */
async function makeStore(settings: Record<string, unknown> | null = {}) {
  const dir = await tempDir()
  const file = path.join(dir, 'settings.json')
  if (settings !== null)
    await fs.promises.writeFile(file, JSON.stringify(settings, null, 2))
  const workspaceSettings = path.join(dir, 'default', 'settings.json')
  const workspaceServers = path.join(dir, 'default', 'servers.config.json')
  fs.mkdirSync(path.dirname(workspaceSettings), { recursive: true })
  fs.writeFileSync(workspaceSettings, '{"defaults":{}}\n')
  fs.writeFileSync(workspaceServers, '{"servers":[]}\n')
  const store = new GlobalSettingsStore(file)
  store.load()
  return { store, file, dir, workspaceSettings, workspaceServers }
}

describe('globalSettingsStore', () => {
  it('seeds the file when the panel has no settings yet', async () => {
    const { store, file } = await makeStore(null)

    expect(fs.existsSync(file)).toBe(true)
    expect(store.configError).toBeNull()
    expect(store.control.port).toBe(3999)
    expect(store.control.host).toBe('local')
    expect(store.host.intervalMs).toBe(15000)
    expect(store.backups.keep).toBe(5)
    // The writable shape still validates, and carries its stamp.
    expect(globalSettingsSchema(read(file)) instanceof Error).toBe(false)
    expect(read(file).meta.schema).toBe(CONFIG_SCHEMA)
  })

  it('merges an auth patch without dropping the other control fields', async () => {
    const { store } = await makeStore({
      control: { port: 3999, host: 'local', openBrowser: true, auth: { enabled: false, maxLoginAttempts: 9 } },
    })

    store.updateControl({ auth: { enabled: true } })

    expect(store.control.auth.enabled).toBe(true)
    expect(store.control.auth.maxLoginAttempts).toBe(9)
    expect(store.control.openBrowser).toBe(true)
    expect(store.control.port).toBe(3999)
  })

  it('updates the host and backups blocks', async () => {
    const { store, file } = await makeStore({})

    store.updateHost({ intervalMs: 6000, diskUsedPercent: 80 })
    store.updateBackups({ keep: 9, includePaths: ['/srv/data'] })

    expect(store.host.intervalMs).toBe(6000)
    expect(store.host.enabled).toBe(true)
    expect(store.backups.keep).toBe(9)
    expect(store.backups.includePaths).toEqual(['/srv/data'])
    const written = read(file)
    expect(written.host.intervalMs).toBe(6000)
    expect(written.backups.keep).toBe(9)
  })

  it('tolerates a key a newer release wrote instead of resetting the group', async () => {
    const { store, file } = await makeStore({
      control: { port: 4123, host: 'local', futurePanelFlag: true },
      futureTopLevelBlock: { anything: true },
    })

    expect(store.configError).toBeNull()
    // The group kept its real values instead of falling back to schema defaults.
    expect(store.control.port).toBe(4123)
    const warnings = store.configWarnings.join('\n')
    expect(warnings).toContain('futurePanelFlag')
    expect(warnings).toContain('futureTopLevelBlock')

    // Left on disk for the release that understands them.
    expect(read(file).futureTopLevelBlock).toBeDefined()
    expect(read(file).control.futurePanelFlag).toBe(true)
  })

  it('refuses a control patch that is simply wrong and leaves the file alone', async () => {
    const { store, file } = await makeStore({ control: { port: 3999 } })
    const before = await fs.promises.readFile(file, 'utf8')

    expect(() => store.updateControl({ host: 'not a host' as never })).toThrow(ConfigError)
    expect(() => store.updateControl({ auth: { maxLoginAttempts: 0 } as never })).toThrow(ConfigError)
    expect(await fs.promises.readFile(file, 'utf8')).toBe(before)
  })

  it('never lets a settings write touch a workspace file', async () => {
    const { store, workspaceSettings, workspaceServers } = await makeStore({})
    const settingsBefore = await fs.promises.readFile(workspaceSettings, 'utf8')
    const serversBefore = await fs.promises.readFile(workspaceServers, 'utf8')

    store.updateControl({ label: 'Global only' })
    store.updateHost({ intervalMs: 7000 })
    store.updateBackups({ keep: 2 })

    expect(await fs.promises.readFile(workspaceSettings, 'utf8')).toBe(settingsBefore)
    expect(await fs.promises.readFile(workspaceServers, 'utf8')).toBe(serversBefore)
  })

  it('is quiet about its own write, and picks up somebody else’s', async () => {
    const { store, file } = await makeStore({})

    store.updateControl({ label: 'via the panel' })
    expect(store.reloadFromDisk()).toEqual({ changed: false, applied: false, error: null })

    await fs.promises.writeFile(file, JSON.stringify({ control: { port: 4111 } }, null, 2))
    const reloaded = store.reloadFromDisk()
    expect(reloaded.changed).toBe(true)
    expect(reloaded.applied).toBe(true)
    expect(store.control.port).toBe(4111)
    expect(store.reloadFromDisk()).toEqual({ changed: false, applied: false, error: null })
  })

  it('reports a settings file that went away instead of re-seeding it', async () => {
    const { store, file } = await makeStore({})

    await fs.promises.rm(file)
    const result = store.reloadFromDisk()

    expect(result.changed).toBe(false)
    expect(result.error).toContain('is gone')
    expect(fs.existsSync(file)).toBe(false)
    // The running settings are kept.
    expect(store.control.port).toBe(3999)
  })

  it('tells its listeners when the file changes', async () => {
    const { store, file } = await makeStore({})
    let notified = 0
    store.onChange(() => notified++)

    store.updateControl({ label: 'x' })
    expect(notified).toBe(1)

    await fs.promises.writeFile(file, JSON.stringify({ control: { label: 'y' } }, null, 2))
    store.load()
    expect(notified).toBe(2)
  })

  it('reports the schema it read and any pending migration', async () => {
    const { store } = await makeStore({})
    expect(store.configSchemaVersion).toBe(CONFIG_SCHEMA)
    expect(store.pendingMigrations).toEqual([])
  })
})

describe('shipped global seed', () => {
  it('validates and declares no workspace-scoped block', () => {
    const parsed = globalSettingsSchema(SEED_GLOBAL_SETTINGS)
    expect(parsed instanceof Error).toBe(false)
    for (const key of ['defaults', 'logs', 'notifications', 'ddns'])
      expect(SEED_GLOBAL_SETTINGS).not.toHaveProperty(key)
  })
})
