import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseGlobalSettings, parseServersFile, parseWorkspaceSettings } from '#src/config/parse'

/**
 * A pre-workspace `$HHOSTED_HOME` has to keep working: `migrateLayout()` relocates
 * it under `.hh` and splits the old all-in-one files. `paths.ts` resolves at import
 * time, so every case sets `HHOSTED_HOME` to its own temp dir and re-imports the
 * module graph — never the developer's real home.
 */

const fixtures = fileURLToPath(new URL('../fixtures/config/', import.meta.url))
const originalHome = process.env.HHOSTED_HOME
const dirs: string[] = []

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function freshHome(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-layout-'))
  dirs.push(dir)
  process.env.HHOSTED_HOME = dir
  return dir
}

function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
}

const legacySecrets = {
  version: 3,
  password: { algo: 'scrypt', salt: 's', hash: 'h', keylen: 64, cost: { N: 1, r: 1, p: 1 }, updatedAt: 1 },
  apiToken: { algo: 'sha256', hash: 't', hint: 'hh_abcd', updatedAt: 1 },
  telegram: { botToken: 'bot-token' },
  ddns: { cf: { provider: 'cloudflare', values: { apiToken: 'x' } } },
  ddnsKdf: { algo: 'scrypt', cost: { N: 1, r: 1, p: 1 }, salt: 'kdf' },
}

