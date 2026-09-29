import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serversFileSchema, workspaceSettingsSchema } from '#src/config/schema'
import { SEED_SERVERS_FILE, SEED_WORKSPACE_SETTINGS } from '#src/config/seed'
import { ConfigError, WorkspaceStore } from '#src/config/store'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

interface TempStore {
  store: WorkspaceStore
  dir: string
  settingsFile: string
  serversFile: string
}

/** Writes the two files a workspace owns, then loads them through the store. */
async function tempStore(
  settings: Record<string, unknown> | null,
  servers: Record<string, unknown> | null = { servers: [] },
): Promise<TempStore> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-workspace-'))
  dirs.push(dir)
  const settingsFile = path.join(dir, 'settings.json')
  const serversFile = path.join(dir, 'servers.config.json')
  if (settings !== null)
    await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, 2))
  if (servers !== null)
    await fs.promises.writeFile(serversFile, JSON.stringify(servers, null, 2))
  return { store: new WorkspaceStore('default', settingsFile, serversFile), dir, settingsFile, serversFile }
}

async function storeWith(server: Record<string, unknown>, settings: Record<string, unknown> = {}): Promise<TempStore> {
  const created = await tempStore(settings, { servers: [server] })
  created.store.load()
  return created
}

function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
}

describe('workspaceStore', () => {
  it('seeds both files when the workspace has none yet', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-seed-'))
    dirs.push(dir)
    const settingsFile = path.join(dir, 'settings.json')
    const serversFile = path.join(dir, 'servers.config.json')

    const store = new WorkspaceStore('default', settingsFile, serversFile)
    store.load()

    expect(fs.existsSync(settingsFile)).toBe(true)
    expect(fs.existsSync(serversFile)).toBe(true)
    expect(store.configError).toBeNull()
    // A fresh workspace ships nothing to supervise.
    expect(store.servers).toEqual([])
    expect(store.defaults.bind).toBe('local')
    expect(store.defaults.onPortConflict).toBe('block')
  })

  it('applies per-entry and workspace defaults', async () => {
    const { store } = await storeWith(
      { id: 'a', command: 'node' },
      { defaults: { autostart: true, bind: 'lan' } },
    )

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

  it('merges a workspace default into a group the entry only partly declares', async () => {
    const { store } = await storeWith(
      { id: 'b', command: 'node', restart: { maxRetries: 2 } },
      { defaults: { restart: { baseDelayMs: 5000, maxRetries: 9 } } },
    )

    // Deciding one member must not drop the workspace's default for the others.
    expect(store.getServer('b')?.restart.maxRetries).toBe(2)
    expect(store.getServer('b')?.restart.baseDelayMs).toBe(5000)
    // …and the schema defaults still fill what neither side decided.
    expect(store.getServer('b')?.restart.factor).toBe(2)

    // Same rule on the write path: a created entry inherits the group defaults.
    const created = store.addServer({ id: 'c', command: 'node', restart: { maxRetries: 1 } })
    expect(created.restart.baseDelayMs).toBe(5000)
    expect(created.restart.maxRetries).toBe(1)
  })

  it('lets an entry override a workspace default', async () => {
    const { store } = await storeWith(
      { id: 'a', command: 'node', autostart: false },
      { defaults: { autostart: true } },
    )
    expect(store.getServer('a')?.autostart).toBe(false)
  })

  it('refuses a servers file with an invalid entry, naming every one of them', async () => {
    const { store } = await storeWith(
      { id: 'good', command: 'node' },
      { defaults: {} },
    )
    // A second bad entry, written directly so both are reported in one read.
    fs.writeFileSync(store.settingsPath, JSON.stringify({ defaults: {} }, null, 2))
    fs.writeFileSync(store.path, JSON.stringify({
      servers: [
        { id: 'good', command: 'node' },
        { id: 'bad id', command: 'node' },
        { id: 'missing-command' },
      ],
    }, null, 2))
    store.load()

    expect(store.configError).toContain('servers[1]')
    expect(store.configError).toContain('servers[2]')
    // Never a half-read list: neither invalid entry is served under its own id.
    expect(store.servers.map(server => server.id)).not.toContain('bad id')
    expect(store.servers.map(server => server.id)).not.toContain('missing-command')
  })

  it('keeps the config it is already running when the servers file goes bad', async () => {
    const { store } = await storeWith({ id: 'keep', command: 'node' })
    expect(store.getServer('keep')).toBeDefined()

    await fs.promises.writeFile(store.path, JSON.stringify({ servers: [{ id: 'keep', command: 'node', port: 'nope' }] }, null, 2))
    store.load()

    expect(store.configError).toContain('servers[0]')
    expect(store.getServer('keep')).toBeDefined()
  })

  /**
   * The reload path a file watcher uses. `lastText` is what makes it quiet: our own
   * writes are remembered, so only somebody else's bytes count as an edit.
   */
  it('reloads a hand edit, and ignores the writes it made itself', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node', autostart: false })

    store.updateServer('a', { label: 'via the panel' })
    expect(store.reloadFromDisk()).toEqual({ changed: false, applied: false, error: null })

    await fs.promises.writeFile(store.path, JSON.stringify({
      servers: [{ id: 'a', command: 'node', label: 'via an editor' }, { id: 'b', command: 'node' }],
    }, null, 2))

    expect(store.reloadFromDisk()).toEqual({ changed: true, applied: true, error: null })
    expect(store.getServer('a')?.label).toBe('via an editor')
    expect(store.getServer('b')).toBeDefined()
    // Read once, reported once.
    expect(store.reloadFromDisk()).toEqual({ changed: false, applied: false, error: null })
  })

  it('reloads a hand edit of the settings file and ignores its own write', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })

    store.updateDefaults({ autostart: true })
    expect(store.reloadFromDisk()).toEqual({ changed: false, applied: false, error: null })

    await fs.promises.writeFile(store.settingsPath, JSON.stringify({ defaults: { bind: 'lan' } }, null, 2))
    expect(store.reloadFromDisk()).toEqual({ changed: true, applied: true, error: null })
    expect(store.getServer('a')?.bind).toBe('lan')
  })

  it('keeps the running config when a file is edited into invalid json, and picks the fix back up', async () => {
    const { store } = await storeWith({ id: 'keep', command: 'node' })

    const good = await fs.promises.readFile(store.path, 'utf8')
    await fs.promises.writeFile(store.path, '{ nope')

    const broken = store.reloadFromDisk()
    expect(broken.changed).toBe(true)
    expect(broken.applied).toBe(false)
    expect(store.configError).not.toBeNull()
    expect(store.getServer('keep')).toBeDefined()

    await fs.promises.writeFile(store.path, good)
    // Restoring the good bytes is an edit like any other; what matters is that the
    // error is cleared and the running config is intact again.
    const recovered = store.reloadFromDisk()
    expect(recovered.error).toBeNull()
    expect(store.configError).toBeNull()
    expect(store.getServer('keep')).toBeDefined()
    // Read once, reported once.
    expect(store.reloadFromDisk()).toEqual({ changed: false, applied: false, error: null })
  })

  it('tells the listeners when a broken file becomes readable again', async () => {
    const { store } = await storeWith({ id: 'keep', command: 'node' })

    const good = await fs.promises.readFile(store.path, 'utf8')
    await fs.promises.writeFile(store.path, '{ nope')
    expect(store.reloadFromDisk().error).not.toBeNull()

    let notified = false
    store.onChange(() => {
      notified = true
    })
    await fs.promises.writeFile(store.path, good)

    const recovered = store.reloadFromDisk()
    expect(recovered.error).toBeNull()
    expect(notified).toBe(true)
    expect(store.getServer('keep')).toBeDefined()
  })

  /**
   * Every write patches `raw`, so a read that could not be trusted must leave it
   * alone: `{}` would turn the next save into a config with no servers.
   */
  it('never lets a broken servers file become the config a write is built from', async () => {
    const { store } = await storeWith({ id: 'keep', command: 'node' })

    await fs.promises.writeFile(store.path, '{ nope')
    store.reloadFromDisk()
    expect(store.getServer('keep')).toBeDefined()

    // A servers write is built from the last trusted read, not from the broken file.
    store.updateServer('keep', { label: 'written while the file was broken' })

    const written = read(store.path)
    expect(written.servers?.map((entry: { id: string }) => entry.id)).toEqual(['keep'])
    expect(store.getServer('keep')?.label).toBe('written while the file was broken')
  })

  it('treats a deleted file as a problem, never as an edit to re-seed', async () => {
    const { store } = await storeWith({ id: 'keep', command: 'node' })

    await fs.promises.rm(store.path)
    const result = store.reloadFromDisk()

    expect(result.changed).toBe(false)
    expect(result.error).toContain('is gone')
    expect(fs.existsSync(store.path)).toBe(false)
    expect(store.getServer('keep')).toBeDefined()
  })

  it('reports duplicate ids', async () => {
    const { store } = await storeWith({ id: 'dup', command: 'node' })
    await fs.promises.writeFile(store.path, JSON.stringify({
      servers: [{ id: 'dup', command: 'node' }, { id: 'dup', command: 'node' }],
    }))
    store.load()
    expect(store.configError).toContain('duplicate id')
    // The duplicate is never served twice.
    const ids = store.servers.map(server => server.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('survives unparseable settings json with an error instead of throwing', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-bad-'))
    dirs.push(dir)
    const settingsFile = path.join(dir, 'settings.json')
    const serversFile = path.join(dir, 'servers.config.json')
    await fs.promises.writeFile(settingsFile, '{ nope')
    await fs.promises.writeFile(serversFile, JSON.stringify({ servers: [] }))
    const store = new WorkspaceStore('default', settingsFile, serversFile)
    store.load()
    expect(store.configError).not.toBeNull()
    // A settings file this release cannot read never replaces the servers string.
    expect(store.servers).toEqual([])
  })

  it('persists patches, keeps the files pretty-printed, and notifies listeners', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node', autostart: false })

    let notified = 0
    store.onChange(() => notified++)

    store.updateServer('a', { autostart: true, bind: 'lan' })

    expect(notified).toBe(1)
    expect(store.getServer('a')?.autostart).toBe(true)
    const written = read(store.path)
    expect(written.servers[0].bind).toBe('lan')
    expect(await fs.promises.readFile(store.path, 'utf8')).toMatch(/\n$/)
  })

  it('re-reads the servers file on load, and tells the listeners', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })

    let notified = 0
    store.onChange(() => notified++)

    // Something else replaced the file, e.g. a restored backup.
    await fs.promises.writeFile(store.path, JSON.stringify({ servers: [{ id: 'b', command: 'node' }] }))
    store.load()

    expect(notified).toBe(1)
    expect(store.servers.map(server => server.id)).toEqual(['b'])
  })

  it('refuses a patch that would produce an invalid entry and leaves the file untouched', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })
    const before = await fs.promises.readFile(store.path, 'utf8')

    expect(() => store.updateServer('a', { command: '' })).toThrow(ConfigError)
    expect(await fs.promises.readFile(store.path, 'utf8')).toBe(before)
  })

  it('adds and removes servers', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })

    store.addServer({ id: 'b', command: 'serve', port: 4010 })
    expect(store.servers.map(server => server.id)).toEqual(['a', 'b'])
    expect(store.getServer('b')?.port).toBe(4010)

    expect(() => store.addServer({ id: 'b', command: 'serve' })).toThrow(ConfigError)

    store.removeServer('a')
    expect(store.servers.map(server => server.id)).toEqual(['b'])
    expect(() => store.removeServer('a')).toThrow(ConfigError)
  })

  it('validates the bind field against local/lan/ipv4', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node', bind: '192.168.1.10' })
    expect(store.configError).toBeNull()
    expect(store.getServer('a')?.bind).toBe('192.168.1.10')

    const bad = await storeWith({ id: 'a', command: 'node', bind: 'not-a-host!' })
    expect(bad.store.servers).toEqual([])
    expect(bad.store.configError).toContain('bind')
  })
})

