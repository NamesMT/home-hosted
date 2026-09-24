import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { configSchema } from '#src/config/schema'
import { SEED_CONFIG } from '#src/config/seed'
import { ConfigError, ConfigStore } from '#src/config/store'

const dirs: string[] = []

async function writeConfig(content: unknown): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-config-'))
  dirs.push(dir)
  const file = path.join(dir, 'servers.config.json')
  await fs.promises.writeFile(file, JSON.stringify(content, null, 2))
  return file
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe('configStore', () => {
  it('seeds a default file when the config is missing', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-seed-'))
    dirs.push(dir)
    const file = path.join(dir, 'servers.config.json')

    const store = new ConfigStore(file)
    store.load()

    expect(fs.existsSync(file)).toBe(true)
    expect(store.configError).toBeNull()
    // A fresh install ships nothing to supervise.
    expect(store.servers).toEqual([])
    expect(store.config.control.port).toBe(3999)
  })

  it('applies per-entry and global defaults', async () => {
    const file = await writeConfig({
      defaults: { autostart: true, bind: 'lan' },
      servers: [{ id: 'a', command: 'node' }],
    })
    const store = new ConfigStore(file)
    store.load()

    const server = store.getServer('a')
    expect(server).toBeDefined()
    expect(server?.autostart).toBe(true)
    expect(server?.bind).toBe('lan')
    expect(server?.enabled).toBe(true)
    expect(server?.port).toBeNull()
    expect(server?.restart.maxRetries).toBe(3)
    expect(server?.health.forceRestartAfterMs).toBe(0)
    expect(server?.stop.killGroup).toBe(true)
  })

  it('lets an entry override a global default', async () => {
    const file = await writeConfig({
      defaults: { autostart: true },
      servers: [{ id: 'a', command: 'node', autostart: false }],
    })
    const store = new ConfigStore(file)
    store.load()
    expect(store.getServer('a')?.autostart).toBe(false)
  })

  it('refuses a file with an invalid entry, naming every one of them', async () => {
    // Refusing beats serving a half-read config: a dropped entry looks like a removed
    // server, which is a worse failure than a panel that says what is wrong.
    const file = await writeConfig({
      servers: [
        { id: 'good', command: 'node' },
        { id: 'bad id', command: 'node' },
        { id: 'missing-command' },
      ],
    })
    const store = new ConfigStore(file)
    store.load()

    expect(store.configError).toContain('servers[1]')
    expect(store.configError).toContain('servers[2]')
    expect(store.servers).toEqual([])
  })

  it('keeps the config it is already running when the file on disk goes bad', async () => {
    const file = await writeConfig({ servers: [{ id: 'keep', command: 'node' }] })
    const store = new ConfigStore(file)
    store.load()
    expect(store.getServer('keep')).toBeDefined()

    // Someone edits the file into an invalid state while the panel is up: the error
    // is reported, but the running supervision is left alone.
    await fs.promises.writeFile(file, JSON.stringify({ servers: [{ id: 'keep', command: 'node', port: 'nope' }] }, null, 2))
    store.load()

    expect(store.configError).toContain('servers[0]')
    expect(store.getServer('keep')).toBeDefined()
  })

  it('reports duplicate ids', async () => {
    const file = await writeConfig({
      servers: [{ id: 'dup', command: 'node' }, { id: 'dup', command: 'node' }],
    })
    const store = new ConfigStore(file)
    store.load()
    expect(store.servers).toEqual([])
    expect(store.configError).toContain('duplicate id')
  })

  it('survives unparseable json with an error instead of throwing', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-bad-'))
    dirs.push(dir)
    const file = path.join(dir, 'servers.config.json')
    await fs.promises.writeFile(file, '{ nope')
    const store = new ConfigStore(file)
    store.load()
    expect(store.servers).toEqual([])
    expect(store.configError).toContain('cannot parse')
  })

  it('persists patches, keeps the file pretty-printed, and notifies listeners', async () => {
    const file = await writeConfig({ servers: [{ id: 'a', command: 'node', autostart: false }] })
    const store = new ConfigStore(file)
    store.load()

    let notified = 0
    store.onChange(() => notified++)

    store.updateServer('a', { autostart: true, bind: 'lan' })

    expect(notified).toBe(1)
    expect(store.getServer('a')?.autostart).toBe(true)
    const written = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    expect(written.servers[0].bind).toBe('lan')
    expect(await fs.promises.readFile(file, 'utf8')).toMatch(/\n$/)
  })

  it('re-reads the file on load, and tells the listeners', async () => {
    const file = await writeConfig({ servers: [{ id: 'a', command: 'node' }] })
    const store = new ConfigStore(file)
    store.load()

    let notified = 0
    store.onChange(() => notified++)

    // Something else replaced the file, e.g. a restored backup.
    await fs.promises.writeFile(file, JSON.stringify({ servers: [{ id: 'b', command: 'node' }] }))
    store.load()

    expect(notified).toBe(1)
    expect(store.servers.map(server => server.id)).toEqual(['b'])
  })

  it('refuses a patch that would produce an invalid entry and leaves the file untouched', async () => {
    const file = await writeConfig({ servers: [{ id: 'a', command: 'node' }] })
    const before = await fs.promises.readFile(file, 'utf8')
    const store = new ConfigStore(file)
    store.load()

    expect(() => store.updateServer('a', { command: '' })).toThrow(ConfigError)
    expect(await fs.promises.readFile(file, 'utf8')).toBe(before)
  })

  it('adds and removes servers', async () => {
    const file = await writeConfig({ servers: [{ id: 'a', command: 'node' }] })
    const store = new ConfigStore(file)
    store.load()

    store.addServer({ id: 'b', command: 'serve', port: 4010 })
    expect(store.servers.map(server => server.id)).toEqual(['a', 'b'])
    expect(store.getServer('b')?.port).toBe(4010)

    expect(() => store.addServer({ id: 'b', command: 'serve' })).toThrow(ConfigError)

    store.removeServer('a')
    expect(store.servers.map(server => server.id)).toEqual(['b'])
    expect(() => store.removeServer('a')).toThrow(ConfigError)
  })

  it('validates the bind field against local/lan/ipv4', async () => {
    const file = await writeConfig({ servers: [{ id: 'a', command: 'node', bind: '192.168.1.10' }] })
    const store = new ConfigStore(file)
    store.load()
    expect(store.configError).toBeNull()
    expect(store.getServer('a')?.bind).toBe('192.168.1.10')

    const bad = await writeConfig({ servers: [{ id: 'a', command: 'node', bind: 'not-a-host!' }] })
    const badStore = new ConfigStore(bad)
    badStore.load()
    expect(badStore.servers).toEqual([])
    expect(badStore.configError).toContain('bind')
  })
})

