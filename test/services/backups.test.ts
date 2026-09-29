import type { BackupSources } from '#src/services/backups'
import type { BackupsConfig } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { projectDir } from '#src/helpers/paths'
import { isZipArchive, listZip } from '#src/providers/archive'
import { BackupService, resolveBackupPaths, slugifyPath } from '#src/services/backups'
import { backupsSchema, serverSchema } from '#src/shared/contracts'

// An absolute path in the platform's own syntax: these fixtures used POSIX `/srv/…`,
// which a Windows run normalizes to `\srv\…` and then fails to match.
const fixtureRoot = path.parse(process.cwd()).root

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

/** A parsed server entry, for the pure path-resolution tests and the fixtures. */
function serverConfig(overrides: Record<string, unknown>) {
  const parsed = serverSchema({ id: 'app', command: 'node', ...overrides })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return { ...parsed, port: parsed.port ?? null }
}

interface Fixture {
  service: BackupService
  root: string
  dataRoot: string
  globalSettingsPath: string
  globalSecretsPath: string
  tlsDir: string
  workspaceSettingsPath: string
  serversPath: string
  workspaceSecretsPath: string
  dataDir: string
  config: BackupsConfig
  sources: BackupSources
}

/**
 * A realistic two-level instance: the global `.hh` files, one `default`
 * workspace beside them, and a declared data directory. The backup directory
 * (`backups.dir`, relative to `dataRoot`) lives under `.hh` and is created on
 * demand by the service, never by the fixture.
 */
async function makeFixture(
  options: {
    keep?: number
    enabled?: boolean
    /** Paths the workspace's server declares as `dataEnvs`; defaults to the data directory. */
    dataPaths?: string[]
    /** Extra global `backups.includePaths`. */
    includePaths?: string[]
    ignoreGenerated?: boolean
    onRestored?: () => void
  } = {},
): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-backup-'))
  dirs.push(root)

  const dataRoot = path.join(root, '.hh')
  const globalSettingsPath = path.join(dataRoot, 'settings.json')
  const globalSecretsPath = path.join(dataRoot, '.control-secrets.json')
  const tlsDir = path.join(dataRoot, '.tls')
  const workspaceDir = path.join(dataRoot, 'default')
  const workspaceSettingsPath = path.join(workspaceDir, 'settings.json')
  const serversPath = path.join(workspaceDir, 'servers.config.json')
  const workspaceSecretsPath = path.join(workspaceDir, '.secrets.json')
  const dataDir = path.join(root, 'data')

  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(tlsDir, { recursive: true })
  fs.writeFileSync(path.join(tlsDir, 'control.crt.pem'), 'CERT\n')
  fs.writeFileSync(path.join(tlsDir, 'control.key.pem'), 'KEY\n')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'db.sqlite'), 'ORIGINAL\n')
  fs.writeFileSync(path.join(dataDir, 'empty.txt'), '')
  fs.writeFileSync(globalSecretsPath, '{ "password": null }\n', { mode: 0o600 })
  fs.writeFileSync(workspaceSecretsPath, '{ "telegram": null }\n', { mode: 0o600 })
  fs.writeFileSync(workspaceSettingsPath, '{ "logs": {} }\n')

  const parsed = backupsSchema({ dir: '.backups', keep: options.keep ?? 5, enabled: options.enabled ?? true, includePaths: options.includePaths ?? [] })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)

  fs.writeFileSync(globalSettingsPath, `${JSON.stringify({
    backups: { dir: parsed.dir, keep: parsed.keep, enabled: parsed.enabled, includePaths: parsed.includePaths },
  }, null, 2)}\n`)

  const dataEnvs: Record<string, string> = {}
  ;(options.dataPaths ?? [dataDir]).forEach((target, index) => {
    dataEnvs[index === 0 ? 'DATA_DIR' : `DATA_DIR_${index}`] = target
  })
  const servers = [serverConfig({
    id: 'app',
    dataEnvs,
    ...(options.ignoreGenerated === undefined ? {} : { backupIgnoreGenerated: options.ignoreGenerated }),
  })]
  fs.writeFileSync(serversPath, `${JSON.stringify({ servers }, null, 2)}\n`)

  const sources: BackupSources = {
    globalSettingsPath,
    globalSecretsPath,
    tlsDir,
    includePaths: parsed.includePaths,
    workspaces: [{
      id: 'default',
      label: 'Default',
      settingsPath: workspaceSettingsPath,
      serversPath,
      secretsPath: workspaceSecretsPath,
      servers,
    }],
  }

  const service = new BackupService({
    dataRoot,
    onRestored: options.onRestored,
    getConfig: () => parsed,
    getSources: () => sources,
  })

  return {
    service,
    root,
    dataRoot,
    globalSettingsPath,
    globalSecretsPath,
    tlsDir,
    workspaceSettingsPath,
    serversPath,
    workspaceSecretsPath,
    dataDir,
    config: parsed,
    sources,
  }
}