describe('shipped seeds', () => {
  it('ship no servers, and seeds that themselves validate', () => {
    expect(SEED_SERVERS_FILE.servers).toEqual([])
    expect(workspaceSettingsSchema(SEED_WORKSPACE_SETTINGS) instanceof Error).toBe(false)
    expect(serversFileSchema(SEED_SERVERS_FILE) instanceof Error).toBe(false)
  })
})

describe('server patching', () => {
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
    const { store } = await storeWith({ id: 'a', command: 'node', restart: { maxRetries: 7, baseDelayMs: 250 } })

    store.updateServer('a', { restart: { maxRetries: 1 } })

    expect(store.getServer('a')?.restart.maxRetries).toBe(1)
    expect(store.getServer('a')?.restart.baseDelayMs).toBe(250)

    const written = read(store.path)
    expect(written.servers[0].restart).toEqual({ maxRetries: 1, baseDelayMs: 250 })
  })

  it('does not pull code defaults into a partial nested patch on disk', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })
    store.updateServer('a', { health: { intervalMs: 9000 } })

    const written = read(store.path)
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
    const { store, settingsFile, serversFile } = await storeWith({ id: 'a', command: 'node', port: 4123 })
    store.updateServer('a', { port: null })
    expect(store.getServer('a')?.port).toBeNull()

    const reloaded = new WorkspaceStore('default', settingsFile, serversFile)
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
    // The compatibility rule: an unrecognized key is the normal way a newer file
    // looks to an older panel, so it is kept on disk, reported, and ignored here —
    // never allowed to fail the group it sits in.
    const { store, settingsFile, serversFile } = await tempStore(
      { defaults: { autostart: true }, futureSettingsBlock: { anything: true } },
      { servers: [{ id: 'a', command: 'node', autostartt: true }], futureServersBlock: { anything: true } },
    )
    store.load()

    expect(store.configError).toBeNull()
    expect(store.defaults.autostart).toBe(true)
    expect(store.getServer('a')).toBeDefined()

    const warnings = store.configWarnings.join('\n')
    expect(warnings).toContain('autostartt')
    expect(warnings).toContain('futureSettingsBlock')
    expect(warnings).toContain('futureServersBlock')

    // Left on disk for the release that understands them.
    expect(read(settingsFile).futureSettingsBlock).toBeDefined()
    expect(read(serversFile).futureServersBlock).toBeDefined()
  })

  it('still refuses a value that is simply wrong', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node', port: 'nope' })
    expect(store.configError).toContain('servers[0]')
  })

  it('never persists an unknown patch key', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })
    const before = await fs.promises.readFile(store.path, 'utf8')

    expect(() => store.updateServer('a', { dataDir: '/tmp/x' } as never)).toThrow(ConfigError)
    expect(await fs.promises.readFile(store.path, 'utf8')).toBe(before)
  })

  it('rejects an out-of-range nested value and leaves the file alone', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })
    const before = await fs.promises.readFile(store.path, 'utf8')

    expect(() => store.updateServer('a', { restart: { factor: 0.5 } })).toThrow(ConfigError)
    expect(await fs.promises.readFile(store.path, 'utf8')).toBe(before)
  })
})