describe('shipped config', () => {
  it('ships no servers, and a seed that itself validates', () => {
    expect(SEED_CONFIG.servers).toEqual([])
    const parsed = configSchema(SEED_CONFIG)
    expect(parsed instanceof type.errors).toBe(false)
  })
})

describe('server patching', () => {
  async function storeWith(server: Record<string, unknown>): Promise<{ store: ConfigStore, file: string }> {
    const file = await writeConfig({ servers: [server] })
    const store = new ConfigStore(file)
    store.load()
    return { store, file }
  }

  it('can clear an optional nested field again', async () => {
    const { store } = await storeWith({
      id: 'a',
      command: 'node',
      health: { mode: 'http', http: { path: '/healthz', expectStatus: 204 } },
    })
    expect(store.getServer('a')?.health.http.expectStatus).toBe(204)

    // A partial patch must NOT reset the siblings it did not mention.
    store.updateServer('a', { health: { http: { expectStatus: 200 } } })
    expect(store.getServer('a')?.health.http).toMatchObject({ path: '/healthz', expectStatus: 200 })

    // An explicit null is how a UI says "no exact status any more".
    store.updateServer('a', { health: { http: { expectStatus: null } } })
    expect(store.getServer('a')?.health.http.expectStatus).toBeUndefined()
    expect(store.getServer('a')?.health.http.path).toBe('/healthz')
  })

  it('merges nested groups instead of dropping untouched fields', async () => {
    const { store, file } = await storeWith({
      id: 'a',
      command: 'node',
      restart: { maxRetries: 7, baseDelayMs: 250 },
    })

    store.updateServer('a', { restart: { maxRetries: 1 } })

    expect(store.getServer('a')?.restart.maxRetries).toBe(1)
    expect(store.getServer('a')?.restart.baseDelayMs).toBe(250)

    const written = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    expect(written.servers[0].restart).toEqual({ maxRetries: 1, baseDelayMs: 250 })
  })

  it('does not pull code defaults into a partial nested patch on disk', async () => {
    const { store, file } = await storeWith({ id: 'a', command: 'node' })
    store.updateServer('a', { health: { intervalMs: 9000 } })

    const written = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    expect(written.servers[0].health).toEqual({ intervalMs: 9000 })
    expect(store.getServer('a')?.health.unhealthyThreshold).toBe(3)
  })

  it('replaces args and env wholesale so entries can be removed', async () => {
    const { store } = await storeWith({
      id: 'a',
      command: 'node',
      args: ['--one', '--two'],
      env: { KEEP: '1', DROP: '2' },
    })

    store.updateServer('a', { args: ['--three'], env: { KEEP: '9' } })

    expect(store.getServer('a')?.args).toEqual(['--three'])
    expect(store.getServer('a')?.env).toEqual({ KEEP: '9' })
  })

  it('clears the port with null and keeps it cleared after a reload', async () => {
    const { store, file } = await storeWith({ id: 'a', command: 'node', port: 4123 })
    store.updateServer('a', { port: null })
    expect(store.getServer('a')?.port).toBeNull()

    const reloaded = new ConfigStore(file)
    reloaded.load()
    expect(reloaded.getServer('a')?.port).toBeNull()
    expect(reloaded.getServer('a')?.health.enabled).toBe(true)
  })

  it('clears bootstrap with null', async () => {
    const { store } = await storeWith({
      id: 'a',
      command: 'node',
      bootstrap: { command: 'node', args: ['-e', 'noop'] },
    })
    expect(store.getServer('a')?.bootstrap?.command).toBe('node')

    store.updateServer('a', { bootstrap: null })
    expect(store.getServer('a')?.bootstrap ?? null).toBeNull()
  })

  it('tolerates keys a newer release wrote, and says which ones it ignored', async () => {
    // The compatibility rule: an unrecognized key is the normal way a newer config
    // looks to an older panel, so it is kept on disk, reported, and ignored here —
    // never allowed to fail the group it sits in.
    const file = await writeConfig({
      control: { port: 4123, host: 'local', futurePanelFlag: true },
      servers: [{ id: 'a', command: 'node', autostartt: true }],
      futureTopLevelBlock: { anything: true },
    })
    const store = new ConfigStore(file)
    store.load()

    expect(store.configError).toBeNull()
    // The group kept its real values instead of falling back to schema defaults.
    expect(store.config.control.port).toBe(4123)
    expect(store.getServer('a')).toBeDefined()

    const warnings = store.configWarnings.join('\n')
    expect(warnings).toContain('control.futurePanelFlag')
    expect(warnings).toContain('servers[0].autostartt')
    expect(warnings).toContain('futureTopLevelBlock')

    // Left on disk for the release that understands them.
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>
    expect(raw.futureTopLevelBlock).toBeDefined()
  })

  it('still refuses a value that is simply wrong', async () => {
    const file = await writeConfig({ servers: [{ id: 'a', command: 'node', port: 'nope' }] })
    const store = new ConfigStore(file)
    store.load()
    expect(store.configError).toContain('servers[0]')
  })

  it('never persists an unknown patch key', async () => {
    const { store, file } = await storeWith({ id: 'a', command: 'node' })
    const before = await fs.promises.readFile(file, 'utf8')

    expect(() => store.updateServer('a', { dataDir: '/tmp/x' } as never)).toThrow(ConfigError)
    expect(await fs.promises.readFile(file, 'utf8')).toBe(before)
  })

  it('rejects an out-of-range nested value and leaves the file alone', async () => {
    const { store, file } = await storeWith({ id: 'a', command: 'node' })
    const before = await fs.promises.readFile(file, 'utf8')

    expect(() => store.updateServer('a', { restart: { factor: 0.5 } })).toThrow(ConfigError)
    expect(await fs.promises.readFile(file, 'utf8')).toBe(before)
  })
})