describe('slugifyPath', () => {
  it('produces a filesystem-safe name', () => {
    expect(slugifyPath('/home/user/.omniroute')).toBe('home-user-omniroute')
    expect(slugifyPath('.')).toBe('path')
  })
})

describe('resolveBackupPaths', () => {
  // `resolveBackupPaths` normalizes what it is handed, so the fixtures build their
  // absolute paths with `path` and compare against the same normalized form. Literal
  // `/srv/…` strings read fine on POSIX but become `\srv\…` on Windows.
  const appDir = path.join(fixtureRoot, 'app')
  const cacheDir = path.join(fixtureRoot, 'app-cache')
  const sharedDir = path.join(fixtureRoot, 'shared')
  const otherDir = path.join(fixtureRoot, 'other')

  it('turns each data env into a backed-up path and remembers its origin', () => {
    const paths = resolveBackupPaths([serverConfig({ dataEnvs: { DATA_DIR: appDir, CACHE_DIR: cacheDir } })])
    expect(paths).toEqual([
      { path: appDir, origin: 'app:DATA_DIR', included: true, note: null, ignoreGenerated: true },
      { path: cacheDir, origin: 'app:CACHE_DIR', included: true, note: null, ignoreGenerated: true },
    ])
  })

  it('carries the entry\'s generated-file flag, and never applies it to a global path', () => {
    const paths = resolveBackupPaths(
      [serverConfig({ dataEnvs: { DATA_DIR: appDir }, backupIgnoreGenerated: false })],
      [sharedDir],
    )

    expect(paths.find(entry => entry.origin === 'app:DATA_DIR')?.ignoreGenerated).toBe(false)
    expect(paths.find(entry => entry.origin === 'global')?.ignoreGenerated).toBe(false)
    expect(resolveBackupPaths([serverConfig({ dataEnvs: { DATA_DIR: appDir } })])[0]?.ignoreGenerated).toBe(true)
  })

  it('skips a path a declared parent already covers', () => {
    const paths = resolveBackupPaths([
      serverConfig({ dataEnvs: { DATA_DIR: appDir }, backupPaths: [path.join(appDir, 'cache'), otherDir] }),
    ])

    expect(paths.find(entry => entry.path === appDir)).toMatchObject({ included: true })
    expect(paths.find(entry => entry.path === path.join(appDir, 'cache')))
      .toMatchObject({ included: false, origin: 'app:backupPaths', note: `covered by ${appDir}` })
    expect(paths.find(entry => entry.path === otherDir)).toMatchObject({ included: true })
  })

  it('reports a path declared twice instead of capturing it twice', () => {
    const paths = resolveBackupPaths([serverConfig({ dataEnvs: { DATA_DIR: appDir }, backupPaths: [appDir] })])
    expect(paths).toHaveLength(2)
    expect(paths[1]).toMatchObject({ included: false, note: 'already declared by app:DATA_DIR' })
  })

  it('includes the global list and expands templates, `~` and env references', () => {
    process.env.HHOSTED_TEST_DATA = path.join(projectDir, 'srv', 'custom')
    try {
      const paths = resolveBackupPaths(
        // eslint-disable-next-line no-template-curly-in-string -- the literal reference is the point
        [serverConfig({ dataEnvs: { ROUTER_DATA: '{home}/.omniroute', CUSTOM: '${HHOSTED_TEST_DATA}' } })],
        ['{projectDir}/shared'],
      )

      expect(paths.find(entry => entry.origin === 'global')?.path).toBe(path.join(projectDir, 'shared'))
      expect(paths.find(entry => entry.origin === 'app:ROUTER_DATA')?.path).toBe(path.join(os.homedir(), '.omniroute'))
      expect(paths.find(entry => entry.origin === 'app:CUSTOM')?.path).toBe(path.join(projectDir, 'srv', 'custom'))
    }
    finally {
      delete process.env.HHOSTED_TEST_DATA
    }
  })
})