describe('settings updates', () => {
  it('merges nested default groups without dropping the others', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' }, {
      defaults: { autostart: true, restart: { maxRetries: 7, baseDelayMs: 250 } },
    })

    store.updateDefaults({ restart: { maxRetries: 2 } })

    expect(store.defaults.autostart).toBe(true)
    expect(store.defaults.restart.maxRetries).toBe(2)
    expect(store.defaults.restart.baseDelayMs).toBe(250)
  })

  it('applies edited defaults to the servers that inherit them', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' }, { defaults: { autostart: false } })
    store.addServer({ id: 'b', command: 'node', autostart: false })

    store.updateDefaults({ autostart: true })

    expect(store.getServer('a')?.autostart).toBe(true)
    expect(store.getServer('b')?.autostart).toBe(false)
  })

  it('rejects an invalid defaults patch and leaves the file alone', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })
    const before = await fs.promises.readFile(store.settingsPath, 'utf8')

    expect(() => store.updateDefaults({ restart: { factor: 0.5 } })).toThrow(ConfigError)
    expect(await fs.promises.readFile(store.settingsPath, 'utf8')).toBe(before)
  })
})

describe('write separation', () => {
  it('a settings write never touches the servers file, and vice versa', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })

    const serversBefore = await fs.promises.readFile(store.path, 'utf8')
    store.updateDefaults({ autostart: true })
    store.updateLogs({ keep: 5 })
    expect(await fs.promises.readFile(store.path, 'utf8')).toBe(serversBefore)
    // …and the settings landed where they belong.
    expect(read(store.settingsPath).defaults.autostart).toBe(true)

    const settingsBefore = await fs.promises.readFile(store.settingsPath, 'utf8')
    store.updateServer('a', { label: 'moved' })
    expect(await fs.promises.readFile(store.settingsPath, 'utf8')).toBe(settingsBefore)
    expect(read(store.path).servers[0].label).toBe('moved')
  })
})