describe('settings updates', () => {
  it('merges an auth patch without dropping the other control fields', async () => {
    const file = await writeConfig({ control: { port: 3999, host: 'local', openBrowser: true, auth: { enabled: false, maxLoginAttempts: 9 } }, servers: [] })
    const store = new ConfigStore(file)
    store.load()

    store.updateControl({ auth: { enabled: true } })

    expect(store.config.control.auth.enabled).toBe(true)
    expect(store.config.control.auth.maxLoginAttempts).toBe(9)
    expect(store.config.control.openBrowser).toBe(true)
    expect(store.config.control.port).toBe(3999)

    const written = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    expect(written.control.auth).toEqual({ enabled: true, maxLoginAttempts: 9 })
  })

  it('merges nested default groups', async () => {
    const file = await writeConfig({ defaults: { autostart: true, restart: { maxRetries: 7, baseDelayMs: 250 } }, servers: [] })
    const store = new ConfigStore(file)
    store.load()

    store.updateDefaults({ restart: { maxRetries: 2 } })

    expect(store.defaults.autostart).toBe(true)
    expect(store.defaults.restart.maxRetries).toBe(2)
    expect(store.defaults.restart.baseDelayMs).toBe(250)
  })

  it('applies edited defaults to the servers that inherit them', async () => {
    const file = await writeConfig({ defaults: { autostart: false }, servers: [{ id: 'a', command: 'node' }, { id: 'b', command: 'node', autostart: false }] })
    const store = new ConfigStore(file)
    store.load()

    store.updateDefaults({ autostart: true })

    expect(store.getServer('a')?.autostart).toBe(true)
    expect(store.getServer('b')?.autostart).toBe(false)
  })

  it('rejects an invalid control patch and leaves the file alone', async () => {
    const file = await writeConfig({ control: { port: 3999 }, servers: [] })
    const before = await fs.promises.readFile(file, 'utf8')
    const store = new ConfigStore(file)
    store.load()

    expect(() => store.updateControl({ host: 'not a host' as never })).toThrow(ConfigError)
    expect(() => store.updateControl({ auth: { maxLoginAttempts: 0 } as never })).toThrow(ConfigError)
    expect(await fs.promises.readFile(file, 'utf8')).toBe(before)
  })
})