/** A legacy instance: root config + secrets + every directory the old layout used. */
async function makeLegacyHome(): Promise<string> {
  const home = await freshHome()
  fs.writeFileSync(path.join(home, 'servers.config.json'), fs.readFileSync(path.join(fixtures, 'v0.3.0.json'), 'utf8'))
  fs.writeFileSync(path.join(home, '.control-secrets.json'), JSON.stringify(legacySecrets, null, 2))
  fs.mkdirSync(path.join(home, '.logs'), { recursive: true })
  fs.writeFileSync(path.join(home, '.logs', 'home-hosted.log'), 'daemon')
  fs.writeFileSync(path.join(home, '.logs', 'home-hosted.log.1'), 'daemon-rotated')
  fs.writeFileSync(path.join(home, '.logs', 'web.jsonl'), 'server log')
  fs.mkdirSync(path.join(home, '.state'), { recursive: true })
  fs.writeFileSync(path.join(home, '.state', 'web.json'), '{}')
  fs.mkdirSync(path.join(home, '.tls'), { recursive: true })
  fs.writeFileSync(path.join(home, '.tls', 'cert.pem'), 'cert')
  fs.mkdirSync(path.join(home, '.ui'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ui', 'index.html'), 'ui')
  fs.mkdirSync(path.join(home, '.backups'), { recursive: true })
  fs.writeFileSync(path.join(home, '.backups', 'a.zip'), 'zip')
  fs.writeFileSync(path.join(home, 'run.json'), JSON.stringify({ pid: 1, token: 'x' }))
  return home
}

describe('migrateLayout', () => {
  it('does nothing when there is no pre-workspace state', async () => {
    const home = await freshHome()
    const { migrateLayout } = await import('#src/config/layout')

    expect(migrateLayout()).toEqual({ migrated: false, moved: [], warnings: [] })
    expect(fs.existsSync(path.join(home, '.hh'))).toBe(false)
  })

  it('relocates a legacy home into .hh and splits config and secrets', async () => {
    const home = await makeLegacyHome()
    const { migrateLayout } = await import('#src/config/layout')
    const { hhDir } = await import('#src/helpers/paths')

    const result = migrateLayout()
    expect(result.migrated).toBe(true)
    expect(result.warnings).toEqual([])

    // The global half: listener/host/backups only.
    const global = read(path.join(hhDir, 'settings.json'))
    expect(global.control.port).toBe(3999)
    expect(global.host.enabled).toBe(true)
    expect(global.backups.keep).toBe(5)
    expect(global).not.toHaveProperty('defaults')
    expect(global).not.toHaveProperty('logs')
    expect(global).not.toHaveProperty('notifications')
    expect(global).not.toHaveProperty('servers')

    // The workspace half: defaults/logs/notifications/ddns only.
    const settings = read(path.join(hhDir, 'default', 'settings.json'))
    expect(settings.defaults.bind).toBe('local')
    expect(settings.logs.keep).toBe(3)
    expect(settings).not.toHaveProperty('control')
    expect(settings).not.toHaveProperty('servers')

    const servers = read(path.join(hhDir, 'default', 'servers.config.json'))
    expect(servers.servers.map((entry: { id: string }) => entry.id)).toEqual(['omniroute', 'static'])

    // Secrets split: password/token global, Telegram/DDNS workspace-scoped.
    const globalSecrets = read(path.join(hhDir, '.control-secrets.json'))
    expect(globalSecrets.password.hash).toBe('h')
    expect(globalSecrets.apiToken.hint).toBe('hh_abcd')
    expect(globalSecrets.telegram ?? null).toBeNull()
    expect(globalSecrets.ddns ?? {}).toEqual({})

    const workspaceSecrets = read(path.join(hhDir, 'default', '.secrets.json'))
    expect(workspaceSecrets.telegram.botToken).toBe('bot-token')
    expect(workspaceSecrets.ddns.cf.provider).toBe('cloudflare')
    expect(workspaceSecrets.ddnsKdf.salt).toBe('kdf')
    expect(workspaceSecrets.password ?? null).toBeNull()
    expect(workspaceSecrets.apiToken ?? null).toBeNull()

    // The registry, and every directory the layout promises.
    expect(read(path.join(hhDir, 'workspaces.json')).workspaces).toEqual([{ id: 'default', label: 'Default' }])
    expect(fs.existsSync(path.join(hhDir, '.tls', 'cert.pem'))).toBe(true)
    expect(fs.existsSync(path.join(hhDir, '.ui', 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(hhDir, '.backups', 'a.zip'))).toBe(true)
    expect(fs.existsSync(path.join(hhDir, 'run.json'))).toBe(true)
    expect(fs.existsSync(path.join(hhDir, 'default', '.state', 'web.json'))).toBe(true)
    expect(fs.existsSync(path.join(hhDir, '.layout-migration.json'))).toBe(true)

    // Logs split: the daemon's own console log stays global, a per-server log moves.
    expect(fs.readFileSync(path.join(hhDir, '.logs', 'home-hosted.log'), 'utf8')).toBe('daemon')
    expect(fs.readFileSync(path.join(hhDir, '.logs', 'home-hosted.log.1'), 'utf8')).toBe('daemon-rotated')
    expect(fs.readFileSync(path.join(hhDir, 'default', '.logs', 'web.jsonl'), 'utf8')).toBe('server log')

    // The originals are gone, never left to be re-migrated.
    expect(fs.existsSync(path.join(home, 'servers.config.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.control-secrets.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.logs'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.state'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.tls'))).toBe(false)
  })

  /**
   * An unreadable legacy file must not be abandoned in silence. The layout marker and
   * `workspaces.json` are written either way, so `hasLegacyLayout()` is false afterwards
   * and `migrateLayout()` never looks at that file again — leaving the user's server
   * definitions unread beside a panel that supervises nothing.
   */
  it('warns instead of silently abandoning a legacy config it cannot read', async () => {
    const home = await makeLegacyHome()
    fs.writeFileSync(path.join(home, 'servers.config.json'), '{ truncated')
    const { migrateLayout } = await import('#src/config/layout')

    const result = migrateLayout()

    // It says so, by name.
    expect(result.warnings.some(warning => warning.includes('servers.config.json') && warning.includes('could not be read'))).toBe(true)
    // …and the only copy of the definitions is still there to recover by hand.
    expect(fs.existsSync(path.join(home, 'servers.config.json'))).toBe(true)
    // While the readable half really did migrate.
    expect(fs.existsSync(path.join(home, '.hh', '.control-secrets.json'))).toBe(true)
  })

  it('leaves state the new stores and parsers can read', async () => {
    const home = await makeLegacyHome()
    const { migrateLayout } = await import('#src/config/layout')
    migrateLayout()

    const global = parseGlobalSettings(read(path.join(home, '.hh', 'settings.json')))
    expect(global.errors).toEqual([])
    expect(global.unknownKeys).toEqual([])
    expect(global.config?.control.port).toBe(3999)

    const settings = parseWorkspaceSettings(read(path.join(home, '.hh', 'default', 'settings.json')))
    expect(settings.errors).toEqual([])
    expect(settings.config?.defaults.bind).toBe('local')

    const servers = parseServersFile(
      read(path.join(home, '.hh', 'default', 'servers.config.json')),
      settings.config?.defaults as unknown as Record<string, unknown> ?? {},
    )
    expect(servers.errors).toEqual([])
    expect(servers.servers.map(server => server.id)).toEqual(['omniroute', 'static'])
    expect(servers.servers[0]?.port).toBe(4000)
  })

  it('is idempotent: a second call changes nothing', async () => {
    const home = await makeLegacyHome()
    const { migrateLayout } = await import('#src/config/layout')
    const { hhDir } = await import('#src/helpers/paths')

    expect(migrateLayout().migrated).toBe(true)
    const snapshot = new Map<string, string>()
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory())
          walk(full)
        else
          snapshot.set(full, fs.readFileSync(full, 'utf8'))
      }
    }
    walk(hhDir)

    expect(migrateLayout()).toEqual({ migrated: false, moved: [], warnings: [] })

    const after = new Map<string, string>()
    const walkAfter = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory())
          walkAfter(full)
        else
          after.set(full, fs.readFileSync(full, 'utf8'))
      }
    }
    walkAfter(hhDir)
    expect([...after.entries()]).toEqual([...snapshot.entries()])
    expect(home).toBeTruthy()
  })

  it('still migrates a legacy home that only has a secrets file', async () => {
    const home = await freshHome()
    fs.writeFileSync(path.join(home, '.control-secrets.json'), JSON.stringify(legacySecrets, null, 2))
    const { migrateLayout } = await import('#src/config/layout')
    const { hhDir } = await import('#src/helpers/paths')

    const result = migrateLayout()
    expect(result.migrated).toBe(true)
    expect(read(path.join(hhDir, '.control-secrets.json')).password.hash).toBe('h')
    expect(read(path.join(hhDir, 'default', '.secrets.json')).telegram.botToken).toBe('bot-token')
    expect(read(path.join(hhDir, 'workspaces.json')).workspaces).toHaveLength(1)
  })

  it('warns and keeps the source when a destination already exists', async () => {
    const home = await makeLegacyHome()
    // The new layout has not been written yet, so the migration still runs — but
    // one destination is already occupied and must not be clobbered.
    fs.mkdirSync(path.join(home, '.hh', '.tls'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', '.tls', 'existing.pem'), 'existing')
    const { migrateLayout } = await import('#src/config/layout')

    const result = migrateLayout()
    expect(result.warnings.join('\n')).toContain('.tls')
    expect(fs.existsSync(path.join(home, '.tls', 'cert.pem'))).toBe(true)
    expect(fs.readFileSync(path.join(home, '.hh', '.tls', 'existing.pem'), 'utf8')).toBe('existing')
  })

  it('never deletes a legacy log it refused to move over an existing one', async () => {
    // A refused move must not become a delete: the warning says "left … alone",
    // so the file has to still be there afterwards, and the directory kept.
    const home = await makeLegacyHome()
    fs.mkdirSync(path.join(home, '.hh', '.logs'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', '.logs', 'home-hosted.log'), 'newer')
    const { migrateLayout } = await import('#src/config/layout')

    const result = migrateLayout()

    expect(result.warnings.join('\n')).toContain('home-hosted.log')
    expect(fs.existsSync(path.join(home, '.logs', 'home-hosted.log'))).toBe(true)
    expect(fs.readFileSync(path.join(home, '.logs', 'home-hosted.log'), 'utf8')).toBe('daemon')
    // The occupied destination was not clobbered, and the unmovable file is still
    // in the legacy directory rather than silently deleted.
    expect(fs.readFileSync(path.join(home, '.hh', '.logs', 'home-hosted.log'), 'utf8')).toBe('newer')
  })
})