describe('dynamic DNS config', () => {
  it('defaults to off, and a settings file from before the block still reads', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })

    expect(store.ddns).toMatchObject({ enabled: false, intervalMs: 300000, ttl: 1 })
    expect(store.ddns.ipv4.enabled).toBe(true)
    expect(store.ddns.ipv6.enabled).toBe(false)
    expect(store.ddns.accounts).toEqual([])
  })

  it('replaces the block as a whole, so a removed hostname really goes', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' }, {
      ddns: {
        enabled: true,
        accounts: [{ id: 'cf', provider: 'cloudflare' }],
        domains: [
          { host: 'a.example.com', account: 'cf' },
          { host: 'b.example.com', account: 'cf' },
        ],
      },
    })

    store.updateDdns({
      ...store.ddns,
      domains: [{ host: 'a.example.com', account: 'cf', types: ['A'], proxied: false, enabled: true }],
    })

    expect(store.ddns.domains.map(domain => domain.host)).toEqual(['a.example.com'])
    expect(read(store.settingsPath).ddns.domains).toHaveLength(1)
  })

  it('refuses a block this release cannot read, and leaves the file alone', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })
    const before = await fs.promises.readFile(store.settingsPath, 'utf8')

    expect(() => store.updateDdns({ enabled: true, intervalMs: 10 } as never)).toThrow(ConfigError)
    expect(await fs.promises.readFile(store.settingsPath, 'utf8')).toBe(before)
  })

  it('still saves a block that carries a key this release does not know', async () => {
    // `notify` was removed from the schema after 0.6.7 wrote it; a save must not
    // fail on it, and the key stays on disk the way every unknown key does.
    const { store } = await storeWith({ id: 'a', command: 'node' }, {
      ddns: {
        enabled: true,
        notify: false,
        accounts: [{ id: 'cf', provider: 'cloudflare' }],
        domains: [{ host: 'a.example.com', account: 'cf' }],
      },
    })

    expect(store.configWarnings.join(' ')).toContain('notify')
    expect(store.ddns).not.toHaveProperty('notify')

    store.updateDdns({ enabled: false })
    expect(store.ddns.enabled).toBe(false)

    const written = read(store.settingsPath)
    expect(written.ddns.notify).toBe(false)
    expect(written.ddns.accounts).toHaveLength(1)
  })
})