describe('backup service', () => {
  it('exposes the three global leaves and the default workspace tree', async () => {
    const fixture = await makeFixture()
    const view = fixture.service.view()

    expect(view.includePaths).toEqual([])
    expect(view.entries.map(entry => entry.id)).toEqual([
      'global:settings',
      'global:secrets',
      'global:tls',
      'workspace:default',
    ])
    expect(view.entries.slice(0, 3).map(entry => entry.kind)).toEqual(['settings', 'secrets', 'tls'])
    expect(view.entries.slice(0, 3).every(entry => entry.items.length === 0)).toBe(true)

    const workspace = view.entries.find(entry => entry.id === 'workspace:default')!
    expect(workspace).toMatchObject({ kind: 'workspace', workspaceId: 'default' })
    expect(workspace.items.map(item => item.id)).toEqual([
      'workspace:default:settings',
      'workspace:default:servers',
      'workspace:default:secrets',
      `workspace:default:data:${fixture.dataDir}`,
    ])
    expect(workspace.items.filter(item => item.kind !== 'data').every(item => item.included)).toBe(true)
  })

  it('lists a global include path as a data leaf of every workspace', async () => {
    const extra = path.join(fixtureRoot, 'extra')
    const fixture = await makeFixture({ includePaths: [extra] })

    const view = fixture.service.view()
    expect(view.includePaths).toEqual([extra])
    const data = view.entries.find(entry => entry.id === 'workspace:default')!.items.filter(item => item.kind === 'data')
    expect(data.map(item => item.origin).sort()).toEqual(['app:DATA_DIR', 'global'])
    expect(data.find(item => item.origin === 'global')).toMatchObject({ path: extra, included: true })
  })

  it('creates an archive with global and workspace state plus declared data', async () => {
    const fixture = await makeFixture()
    const result = await fixture.service.create()

    expect(result.ok).toBe(true)
    expect(result.file?.name).toMatch(/^backup-.*\.zip$/)
    expect(result.file?.encrypted).toBe(false)
    expect(result.file?.sizeBytes).toBeGreaterThan(0)

    const names = (await listZip(path.join(fixture.service.directory, result.file!.name))).map(entry => entry.name)
    expect(names).toContain('manifest.json')
    expect(names).toContain('global/settings.json')
    expect(names).toContain('global/secrets.json')
    expect(names).toContain('global/tls/control.crt.pem')
    expect(names).toContain('workspaces/default/settings.json')
    expect(names).toContain('workspaces/default/servers.config.json')
    expect(names).toContain('workspaces/default/secrets.json')
    expect(names).toContain(`data/${slugifyPath(fixture.dataDir)}/db.sqlite`)
  })

  it('leaves generated directories out when the entry asks for it', async () => {
    const fixture = await makeFixture({ ignoreGenerated: true })
    const generated = [
      path.join(fixture.dataDir, 'node_modules', 'pkg', 'index.js'),
      path.join(fixture.dataDir, '.next', 'cache', 'entry'),
      path.join(fixture.dataDir, 'dist', 'bundle.js'),
    ]
    for (const file of generated) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'generated\n')
    }
    fs.mkdirSync(path.join(fixture.dataDir, 'uploads'), { recursive: true })
    fs.writeFileSync(path.join(fixture.dataDir, 'uploads', 'keep.txt'), 'keep\n')

    const result = await fixture.service.create()
    const names = (await listZip(path.join(fixture.service.directory, result.file!.name))).map(entry => entry.name)

    for (const name of ['node_modules', '.next', 'dist'])
      expect(names.some(entry => entry.includes(`/${name}/`)), name).toBe(false)
    expect(names).toContain(`data/${slugifyPath(fixture.dataDir)}/uploads/keep.txt`)
    expect(names).toContain(`data/${slugifyPath(fixture.dataDir)}/db.sqlite`)
  })

  it('keeps generated directories for an entry with the flag off', async () => {
    const fixture = await makeFixture({ ignoreGenerated: false })
    fs.mkdirSync(path.join(fixture.dataDir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(fixture.dataDir, 'node_modules', 'pkg', 'index.js'), 'generated\n')

    const result = await fixture.service.create()
    const names = (await listZip(path.join(fixture.service.directory, result.file!.name))).map(entry => entry.name)

    expect(names).toContain(`data/${slugifyPath(fixture.dataDir)}/node_modules/pkg/index.js`)
  })

  it('refuses to create anything when disabled', async () => {
    const fixture = await makeFixture({ enabled: false })
    const result = await fixture.service.create()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('disabled')
  })

  it('captures only the leaves `include` names', async () => {
    const fixture = await makeFixture()
    const serversOnly = await fixture.service.create({ include: ['workspace:default:servers'] })

    expect(serversOnly.ok).toBe(true)
    const names = (await listZip(path.join(fixture.service.directory, serversOnly.file!.name))).map(entry => entry.name)
    expect(names).toContain('workspaces/default/servers.config.json')
    expect(names).not.toContain('workspaces/default/settings.json')
    expect(names).not.toContain('workspaces/default/secrets.json')
    expect(names).not.toContain('global/settings.json')
    expect(names).not.toContain('global/secrets.json')
    expect(names.some(entry => entry.startsWith('global/tls'))).toBe(false)
    expect(names.some(entry => entry.startsWith('data/'))).toBe(false)

    const dataOnly = await fixture.service.create({ include: [`workspace:default:data:${fixture.dataDir}`] })
    const dataNames = (await listZip(path.join(fixture.service.directory, dataOnly.file!.name))).map(entry => entry.name)
    expect(dataNames).toContain(`data/${slugifyPath(fixture.dataDir)}/db.sqlite`)
    expect(dataNames).not.toContain('workspaces/default/servers.config.json')
  })

  it('captures every leaf of a workspace when only the workspace id is named', async () => {
    const fixture = await makeFixture()
    const result = await fixture.service.create({ include: ['workspace:default'] })

    expect(result.ok).toBe(true)
    const names = (await listZip(path.join(fixture.service.directory, result.file!.name))).map(entry => entry.name)
    expect(names).toContain('workspaces/default/settings.json')
    expect(names).toContain('workspaces/default/servers.config.json')
    expect(names).toContain('workspaces/default/secrets.json')
    expect(names).toContain(`data/${slugifyPath(fixture.dataDir)}/db.sqlite`)
    expect(names).not.toContain('global/settings.json')
    expect(names).not.toContain('global/secrets.json')
    expect(names.some(entry => entry.startsWith('global/tls'))).toBe(false)
  })

  it('refuses a selection that would capture nothing', async () => {
    const fixture = await makeFixture()
    const result = await fixture.service.create({ include: ['nope', 'workspace:ghost'] })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('nothing was selected to back up')
    expect(fixture.service.list()).toHaveLength(0)
  })

  it('refuses a declared path that would swallow the archive directory', async () => {
    const fixture = await makeFixture({ dataPaths: [] })
    const config = backupsSchema({ dir: '.backups' })
    if (config instanceof type.errors)
      throw new Error(config.summary)

    const sources: BackupSources = {
      ...fixture.sources,
      workspaces: [{
        ...fixture.sources.workspaces[0]!,
        servers: [serverConfig({ id: 'app', backupPaths: [fixture.root] })],
      }],
    }
    const service = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => config,
      getSources: () => sources,
    })

    const workspace = service.view().entries.find(entry => entry.id === 'workspace:default')!
    expect(workspace.items.find(item => item.path === fixture.root))
      .toMatchObject({ included: false, note: 'contains the backup directory' })

    const created = await service.create({ include: ['workspace:default'] })
    const names = (await listZip(path.join(service.directory, created.file!.name))).map(entry => entry.name)
    expect(names.some(entry => entry.startsWith('data/'))).toBe(false)
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

    fs.writeFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'CHANGED\n')
    fs.writeFileSync(fixture.serversPath, '{ "servers": ["changed"] }\n')

    const dryRun = await fixture.service.restore(archive, { confirm: false })
    expect(dryRun.dryRun).toBe(true)
    expect(dryRun.items.find(item => item.id === 'workspace:default:servers')).toMatchObject({ restorable: true, selected: true })
    expect(dryRun.applied).toContain('Default: Servers')
    // Only the panel's own listener needs a restart; the servers are reloaded live.
    expect(dryRun.restartRequired).toBe(false)
    expect(fs.readFileSync(fixture.serversPath, 'utf8')).toContain('changed')
    expect(fs.readFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'utf8')).toBe('CHANGED\n')

    const applied = await fixture.service.restore(archive, { confirm: true, password: undefined })
    expect(applied.dryRun).toBe(false)
    expect(fs.readFileSync(fixture.serversPath, 'utf8')).toContain('"id": "app"')
    expect(fs.readFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'utf8')).toBe('ORIGINAL\n')
    expect(fs.readFileSync(fixture.globalSecretsPath, 'utf8')).toContain('"password"')
    // Restoring re-tightens the secrets file where the platform has POSIX modes.
    if (process.platform !== 'win32')
      expect(fs.statSync(fixture.globalSecretsPath).mode & 0o777).toBe(0o600)
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

    fs.writeFileSync(fixture.serversPath, '{ "servers": ["changed"] }\n')
    fs.writeFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'CHANGED\n')

    const locked = await fixture.service.restore(archive, { confirm: false })
    expect(locked.needsPassword).toBe(true)
    expect(locked.error).toContain('password-protected')

    const wrong = await fixture.service.restore(archive, { confirm: true, password: 'nope' })
    expect(wrong.needsPassword).toBe(true)
    expect(wrong.applied).toHaveLength(0)
    expect(fs.readFileSync(fixture.serversPath, 'utf8')).toContain('changed')

    const plan = await fixture.service.restore(archive, { confirm: false, password: 'hunter2' })
    expect(plan.error).toBeUndefined()
    expect(plan.encrypted).toBe(true)
    expect(plan.applied).toContain('Default: Servers')

    const applied = await fixture.service.restore(archive, { confirm: true, password: 'hunter2' })
    expect(applied.applied).toContain(fixture.dataDir)
    expect(fs.readFileSync(fixture.serversPath, 'utf8')).toContain('"id": "app"')
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

    fs.writeFileSync(fixture.globalSettingsPath, '{ "backups": { "keep": 99 } }\n')
    fs.writeFileSync(path.join(fixture.dataDir, 'db.sqlite'), 'CHANGED\n')

    const plan = await fixture.service.restore(archive, { confirm: true, include: ['config'] })
    expect(plan.applied).toEqual(['Global settings'])
    expect(plan.items.find(item => item.id === 'global:secrets')).toMatchObject({ restorable: true, selected: false })
    expect(plan.items.find(item => item.id === `workspace:default:data:${fixture.dataDir}`)).toMatchObject({ kind: 'data', selected: false })
    expect(plan.skipped.some(entry => entry.includes('not selected'))).toBe(true)

    expect(JSON.parse(fs.readFileSync(fixture.globalSettingsPath, 'utf8'))).toMatchObject({ backups: { keep: 5 } })
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

  it('skips a data path neither the current config nor the backup declares', async () => {
    const fixture = await makeFixture()
    const slug = slugifyPath(fixture.dataDir)
    const archive = path.join(fixture.root, 'data-only.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'elsewhere',
        data: [{ slug, path: fixture.dataDir, origin: 'app:DATA_DIR', workspace: 'default' }],
      }),
      'workspaces/default/servers.config.json': JSON.stringify({ servers: [] }),
      [`data/${slug}/db.sqlite`]: 'RESTORED\n',
    })

    const bare = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => fixture.config,
      getSources: () => ({
        ...fixture.sources,
        workspaces: [{ ...fixture.sources.workspaces[0]!, servers: [] }],
      }),
    })

    const plan = await bare.restore(archive, { confirm: false })
    expect(plan.skipped.some(entry => entry.includes('not declared by this config'))).toBe(true)
    expect(plan.items.some(item => item.kind === 'data' && item.restorable)).toBe(false)
    expect(plan.applied).not.toContain(fixture.dataDir)
  })

  it('restores a whole setup onto a workspace that declares nothing, following the backup\'s own config', async () => {
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
      'global/settings.json': JSON.stringify({ control: { port: 4123 }, backups: { includePaths: [] } }),
      'global/secrets.json': '{"password":"hash"}\n',
      'workspaces/default/servers.config.json': JSON.stringify({
        servers: [{
          id: 'app',
          command: 'node',
          autostart: true,
          dataEnvs: { DATA_DIR: targetDir },
          backupPaths: [otherDir],
        }],
      }),
      'data/home-someone-app/db.sqlite': 'RESTORED\n',
    })

    // The workspace exists but declares nothing at all.
    const blank = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => fixture.config,
      getSources: () => ({
        ...fixture.sources,
        workspaces: [{ ...fixture.sources.workspaces[0]!, servers: [] }],
      }),
    })

    const plan = await blank.restore(archive, { confirm: false })
    expect(plan.error).toBeUndefined()
    expect(plan.restartRequired).toBe(true)
    expect(plan.items.find(item => item.id === 'global:settings')).toMatchObject({ restorable: true, selected: true })
    expect(plan.items.find(item => item.id === `workspace:default:data:${targetDir}`)).toMatchObject({
      label: targetDir,
      restorable: true,
      selected: true,
      note: 'restored from /home/someone/.app',
    })

    const applied = await blank.restore(archive, { confirm: true })
    expect(applied.applied).toContain(targetDir)
    expect(fs.readFileSync(path.join(targetDir, 'db.sqlite'), 'utf8')).toBe('RESTORED\n')
    expect(JSON.parse(fs.readFileSync(fixture.globalSettingsPath, 'utf8'))).toMatchObject({ control: { port: 4123 } })
    expect(fs.readFileSync(fixture.globalSecretsPath, 'utf8')).toContain('hash')
  })

  it('resolves the backup\'s `{projectDir}` declaration against this instance', async () => {
    const fixture = await makeFixture()
    const declared = path.join(projectDir, 'data', '.9router')
    const archive = path.join(fixture.root, 'templated.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'somewhere-else',
        data: [{ slug: 'old-app', path: '/home/someone/old-project/data/.9router', origin: 'app:DATA_DIR', workspace: 'default' }],
      }),
      'workspaces/default/servers.config.json': JSON.stringify({
        servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: '{projectDir}/data/.9router' } }],
      }),
      'data/old-app/db.sqlite': 'RESTORED\n',
    })

    // Dry run: the target is this instance's `projectDir`, never the archived absolute path.
    const plan = await fixture.service.restore(archive, { confirm: false })
    expect(plan.items.find(item => item.id === `workspace:default:data:${declared}`)).toMatchObject({
      label: declared,
      restorable: true,
    })
  })

  it('keeps same-origin declarations apart instead of writing both to the first', async () => {
    const fixture = await makeFixture({ dataPaths: [] })
    const first = path.join(fixture.root, 'first')
    const second = path.join(fixture.root, 'second')
    const sources: BackupSources = {
      ...fixture.sources,
      includePaths: [first, second],
      workspaces: [{ ...fixture.sources.workspaces[0]!, servers: [] }],
    }
    const service = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => fixture.config,
      getSources: () => sources,
    })

    const archive = path.join(fixture.root, 'two-globals.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'elsewhere',
        data: [
          { slug: 'old-first', path: '/old/first', origin: 'global' },
          { slug: 'old-second', path: '/old/second', origin: 'global' },
        ],
      }),
      'data/old-first/one.txt': 'FIRST\n',
      'data/old-second/two.txt': 'SECOND\n',
    })

    const applied = await service.restore(archive, { confirm: true })
    expect(applied.applied).toEqual([first, second])
    expect(fs.readFileSync(path.join(first, 'one.txt'), 'utf8')).toBe('FIRST\n')
    expect(fs.readFileSync(path.join(second, 'two.txt'), 'utf8')).toBe('SECOND\n')
    expect(fs.existsSync(path.join(first, 'two.txt'))).toBe(false)
  })

  it('refuses the archive\'s paths when its config is not part of the restore', async () => {
    const fixture = await makeFixture({ dataPaths: [] })
    const archive = path.join(fixture.root, 'shared.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'elsewhere',
        data: [{ slug: 'x', path: '/home/someone/.app', origin: 'app:DATA_DIR', workspace: 'default' }],
      }),
      'workspaces/default/servers.config.json': JSON.stringify({
        servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: path.join(fixture.root, 'app') } }],
      }),
      'data/x/db.sqlite': 'RESTORED\n',
    })

    const plan = await fixture.service.restore(archive, { confirm: false, include: ['global:secrets'] })
    expect(plan.items.find(item => item.id === 'data:/home/someone/.app')).toMatchObject({
      restorable: false,
      selected: false,
      note: 'declared by the backup\'s config, which is not being restored',
    })
    expect(plan.skipped.join(' ')).toContain('not being restored')
  })

  it('tells its owner when the restored config was reloaded', async () => {
    let reloaded = 0
    const fixture = await makeFixture({ onRestored: () => { reloaded++ } })
    const created = await fixture.service.create()
    const archive = path.join(fixture.service.directory, created.file!.name)

    const dryRun = await fixture.service.restore(archive, { confirm: false })
    expect(dryRun.reloaded).toBe(false)
    expect(reloaded).toBe(0)

    await fixture.service.restore(archive, { confirm: true })
    expect(reloaded).toBe(1)

    // Selecting everything but the config leaves the running setup alone.
    await fixture.service.restore(archive, { confirm: true, include: ['global:secrets'] })
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
    await makeZip(traversal, { 'global/../../evil.txt': 'evil\n' })
    expect((await fixture.service.restore(traversal, { confirm: true })).error).toBeDefined()
    expect(fs.existsSync(path.join(fixture.root, '..', 'evil.txt'))).toBe(false)
  })

  it('rejects a non-archive and an archive without a manifest', async () => {
    const fixture = await makeFixture()

    const junk = path.join(fixture.root, 'junk.zip')
    fs.writeFileSync(junk, 'not a zip at all')
    expect((await fixture.service.restore(junk, { confirm: false })).error).toContain('not a home-hosted backup')

    const noManifest = path.join(fixture.root, 'nomanifest.zip')
    await makeZip(noManifest, { 'global/settings.json': '{}\n' })
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
