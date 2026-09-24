import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { isZipArchive, listZip } from '#src/providers/archive'
import { BackupService, resolveBackupPaths, slugifyPath } from '#src/services/backups'
import { backupsSchema, serverSchema } from '#src/shared/contracts'

/** Stands in for the project directory a real run would pass to the templates. */
const projectDir = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

/** Builds a zip by hand, for the cases the service must refuse. */
async function makeZip(file: string, entries: Record<string, string>): Promise<void> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const [name, content] of Object.entries(entries))
    await writer.add(name, new Uint8ArrayReader(Buffer.from(content)))
  fs.writeFileSync(file, await writer.close())
}

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

/** A parsed server entry, for the pure path-resolution tests. */
function serverConfig(overrides: Record<string, unknown>) {
  const parsed = serverSchema({ id: 'app', command: 'node', ...overrides })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return { ...parsed, port: parsed.port ?? null }
}

interface Fixture {
  service: BackupService
  root: string
  configPath: string
  secretsPath: string
  tlsDir: string
  dataDir: string
}

async function makeFixture(
  options: { keep?: number, enabled?: boolean, dataPaths?: string[], onConfigRestored?: () => void } = {},
): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-backup-'))
  dirs.push(root)

  const configPath = path.join(root, 'servers.config.json')
  const secretsPath = path.join(root, '.control-secrets.json')
  const tlsDir = path.join(root, '.tls')
  const dataDir = path.join(root, 'data')

  fs.writeFileSync(configPath, '{ "servers": [] }\n')
  fs.writeFileSync(secretsPath, '{ "password": null }\n', { mode: 0o600 })
  fs.mkdirSync(tlsDir, { recursive: true })
  fs.writeFileSync(path.join(tlsDir, 'control.crt.pem'), 'CERT\n')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'db.sqlite'), 'ORIGINAL\n')
  fs.writeFileSync(path.join(dataDir, 'empty.txt'), '')

  const parsed = backupsSchema({ dir: '.backups', keep: options.keep ?? 5, enabled: options.enabled ?? true })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)

  const service = new BackupService({
    dataRoot: root,
    onConfigRestored: options.onConfigRestored,
    getConfig: () => parsed,
    getSources: () => ({
      configPath,
      secretsPath,
      tlsDir,
      paths: (options.dataPaths ?? [dataDir]).map(target => ({ path: target, origin: 'test', included: true, note: null })),
    }),
  })

  return { service, root, configPath, secretsPath, tlsDir, dataDir }
}

describe('slugifyPath', () => {
  it('produces a filesystem-safe name', () => {
    expect(slugifyPath('/home/user/.9router')).toBe('home-user-9router')
    expect(slugifyPath('.')).toBe('path')
  })
})

describe('resolveBackupPaths', () => {
  it('turns each data env into a backed-up path and remembers its origin', () => {
    const paths = resolveBackupPaths([serverConfig({ dataEnvs: { DATA_DIR: '/srv/app', CACHE_DIR: '/srv/app-cache' } })])
    expect(paths).toEqual([
      { path: '/srv/app', origin: 'app:DATA_DIR', included: true, note: null },
      { path: '/srv/app-cache', origin: 'app:CACHE_DIR', included: true, note: null },
    ])
  })

  it('skips a path a declared parent already covers', () => {
    const paths = resolveBackupPaths([
      serverConfig({ dataEnvs: { DATA_DIR: '/srv/app' }, backupPaths: ['/srv/app/cache', '/srv/other'] }),
    ])

    expect(paths.find(entry => entry.path === '/srv/app')).toMatchObject({ included: true })
    expect(paths.find(entry => entry.path === '/srv/app/cache'))
      .toMatchObject({ included: false, origin: 'app:backupPaths', note: 'covered by /srv/app' })
    expect(paths.find(entry => entry.path === '/srv/other')).toMatchObject({ included: true })
  })

  it('reports a path declared twice instead of capturing it twice', () => {
    const paths = resolveBackupPaths([serverConfig({ dataEnvs: { DATA_DIR: '/srv/app' }, backupPaths: ['/srv/app'] })])
    expect(paths).toHaveLength(2)
    expect(paths[1]).toMatchObject({ included: false, note: 'already declared by app:DATA_DIR' })
  })

  it('includes the global list and expands templates, `~` and env references', () => {
    process.env.HHOSTED_TEST_DATA = path.join(projectDir, 'srv', 'custom')
    try {
      const paths = resolveBackupPaths(
        // eslint-disable-next-line no-template-curly-in-string -- the literal reference is the point
        [serverConfig({ dataEnvs: { ROUTER_DATA: '{home}/.9router', CUSTOM: '${HHOSTED_TEST_DATA}' } })],
        ['{projectDir}/shared'],
      )

      expect(paths.find(entry => entry.origin === 'global')?.path).toBe(path.join(projectDir, 'shared'))
      expect(paths.find(entry => entry.origin === 'app:ROUTER_DATA')?.path).toBe(path.join(os.homedir(), '.9router'))
      expect(paths.find(entry => entry.origin === 'app:CUSTOM')?.path).toBe(path.join(projectDir, 'srv', 'custom'))
    }
    finally {
      delete process.env.HHOSTED_TEST_DATA
    }
  })
})