describe('unknown keys in a group', () => {
  it('do not stop any settings write', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' }, {
      logs: { keep: 3, futureKnob: 'x' },
    })

    expect(() => store.updateLogs({ keep: 5 })).not.toThrow()
    expect(store.logs.keep).toBe(5)

    const written = read(store.settingsPath)
    expect(written.logs.futureKnob).toBe('x')
  })
})

describe('logs, notifications and dependencies', () => {
  it('updates log retention and notification policy', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })

    store.updateLogs({ persist: false, keep: 5 })
    store.updateNotifications({ telegram: { enabled: true, chatId: '42' } })

    expect(store.logs.persist).toBe(false)
    expect(store.logs.keep).toBe(5)
    expect(store.logs.maxBytes).toBe(2000000)
    expect(store.notifications.telegram.chatId).toBe('42')
    expect(store.notifications.telegram.onCrash).toBe(true)
  })

  it('rejects an out-of-range retention value', async () => {
    const { store } = await storeWith({ id: 'a', command: 'node' })
    expect(() => store.updateLogs({ keep: 99 as never })).toThrow(ConfigError)
  })

  it('carries dependsOn through to the resolved server', async () => {
    const { store } = await storeWith({ id: 'app', command: 'node', dependsOn: ['db'] })
    store.addServer({ id: 'db', command: 'node' })

    expect(store.getServer('app')?.dependsOn).toEqual(['db'])
    expect(store.configError).toBeNull()
  })

  it('reports a dangling dependency without dropping the server', async () => {
    const { store } = await storeWith({ id: 'app', command: 'node', dependsOn: ['ghost'] })

    expect(store.getServer('app')).toBeDefined()
    expect(store.configError).toBeNull()
    expect(store.configWarnings.join('\n')).toContain('unknown server "ghost"')
  })

  it('reports a dependency cycle and self references', async () => {
    const cyclic = await storeWith({ id: 'a', command: 'node', dependsOn: ['b'] })
    cyclic.store.addServer({ id: 'b', command: 'node', dependsOn: ['a'] })
    expect(cyclic.store.configWarnings.join('\n')).toContain('dependency cycle')

    const self = await storeWith({ id: 'a', command: 'node', dependsOn: ['a'] })
    expect(self.store.configWarnings.join('\n')).toContain('depends on itself')
  })
})