describe('logs, notifications and dependencies', () => {
  it('updates log retention and notification policy', async () => {
    const file = await writeConfig({ servers: [] })
    const store = new ConfigStore(file)
    store.load()

    store.updateLogs({ persist: false, keep: 5 })
    store.updateNotifications({ telegram: { enabled: true, chatId: '42' } })

    expect(store.config.logs.persist).toBe(false)
    expect(store.config.logs.keep).toBe(5)
    expect(store.config.logs.maxBytes).toBe(2000000)
    expect(store.config.notifications.telegram.chatId).toBe('42')
    expect(store.config.notifications.telegram.onCrash).toBe(true)
  })

  it('rejects an out-of-range retention value', async () => {
    const file = await writeConfig({ servers: [] })
    const store = new ConfigStore(file)
    expect(() => store.updateLogs({ keep: 99 as never })).toThrow(ConfigError)
  })

  it('carries dependsOn through to the resolved server', async () => {
    const file = await writeConfig({ servers: [{ id: 'app', command: 'node', dependsOn: ['db'] }, { id: 'db', command: 'node' }] })
    const store = new ConfigStore(file)
    store.load()

    expect(store.getServer('app')?.dependsOn).toEqual(['db'])
    expect(store.configError).toBeNull()
  })

  it('reports a dangling dependency without dropping the server', async () => {
    const file = await writeConfig({ servers: [{ id: 'app', command: 'node', dependsOn: ['ghost'] }] })
    const store = new ConfigStore(file)
    store.load()

    expect(store.getServer('app')).toBeDefined()
    expect(store.configError).toBeNull()
    expect(store.configWarnings.join('\n')).toContain('unknown server "ghost"')
  })

  it('reports a dependency cycle and self references', async () => {
    const cyclic = await writeConfig({ servers: [{ id: 'a', command: 'node', dependsOn: ['b'] }, { id: 'b', command: 'node', dependsOn: ['a'] }] })
    const store = new ConfigStore(cyclic)
    store.load()
    expect(store.configWarnings.join('\n')).toContain('dependency cycle')

    const self = await writeConfig({ servers: [{ id: 'a', command: 'node', dependsOn: ['a'] }] })
    const selfStore = new ConfigStore(self)
    selfStore.load()
    expect(selfStore.configWarnings.join('\n')).toContain('depends on itself')
  })
})