describe('backup service', () => {
  it('creates an archive with config, secrets, tls and declared data', async () => {
    const fixture = await makeFixture()
    const result = await fixture.service.create()

    expect(result.ok).toBe(true)
    expect(result.file?.name).toMatch(/^backup-.*\.zip$/)
    expect(result.file?.encrypted).toBe(false)
    expect(result.file?.sizeBytes).toBeGreaterThan(0)

    const names = (await listZip(path.join(fixture.service.directory, result.file!.name))).map(entry => entry.name)
    expect(names).toContain('config/servers.config.json')
    expect(names).toContain('secrets/control-secrets.json')
    expect(names).toContain('tls/control.crt.pem')
    expect(names).toContain('manifest.json')
    expect(names).toContain(`data/${slugifyPath(fixture.dataDir)}/db.sqlite`)
  })

  it('refuses to create anything when disabled', async () => {
    const fixture = await makeFixture({ enabled: false })
    const result = await fixture.service.create()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('disabled')
  })

  it('refuses a declared path that would swallow the archive directory', async () => {
    const fixture = await makeFixture()
    const config = backupsSchema({ dir: '.backups' })
    if (config instanceof type.errors)
      throw new Error(config.summary)

    const service = new BackupService({
      dataRoot: fixture.root,
      getConfig: () => config,
      getSources: () => ({
        configPath: fixture.configPath,
        secretsPath: fixture.secretsPath,
        tlsDir: fixture.tlsDir,
        paths: [{ path: fixture.root, origin: 'test', included: true, note: null }],
      }),
    })

    expect(service.paths[0]).toMatchObject({ included: false, note: 'contains the backup directory' })
    expect(service.dataPaths).toEqual([])
  })

  it('lists newest first and prunes beyond `keep`', async () => {
    const fixture = await makeFixture({ keep: 2 })
    const names: string[] = []
    for (const offset of [0, 1, 2]) {
      const result = await fixture.service.create()
      names.push(result.file!.name)
      // Distinct mtimes keep the sort deterministic.
      const file = path.join(fixture.service.directory, result.file!.name)
      const when = Date.now() + offset * 1000
      fs.utimesSync(file, when / 1000, when / 1000)
    }

    const listed = fixture.service.list()
    expect(listed).toHaveLength(2)
    expect(listed.some(entry => entry.name === names[2])).toBe(true)
  })

  it('plans a restore without touching anything, then applies it', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create()
    const archive = path.join(fixture.service.directory, created.file!.name)

    fs.writeFileSync(`${fixture.dataDir}/db.sqlite`, 'CHANGED\n')
    fs.writeFileSync(fixture.configPath, '{ "servers": ["changed"] }\n')

    const dryRun = await fixture.service.restore(archive, { confirm: false })
    expect(dryRun.dryRun).toBe(true)
    expect(dryRun.applied).toContain('config/servers.config.json')
    // Only the panel's own listener needs a restart; the servers are reloaded live.
    expect(dryRun.restartRequired).toBe(false)
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toContain('changed')
    expect(fs.readFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'utf8')).toBe('CHANGED\n')

    const applied = await fixture.service.restore(archive, { confirm: true, password: undefined })
    expect(applied.dryRun).toBe(false)
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toContain('"servers": []')
    expect(fs.readFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'utf8')).toBe('ORIGINAL\n')
    expect(fs.readFileSync(fixture.secretsPath, 'utf8')).toContain('"password"')
    expect(fs.statSync(fixture.secretsPath).mode & 0o777).toBe(0o600)
  })

  it('password-protects an archive, and only opens it with the right password', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create({ password: 'hunter2' })
    expect(created.ok).toBe(true)
    expect(created.file?.encrypted).toBe(true)

    const archive = path.join(fixture.service.directory, created.file!.name)
    expect(archive.endsWith('.zip')).toBe(true)
    expect((await listZip(archive)).some(entry => entry.encrypted)).toBe(true)
    // `list()` learns the flag from the archive itself, not from its name.
    await fixture.service.warm()
    expect(fixture.service.list()[0]?.encrypted).toBe(true)
    expect(isZipArchive(archive)).toBe(true)

    fs.writeFileSync(fixture.configPath, '{ "servers": ["changed"] }\n')
    fs.writeFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'CHANGED\n')

    const locked = await fixture.service.restore(archive, { confirm: false })
    expect(locked.needsPassword).toBe(true)
    expect(locked.error).toContain('password-protected')

    const wrong = await fixture.service.restore(archive, { confirm: true, password: 'nope' })
    expect(wrong.needsPassword).toBe(true)
    expect(wrong.applied).toHaveLength(0)
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toContain('changed')

    const plan = await fixture.service.restore(archive, { confirm: false, password: 'hunter2' })
    expect(plan.error).toBeUndefined()
    expect(plan.encrypted).toBe(true)
    expect(plan.applied).toContain('config/servers.config.json')

    const applied = await fixture.service.restore(archive, { confirm: true, password: 'hunter2' })
    expect(applied.applied).toContain(fixture.dataDir)
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toContain('"servers": []')
    expect(fs.readFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'utf8')).toBe('ORIGINAL\n')
  })

  it('stores empty files unencrypted, so older tools do not report a CRC failure', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create({ password: 'hunter2' })
    const archive = path.join(fixture.service.directory, created.file!.name)

    const entries = await listZip(archive)
    const empty = entries.find(entry => entry.name.endsWith('empty.txt'))
    expect(empty).toMatchObject({ encrypted: false, directory: false })
    expect(entries.filter(entry => !entry.directory && !entry.name.endsWith('empty.txt')).every(entry => entry.encrypted)).toBe(true)

    fs.rmSync(path.join(fixture.dataDir, 'empty.txt'))
    const plan = await fixture.service.restore(archive, { confirm: true, password: 'hunter2' })
    expect(plan.error).toBeUndefined()
    expect(fs.readFileSync(path.join(fixture.dataDir, 'empty.txt'), 'utf8')).toBe('')
  })

  it('restores only the items that were selected', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create()
    const archive = path.join(fixture.service.directory, created.file!.name)

    fs.writeFileSync(fixture.configPath, '{ "servers": ["changed"] }\n')
    fs.writeFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'CHANGED\n')

    const plan = await fixture.service.restore(archive, { confirm: true, include: ['config'] })
    expect(plan.applied).toEqual(['config/servers.config.json'])
    expect(plan.items.find(item => item.id === 'secrets')).toMatchObject({ restorable: true, selected: false })
    expect(plan.items.find(item => item.id === `data:${fixture.dataDir}`)).toMatchObject({ kind: 'data', selected: false })
    expect(plan.skipped.some(entry => entry.includes('not selected'))).toBe(true)

    expect(fs.readFileSync(fixture.configPath, 'utf8')).toContain('"servers": []')
    expect(fs.readFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'utf8')).toBe('CHANGED\n')
  })

  it('ignores a selection that names items the archive does not have', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create()
    const archive = path.join(fixture.service.directory, created.file!.name)

    const plan = await fixture.service.restore(archive, { confirm: false, include: ['nope', '../etc/passwd'] })
    expect(plan.applied).toHaveLength(0)
    expect(plan.items.every(item => !item.selected)).toBe(true)
  })

  it('skips a data path the current config no longer declares', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create()
    const archive = path.join(fixture.service.directory, created.file!.name)

    const config = backupsSchema({ dir: '.backups' })
    if (config instanceof type.errors)
      throw new Error(config.summary)

    const undeclared = new BackupService({
      dataRoot: fixture.root,
      getConfig: () => config,
      getSources: () => ({
        configPath: fixture.configPath,
        secretsPath: fixture.secretsPath,
        tlsDir: fixture.tlsDir,
        paths: [],
      }),
    })

    const plan = await undeclared.restore(archive, { confirm: false })
    expect(plan.skipped.some(entry => entry.includes('not declared by this config'))).toBe(true)
    expect(plan.applied).not.toContain(fixture.dataDir)
  })

  it('restores a whole setup onto a blank instance, following the backup\'s own config', async () => {
    const fixture = await makeFixture()
    const targetDir = path.join(fixture.root, 'restored-app')
    const otherDir = path.join(fixture.root, 'other-secrets')

    // An archive from another machine: its config declares the data directory, and
    // the manifest remembers which declaration (`origin`) it came from.
    const archive = path.join(fixture.root, 'shared.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'somewhere-else',
        data: [{ slug: 'home-someone-app', path: '/home/someone/.app', origin: 'app:DATA_DIR' }],
      }),
      'config/servers.config.json': JSON.stringify({
        control: { port: 4123 },
        servers: [{
          id: 'app',
          command: 'node',
          autostart: true,
          dataEnvs: { DATA_DIR: targetDir },
          backupPaths: [otherDir],
        }],
      }),
      'secrets/control-secrets.json': '{"password":"hash"}\n',
      'data/home-someone-app/db.sqlite': 'RESTORED\n',
    })

    // The instance is blank: it declares nothing at all.
    const plan = await fixture.service.restore(archive, { confirm: false })
    expect(plan.error).toBeUndefined()
    expect(plan.restartRequired).toBe(true)
    expect(plan.items.find(item => item.id === 'config')).toMatchObject({ restorable: true, selected: true })
    expect(plan.items.find(item => item.id === `data:${'/home/someone/.app'}`)).toMatchObject({
      label: targetDir,
      restorable: true,
      selected: true,
      note: 'restored from /home/someone/.app',
    })

    const applied = await fixture.service.restore(archive, { confirm: true })
    expect(applied.applied).toContain(targetDir)
    expect(fs.readFileSync(path.join(targetDir, 'db.sqlite'), 'utf8')).toBe('RESTORED\n')
    expect(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'))).toMatchObject({ control: { port: 4123 } })
    expect(fs.readFileSync(fixture.secretsPath, 'utf8')).toContain('hash')
  })

  it('refuses the archive\'s paths when its config is not part of the restore', async () => {
    const fixture = await makeFixture()
    const archive = path.join(fixture.root, 'shared.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'elsewhere',
        data: [{ slug: 'x', path: '/home/someone/.app', origin: 'app:DATA_DIR' }],
      }),
      'config/servers.config.json': JSON.stringify({
        servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: path.join(fixture.root, 'app') } }],
      }),
      'data/x/db.sqlite': 'RESTORED\n',
    })

    const plan = await fixture.service.restore(archive, { confirm: false, include: ['secrets'] })
    expect(plan.items.find(item => item.id === 'data:/home/someone/.app')).toMatchObject({
      restorable: false,
      selected: false,
      note: 'declared by the backup\'s config, which is not being restored',
    })
    expect(plan.skipped.join(' ')).toContain('not being restored')
  })

  it('tells its owner when the restored config was reloaded', async () => {
    let reloaded = 0
    const fixture = await makeFixture({ onConfigRestored: () => { reloaded++ } })
    const created = await fixture.service.create()
    const archive = path.join(fixture.service.directory, created.file!.name)

    const dryRun = await fixture.service.restore(archive, { confirm: false })
    expect(dryRun.reloaded).toBe(false)
    expect(reloaded).toBe(0)

    await fixture.service.restore(archive, { confirm: true })
    expect(reloaded).toBe(1)

    // Selecting everything but the config leaves the running setup alone.
    await fixture.service.restore(archive, { confirm: true, include: ['secrets'] })
    expect(reloaded).toBe(1)
  })

  it('rejects an archive with entries outside the expected layout', async () => {
    const fixture = await makeFixture()
    const payload = path.join(fixture.root, 'payload.txt')
    fs.writeFileSync(payload, 'evil\n')

    const outside = path.join(fixture.root, 'outside.zip')
    await makeZip(outside, { 'payload/evil.txt': 'evil\n' })
    expect((await fixture.service.restore(outside, { confirm: true })).error).toContain('unexpected entries')
    expect(fs.existsSync(path.join(fixture.root, '..', 'evil.txt'))).toBe(false)

    // A `..` segment is refused even earlier, by zip.js itself.
    const traversal = path.join(fixture.root, 'traversal.zip')
    await makeZip(traversal, { 'config/../../evil.txt': 'evil\n' })
    expect((await fixture.service.restore(traversal, { confirm: true })).error).toBeDefined()
    expect(fs.existsSync(path.join(fixture.root, '..', 'evil.txt'))).toBe(false)
  })

  it('rejects a non-archive and an archive without a manifest', async () => {
    const fixture = await makeFixture()

    const junk = path.join(fixture.root, 'junk.zip')
    fs.writeFileSync(junk, 'not a zip at all')
    expect((await fixture.service.restore(junk, { confirm: false })).error).toContain('not a home-hosted backup')

    const noManifest = path.join(fixture.root, 'nomanifest.zip')
    await makeZip(noManifest, { 'config/servers.config.json': '{}\n' })
    expect((await fixture.service.restore(noManifest, { confirm: false })).error).toContain('no manifest')
  })

  it('resolves only names it lists, so downloads cannot escape the directory', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create()

    expect(fixture.service.resolve(created.file!.name)).not.toBeNull()
    expect(fixture.service.resolve('../secrets.json')).toBeNull()
    expect(fixture.service.resolve('/etc/passwd')).toBeNull()
    expect(fixture.service.resolve('not-a-backup.tar.gz')).toBeNull()
  })

  it('removes a backup on request', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create()

    expect(fixture.service.remove(created.file!.name)).toBe(true)
    expect(fixture.service.list()).toHaveLength(0)
    expect(fixture.service.remove(created.file!.name)).toBe(false)
  })
})
