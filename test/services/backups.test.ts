import type { BackupSources } from '#src/services/backups'
import type { BackupsConfig } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { type } from 'arktype'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { projectDir } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'
import * as archive from '#src/providers/archive'
import { createZip as createZipFile, extractZip, isZipArchive, listZip } from '#src/providers/archive'
import { BackupService, isInside, isSafeArchiveEntry, resolveBackupPaths, slugifyPath } from '#src/services/backups'
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
  registryPath: string
  workspaceSettingsPath: string
  serversPath: string
  workspaceSecretsPath: string
  dataDir: string
  config: BackupsConfig
  sources: BackupSources
}

/** An archive built by hand, in the layout the service writes. */
async function makeArchive(file: string, options: {
  registry?: unknown
  workspaces: Record<string, { servers?: Record<string, unknown>[] }>
  data?: Array<{ slug: string, path: string, origin?: string, workspace?: string }>
  files?: Record<string, string>
}): Promise<void> {
  const entries: Record<string, string> = {
    'manifest.json': JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      hostname: 'elsewhere',
      schema: CONFIG_SCHEMA,
      data: options.data ?? [],
    }),
  }
  if (options.registry !== undefined)
    entries['global/workspaces.json'] = JSON.stringify(options.registry)
  for (const [id, content] of Object.entries(options.workspaces)) {
    entries[`workspaces/${id}/servers.config.json`] = JSON.stringify({
      meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
      servers: content.servers ?? [],
    })
  }
  await makeZip(file, { ...entries, ...options.files })
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
    /** The scheduled half; `intervalMs: 0` (the schema default) keeps it off. */
    schedule?: { intervalMs: number, keep: number }
    enabled?: boolean
    /** Paths the workspace's server declares as `dataEnvs`; defaults to the data directory. */
    dataPaths?: string[]
    /** Extra global `backups.includePaths`. */
    includePaths?: string[]
    /** Declare the fixture's own state root, which contains the archive directory. */
    coverStateRoot?: boolean
    ignoreGenerated?: boolean
    /** Raw contents of the two secrets files, when a test needs real secrets in them. */
    globalSecrets?: string
    workspaceSecrets?: string
    onRestored?: () => void
    /** Extra fields on the fixture's one server, e.g. `dump`/`load` hooks. */
    serverFields?: Record<string, unknown>
    /** Records a dump the service staged for an entry to load on its next start. */
    onLoadPending?: (workspaceId: string, serverId: string, dumpDir: string) => void
  } = {},
): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-backup-'))
  dirs.push(root)

  const dataRoot = path.join(root, '.hh')
  const globalSettingsPath = path.join(dataRoot, 'settings.json')
  const globalSecretsPath = path.join(dataRoot, '.control-secrets.json')
  const tlsDir = path.join(dataRoot, '.tls')
  const registryPath = path.join(dataRoot, 'workspaces.json')
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
  fs.writeFileSync(globalSecretsPath, options.globalSecrets ?? '{ "password": null }\n', { mode: 0o600 })
  fs.writeFileSync(registryPath, `${JSON.stringify({ $schema: './workspaces.schema.json', workspaces: [{ id: 'default', label: 'Default' }] }, null, 2)}\n`)
  fs.writeFileSync(workspaceSecretsPath, options.workspaceSecrets ?? '{ "telegram": null }\n', { mode: 0o600 })
  fs.writeFileSync(workspaceSettingsPath, `${JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, logs: {} }, null, 2)}\n`)

  const parsed = backupsSchema({ dir: '.backups', keep: options.keep ?? 5, enabled: options.enabled ?? true, includePaths: options.includePaths ?? (options.coverStateRoot === true ? [dataRoot] : []), ...(options.schedule === undefined ? {} : { schedule: options.schedule }) })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)

  fs.writeFileSync(globalSettingsPath, `${JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, backups: parsed }, null, 2)}\n`)

  const dataEnvs: Record<string, string> = {}
  ;(options.dataPaths ?? [dataDir]).forEach((target, index) => {
    dataEnvs[index === 0 ? 'DATA_DIR' : `DATA_DIR_${index}`] = target
  })
  const servers = [serverConfig({
    id: 'app',
    dataEnvs,
    ...(options.ignoreGenerated === undefined ? {} : { backupIgnoreGenerated: options.ignoreGenerated }),
    ...options.serverFields,
  })]
  fs.writeFileSync(serversPath, `${JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers }, null, 2)}\n`)

  const sources: BackupSources = {
    globalSettingsPath,
    globalSecretsPath,
    tlsDir,
    registryPath,
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
    onLoadPending: options.onLoadPending,
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
    registryPath,
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

  /**
   * The *global* `backups.includePaths` route into the same rule.
   *
   * A sibling test covers a server's `backupPaths` declaring an ancestor of the archive; this is the
   * other entry point into `resolveBackupPaths`, and a bug in one does not show up in the other.
   * The rule that actually protects this is in `declaredData` — it marks such a path `included:
   * false` with the note `contains the backup directory`, so the copy never starts. The guard inside
   * `copyInto` is a second line that this route does not reach.
   *
   * Reachability is ordinary rather than contrived: the state root is exactly the directory a person
   * would name to back everything up, and `.backups` lives inside it.
   */
  it('never copies the archive directory into itself', async () => {
    // One fixture, declaring *its own* state root: `.backups` sits inside `<root>/.hh`, so this is
    // the real reachable case — a person naming the state root to back everything up. (An earlier
    // version of this test built two fixtures and passed the first one's root to the second, which
    // pointed the include path at an unrelated temp directory and never reached the guard.)
    const fixture = await makeFixture({ coverStateRoot: true })
    const archiveDir = fixture.service.directory
    expect(path.basename(archiveDir)).toBe('.backups')
    expect(isInside(fixture.dataRoot, archiveDir), 'the archive lives under the state root').toBe(true)
    expect(fixture.config.includePaths, 'the state root is the declared path').toEqual([fixture.dataRoot])

    // The path is listed but not included, which is what stops the copy — assert that first, so a
    // failure says "the rule changed" rather than "the archive looks odd".
    const view = fixture.service.view()
    const asData = view.entries.flatMap(entry => entry.items).find(item => item.path === fixture.dataRoot)
    expect(asData, 'the state root is offered as a data leaf').toMatchObject({ included: false, note: 'contains the backup directory' })

    const result = await fixture.service.create()
    expect(result.ok, result.error).toBe(true)

    const names = (await listZip(path.join(archiveDir, result.file!.name))).map(entry => entry.name)
    // Nothing from inside the backups directory, which is where the archive itself lives.
    expect(names.filter(name => name.includes('.backups'))).toEqual([])
    // And it is still a complete archive rather than one truncated by the walk.
    expect(names).toContain('manifest.json')
    expect(names).toContain('global/settings.json')
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

  /**
   * Two archived data paths that share one `origin` must land on two different targets.
   *
   * `origin` records which declaration a path came from, and a `global` include path plus a
   * `backupPaths` value can share one — so matching on origin alone would write *both* archived entries
   * to the first candidate and leave the second path unrestored. The planner pairs same-origin
   * declarations by order instead, consuming each target once.
   *
   * That pairing is the documented reason the `used` sets exist, and nothing pinned it: both entries
   * here carry `origin: 'app:DATA_DIR'`, and only one target may take each.
   */
  /**
   * A burst of `list()` calls must queue **one** refresh, not one per call.
   *
   * `list()` is synchronous and runs on every state frame, while reading an archive's encryption flag
   * is async — so it schedules a background refresh. Without the single-flight, a frame that calls
   * `list()` (and the page calls it more than once) would queue a read per call, per file.
   *
   * Counted through the real `listZip`, since the coalescing is private state: the assertion is the
   * number of reads a burst produces, which is the thing the comment actually promises.
   */
  it('coalesces a burst of list() calls into one refresh', async () => {
    const fixture = await makeFixture()
    // Two real archives, so a refresh has something to read.
    const backupDir = path.join(fixture.dataRoot, '.backups')
    fs.mkdirSync(backupDir, { recursive: true })
    for (const name of ['probe-one.zip', 'probe-two.zip'])
      await makeZip(path.join(backupDir, name), { 'x.txt': 'x' })

    const spy = vi.spyOn(archive, 'listZip')
    try {
      for (let i = 0; i < 25; i += 1)
        fixture.service.list()

      // Let the scheduled refresh settle before counting.
      await vi.waitFor(() => {
        expect(spy.mock.calls.length).toBeGreaterThan(0)
      })
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(fixture.service.list().length).toBe(2)
      // One refresh read both archives once. A per-call refresh would be 25+ reads.
      expect(spy.mock.calls.length, 'reads for 25 list() calls').toBeLessThanOrEqual(4)
    }
    finally {
      spy.mockRestore()
    }
  })

  it('restores two data paths that share one origin onto separate targets', async () => {
    const firstDir = path.join(os.tmpdir(), 'shared-origin-a')
    const secondDir = path.join(os.tmpdir(), 'shared-origin-b')
    const fixture = await makeFixture({ includePaths: [firstDir, secondDir] })

    const archive = path.join(fixture.root, 'shared-origin.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'somewhere-else',
        // Two entries carrying the SAME origin 'global' — the collision the comment describes.
        // `backupPaths` gets `${serverId}:backupPaths`, so it cannot collide; a global include
        // path and a second global include path can, and they are what the `used` set exists for.
        data: [
          { slug: 'first-app', path: '/home/someone/first-app', origin: 'global', workspace: 'default' },
          { slug: 'second-app', path: '/home/someone/second-app', origin: 'global', workspace: 'default' },
        ],
      }),
      'global/settings.json': JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, backups: { includePaths: [] } }),
      'workspaces/default/servers.config.json': JSON.stringify({
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        // Two global include paths, plus the server's own env — the same origin twice.
        servers: [{ id: 'app', command: 'node', dataEnvs: {}, backupPaths: [] }],
      }),
      'data/first-app/first.txt': 'FIRST\n',
      'data/second-app/second.txt': 'SECOND\n',
    })

    const plan = await fixture.service.restore(archive, { confirm: false })
    expect(plan.error).toBeUndefined()

    // Each archived path gets its own target, in the archive's resolve order.
    expect(plan.items.find(item => item.id === `workspace:default:data:${firstDir}`)).toMatchObject({ restorable: true })
    expect(plan.items.find(item => item.id === `workspace:default:data:${secondDir}`)).toMatchObject({ restorable: true })

    const applied = await fixture.service.restore(archive, { confirm: true })
    expect(applied.applied).toContain(firstDir)
    expect(applied.applied).toContain(secondDir)
    // The proof the collision is resolved: each file is at its own target, not both at the first.
    expect(fs.readFileSync(path.join(firstDir, 'first.txt'), 'utf8')).toBe('FIRST\n')
    expect(fs.readFileSync(path.join(secondDir, 'second.txt'), 'utf8')).toBe('SECOND\n')
    expect(fs.existsSync(path.join(firstDir, 'second.txt'))).toBe(false)
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
      'workspaces/default/servers.config.json': JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers: [] }),
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
      'global/settings.json': JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, control: { port: 4123 }, backups: { includePaths: [] } }),
      'global/secrets.json': '{"password":"hash"}\n',
      'workspaces/default/servers.config.json': JSON.stringify({
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
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
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
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
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
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

  /**
   * The declared path is where a restore may write, and a symlink standing inside it
   * does not extend that: `cpSync` follows links already present in the destination,
   * so without a realpath check an archive could plant a file anywhere such a link
   * pointed — an uploads or cache directory is a routine thing to link — and report
   * success.
   */
  it('refuses to write through a symlink that leaves the declared data path', async () => {
    const fixture = await makeFixture()

    // A link inside the declared path, pointing outside it.
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(fixture.dataDir, 'escape'))

    // An archive that carries a file under the linked subpath.
    const archive = path.join(fixture.root, 'escape.zip')
    await makeZip(archive, {
      'manifest.json': JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        hostname: 'elsewhere',
        data: [{ slug: slugifyPath(fixture.dataDir), path: fixture.dataDir, origin: 'app:DATA_DIR', workspace: 'default' }],
      }),
      [`data/${slugifyPath(fixture.dataDir)}/escape/planted.txt`]: 'evil\n',
    })

    const plan = await fixture.service.restore(archive, { confirm: true })
    // A success carries no `error` key at all, so this also proves the restore
    // proceeded rather than bailing out earlier for an unrelated reason.
    expect(plan.error).toBeUndefined()
    expect(plan.applied).toContain(fixture.dataDir)
    // Nothing the archive carried reached the directory the link points at.
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false)
    // …and the link is not replaced by a real directory either.
    expect(fs.lstatSync(path.join(fixture.dataDir, 'escape')).isSymbolicLink()).toBe(true)
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

/**
 * Restoring a multi-workspace archive onto a host that has only `default`.
 *
 * This is the "one archive is a whole setup" promise from a *blank* host: an archive names
 * workspaces the target has never heard of, and the target has to create them. Before this,
 * such an archive's leaves were reported as "unknown workspace" — and the data pass then
 * matched the unknown workspace's directory by origin against `default`'s declaration,
 * writing it over `default`'s database.
 */
let hookScratch: string | null = null
function fixtureRootForHooks(): string {
  hookScratch ??= fs.mkdtempSync(path.join(os.tmpdir(), 'hh-hook-out-'))
  dirs.push(hookScratch)
  return hookScratch
}

describe('excluding a selection', () => {
  /**
   * `--all --exclude global:secrets` is the recommended default: everything but the machine's
   * credentials. The archive must genuinely not contain them, not merely list them as skipped.
   */
  it('leaves an excluded secret out of the archive entirely', async () => {
    const fixture = await makeFixture({ globalSecrets: '{ "password": "HASH", "apiToken": "TOKEN" }\n' })
    const created = await fixture.service.create({ exclude: ['global:secrets'] })
    expect(created.ok, created.error).toBe(true)

    const names = (await listZip(path.join(fixture.dataRoot, '.backups', created.file!.name))).map(entry => entry.name)
    expect(names).toContain('global/settings.json')
    expect(names, 'the excluded secret must not be in the archive').not.toContain('global/secrets.json')
  })

  it('excludes the leaves beneath an excluded id', async () => {
    // `global:secrets:password` is under `global:secrets`, and a workspace id covers its servers.
    const fixture = await makeFixture({ globalSecrets: '{ "password": "HASH", "apiToken": "TOKEN" }\n' })
    const created = await fixture.service.create({ exclude: ['global:secrets:password'] })
    expect(created.ok, created.error).toBe(true)

    const { extractZip } = await import('#src/providers/archive')
    const out = path.join(fixture.root, 'unpacked-exclude')
    await extractZip(path.join(fixture.dataRoot, '.backups', created.file!.name), out, { names: ['global/secrets.json'] })
    const archived = JSON.parse(fs.readFileSync(path.join(out, 'global/secrets.json'), 'utf8')) as Record<string, unknown>
    expect(archived.password).toBeUndefined()
    expect(archived.apiToken).toBe('TOKEN')
  })

  /**
   * The plan must describe the archive that will actually be written.
   *
   * Listing `workspace:default:servers` while the apply leaves it out is a plan for a different
   * backup — the person reads it, says yes, and gets something else.
   */
  /**
   * Excluding everything must refuse, not write a manifest-only archive.
   *
   * `--all --exclude <every id>` produced a 631-byte zip holding just the registry: it reads as a
   * backup, restores nothing, and occupies a retention slot.
   */
  it('refuses when the exclusion leaves nothing to capture', async () => {
    const fixture = await makeFixture()
    const result = await fixture.service.create({
      exclude: ['global:settings', 'global:secrets', 'global:tls', 'workspace:default'],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('nothing was selected')
    expect(fixture.service.list()).toEqual([])
  })

  it('leaves an excluded leaf out of the archive and the view agrees', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create({ exclude: ['workspace:default:servers'] })
    expect(created.ok, created.error).toBe(true)

    const names = (await listZip(path.join(fixture.dataRoot, '.backups', created.file!.name))).map(entry => entry.name)
    expect(names).not.toContain('workspaces/default/servers.config.json')
    expect(names, 'its siblings are still captured').toContain('workspaces/default/settings.json')
  })

  it('does not restore an item the exclusion drops', async () => {
    const fixture = await makeFixture({ globalSecrets: '{ "password": "HASH", "apiToken": "TOKEN" }\n' })
    const created = await fixture.service.create({})
    expect(created.ok, created.error).toBe(true)

    // Replace the secret on this host, then restore with the secret excluded: it must survive.
    fs.writeFileSync(fixture.globalSecretsPath, '{ "password": "LOCAL", "apiToken": null }\n', { mode: 0o600 })
    const archive = path.join(fixture.dataRoot, '.backups', created.file!.name)
    const plan = await fixture.service.restore(archive, { confirm: true, exclude: ['global:secrets'] })
    expect(plan.error, plan.error).toBeUndefined()

    expect(fs.readFileSync(fixture.globalSecretsPath, 'utf8'), 'the local secret must be untouched').toContain('LOCAL')
  })
})

describe('a leaf selection keeps its parent in view', () => {
  /**
   * `--include workspace:default:servers` captures that one file, so the plan has to show the entry
   * it lives in. Asking only downwards printed "nothing matched" for a backup that would be taken.
   */
  it('captures the named leaf and not its siblings', async () => {
    const fixture = await makeFixture()
    const created = await fixture.service.create({ include: ['workspace:default:servers'] })
    expect(created.ok, created.error).toBe(true)

    const names = (await listZip(path.join(fixture.dataRoot, '.backups', created.file!.name))).map(entry => entry.name)
    expect(names).toContain('workspaces/default/servers.config.json')
    expect(names, 'a sibling was not named').not.toContain('workspaces/default/settings.json')
  })
})

describe('a dump follows the selection', () => {
  /**
   * An excluded entry's dump must not run.
   *
   * `--exclude workspace:default` still executed that workspace's `dump` program and archived the
   * result — the last copy of the selection rule that ignored `exclude`, and the one with a side
   * effect outside the archive.
   */
  it('does not run the dump of an excluded entry', async () => {
    const marker = path.join(fixtureRootForHooks(), 'dump-ran.txt')
    const fixture = await makeFixture({
      serverFields: {
        dump: {
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
        },
      },
    })

    // Global leaves are still captured, so this succeeds — the point is the hook itself.
    const created = await fixture.service.create({ exclude: ['workspace:default'] })
    expect(created.ok, created.error).toBe(true)
    expect(fs.existsSync(marker), 'an excluded dump must not execute').toBe(false)
  })

  it('does not archive the dump of an excluded entry', async () => {
    const fixture = await makeFixture({
      serverFields: {
        dump: {
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/db.archive", "D")', '{dumpDir}'],
        },
      },
    })

    const created = await fixture.service.create({ exclude: ['workspace:default:dump:app'], include: ['workspace:default:settings'] })
    expect(created.ok, created.error).toBe(true)
    const names = (await listZip(path.join(fixture.dataRoot, '.backups', created.file!.name))).map(entry => entry.name)
    expect(names.some(name => name.startsWith('dumps/')), 'the excluded dump must not be archived').toBe(false)
  })
})

describe('excluding one field of a secret', () => {
  /**
   * The whole-entry item writes the file outright, so it has to merge when a field inside it was
   * excluded — otherwise `--exclude global:secrets:password` replaced the very field it excluded.
   */
  it('keeps the excluded field and restores the rest', async () => {
    const fixture = await makeFixture({ globalSecrets: '{ "password": { "algo": "scrypt", "hash": "ARCHIVE" }, "apiToken": { "algo": "sha256", "hash": "ARCHIVETOK" } }\n' })
    const created = await fixture.service.create({})
    expect(created.ok, created.error).toBe(true)

    fs.writeFileSync(fixture.globalSecretsPath, '{ "password": { "algo": "scrypt", "hash": "LOCAL" }, "apiToken": { "algo": "sha256", "hash": "LOCALTOK" } }\n', { mode: 0o600 })
    const archive = path.join(fixture.dataRoot, '.backups', created.file!.name)
    const plan = await fixture.service.restore(archive, { confirm: true, exclude: ['global:secrets:password'] })
    expect(plan.error, plan.error).toBeUndefined()

    const after = JSON.parse(fs.readFileSync(fixture.globalSecretsPath, 'utf8')) as Record<string, { hash: string }>
    expect(after.password?.hash, 'the excluded field must keep this host value').toBe('LOCAL')
    expect(after.apiToken?.hash, 'the rest is restored').toBe('ARCHIVETOK')
  })
})

describe('backup hooks', () => {
  /**
   * A `dump` hook is what makes a database archive consistent, so a failure must refuse the backup
   * rather than leave an archive that looks complete: the data directory beside a failed dump is the
   * live one, captured while the engine was writing.
   */
  it('refuses the backup when a dump hook fails, and leaves no archive', async () => {
    const fixture = await makeFixture({
      serverFields: { dump: { command: process.execPath, args: ['-e', 'process.exit(4)'] } },
    })

    const created = await fixture.service.create({})
    expect(created.ok).toBe(false)
    expect(created.error).toContain('dump hook')
    expect(fixture.service.list()).toEqual([])
  })

  it('archives what the dump hook wrote', async () => {
    const fixture = await makeFixture({
      serverFields: {
        dump: {
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/db.archive", "FROM-DUMP")', '{dumpDir}'],
        },
      },
    })

    const created = await fixture.service.create({})
    expect(created.ok, created.error).toBe(true)

    const { listZip, extractZip } = await import('#src/providers/archive')
    const archive = path.join(fixture.dataRoot, '.backups', created.file!.name)
    const names = (await listZip(archive)).map(entry => entry.name)
    expect(names).toContain('dumps/default/app/db.archive')

    const out = path.join(fixture.root, 'unpacked')
    await extractZip(archive, out, { names: ['dumps/default/app/db.archive'] })
    expect(fs.readFileSync(path.join(out, 'dumps/default/app/db.archive'), 'utf8')).toBe('FROM-DUMP')
  })

  /**
   * The load is **staged**, not run. `mongorestore` and `pg_restore` connect to a server, and the
   * entry is stopped during a restore — running the hook there fails with "connection refused",
   * which is what the demo caught. The next `start` runs it once the port answers.
   */
  it('stages the load on restore instead of running it against a stopped server', async () => {
    const seen = path.join(fixtureRootForHooks(), 'load-output.txt')
    const fixture = await makeFixture({
      serverFields: {
        dump: {
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/db.archive", "FROM-DUMP")', '{dumpDir}'],
        },
        load: {
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(seen)}, require("node:fs").readFileSync(process.argv[1] + "/db.archive", "utf8"))`, '{dumpDir}'],
        },
      },
    })

    const created = await fixture.service.create({})
    expect(created.ok, created.error).toBe(true)

    const archive = path.join(fixture.dataRoot, '.backups', created.file!.name)
    const plan = await fixture.service.restore(archive, { confirm: true })
    expect(plan.error, plan.error).toBeUndefined()

    // The dump is a plan item, so `--all` reports it and the selection can name it.
    expect(plan.items.map(item => item.id)).toContain('workspace:default:dump:app')
    expect(plan.hooks?.map(hook => `${hook.action}:${hook.serverId}`)).toContain('load:app')
    // Not run: the entry is stopped, so the hook has nothing to talk to yet.
    expect(fs.existsSync(seen), 'the load must not run against a stopped server').toBe(false)
    // The dump is parked where the entry can reach it after a restart.
    expect(plan.hooks?.find(hook => hook.action === 'load')?.output).toContain('staged')
    expect(fs.existsSync(path.join(fixture.dataRoot, 'pending-load', 'default', 'app', 'db.archive'))).toBe(true)
  })
})

describe('staging a load for the entry to run', () => {
  /**
   * The staging call must fire even when the entry does not exist yet.
   *
   * On a blank host the restore creates the workspace, so there is no runtime — and a supervisor with
   * no entry returns silently. That is how the demo restored an empty database and never loaded it,
   * while every test stayed green.
   */
  it('reports a staged load for an entry the restore itself created', async () => {
    const staged: Array<{ workspaceId: string, serverId: string, dumpDir: string }> = []
    const fixture = await makeFixture({
      serverFields: {
        dump: {
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/db.archive", "D")', '{dumpDir}'],
        },
        load: { command: process.execPath, args: ['-e', '0', '{dumpDir}'] },
      },
      onLoadPending: (workspaceId, serverId, dumpDir) => staged.push({ workspaceId, serverId, dumpDir }),
    })

    const created = await fixture.service.create({})
    expect(created.ok, created.error).toBe(true)
    const archive = path.join(fixture.dataRoot, '.backups', created.file!.name)
    const plan = await fixture.service.restore(archive, { confirm: true })
    expect(plan.error, plan.error).toBeUndefined()

    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatchObject({ workspaceId: 'default', serverId: 'app' })
    // The dump is copied to the path the hook will be handed, not left only in the archive.
    expect(fs.existsSync(path.join(staged[0]!.dumpDir, 'db.archive'))).toBe(true)
  })

  /**
   * Deselecting the dump must not load it. Every other item obeys the selection, and a dump is an
   * item — restoring only the settings must not replay a database over the host.
   */
  it('does not stage a dump the selection excluded', async () => {
    const staged: unknown[] = []
    const fixture = await makeFixture({
      serverFields: {
        dump: {
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/db.archive", "D")', '{dumpDir}'],
        },
        load: { command: process.execPath, args: ['-e', '0', '{dumpDir}'] },
      },
      onLoadPending: (...args) => staged.push(args),
    })

    const created = await fixture.service.create({})
    expect(created.ok, created.error).toBe(true)
    const archive = path.join(fixture.dataRoot, '.backups', created.file!.name)
    const plan = await fixture.service.restore(archive, { confirm: true, include: ['global:settings'] })
    expect(plan.error, plan.error).toBeUndefined()
    expect(staged, 'a dump outside the selection must not load').toEqual([])
  })
})

describe('restoring workspaces the host does not have', () => {
  it('creates a workspace the archive names, with its label', async () => {
    const fixture = await makeFixture()
    const archive = path.join(fixture.root, 'multi.zip')
    await makeArchive(archive, {
      registry: { workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }] },
      workspaces: { default: {}, staging: { servers: [{ id: 'app', command: 'node' }] } },
    })

    const ensured: Array<{ id: string, label: string }> = []
    const service = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => fixture.config,
      getSources: () => fixture.sources,
      ensureWorkspace: input => ensured.push(input),
    })

    const plan = await service.restore(archive, { confirm: true })
    expect(plan.error).toBeUndefined()
    expect(plan.items.find(item => item.id === 'workspace:staging:servers')).toMatchObject({ restorable: true })
    // Created after its leaves landed, under the label the archive carried.
    expect(ensured).toEqual([{ id: 'staging', label: 'Staging' }])
    expect(plan.createdWorkspaces).toEqual(['staging'])
    expect(fs.existsSync(path.join(fixture.dataRoot, 'staging', 'servers.config.json'))).toBe(true)
  })

  it('names the workspace by its id when the archive carries no registry', async () => {
    const fixture = await makeFixture()
    const archive = path.join(fixture.root, 'older.zip')
    // An archive written before the registry was captured: still restorable.
    await makeArchive(archive, { workspaces: { staging: { servers: [{ id: 'app', command: 'node' }] } } })

    const ensured: Array<{ id: string, label: string }> = []
    const service = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => fixture.config,
      getSources: () => fixture.sources,
      ensureWorkspace: input => ensured.push(input),
    })

    const plan = await service.restore(archive, { confirm: true })
    expect(plan.error).toBeUndefined()
    expect(ensured).toEqual([{ id: 'staging', label: 'staging' }])
  })

  /**
   * A restore copies a data path over while its owner may be running.
   *
   * The process keeps open handles to files that were just replaced and never learns about it;
   * anything it wrote since the archive was taken is gone. The restore still proceeds — the
   * blank-host case depends on it, and a stopped panel cannot ask anyone — but it must not be
   * silent: the plan names every entry whose data moved under it.
   */
  it('names the running server whose data the restore replaced', async () => {
    const fixture = await makeFixture({ dataPaths: [] })
    const liveDir = path.join(fixture.root, 'data-live')
    fs.mkdirSync(liveDir, { recursive: true })
    fs.writeFileSync(path.join(liveDir, 'db.sqlite'), 'WRITTEN-AFTER-THE-BACKUP\n')

    const servers = [serverConfig({ id: 'app', dataEnvs: { DATA_DIR: liveDir } })]
    const sources: BackupSources = {
      ...fixture.sources,
      workspaces: [{ ...fixture.sources.workspaces[0]!, servers }],
      // The entry is up: this is the case that used to be reported as an ordinary success.
      runningServers: () => [{ workspaceId: 'default', serverId: 'app' }],
    }
    const service = new BackupService({ dataRoot: fixture.dataRoot, getConfig: () => fixture.config, getSources: () => sources })

    const archive = path.join(fixture.root, 'live.zip')
    await makeArchive(archive, {
      workspaces: { default: { servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: liveDir } }] } },
      data: [{ slug: 'live', path: liveDir, origin: 'app:DATA_DIR', workspace: 'default' }],
      files: { 'data/live/db.sqlite': 'ARCHIVED\n' },
    })

    // A dry run already says so, so a person can stop the entry before applying.
    const dryRun = await service.restore(archive, { confirm: false })
    expect(dryRun.replacedUnderRunning).toEqual([{ workspaceId: 'default', serverId: 'app', path: liveDir }])

    const applied = await service.restore(archive, { confirm: true })
    expect(applied.replacedUnderRunning).toEqual([{ workspaceId: 'default', serverId: 'app', path: liveDir }])
    expect(fs.readFileSync(path.join(liveDir, 'db.sqlite'), 'utf8')).toBe('ARCHIVED\n')
  })

  it('reports nothing when the entry is stopped', async () => {
    const fixture = await makeFixture()
    const sources: BackupSources = { ...fixture.sources, runningServers: () => [] }
    const service = new BackupService({ dataRoot: fixture.dataRoot, getConfig: () => fixture.config, getSources: () => sources })

    const created = await service.create()
    const plan = await service.restore(path.join(service.directory, created.file!.name), { confirm: true })
    expect(plan.replacedUnderRunning).toEqual([])
  })

  it('creates nothing on a dry run', async () => {
    const fixture = await makeFixture()
    const archive = path.join(fixture.root, 'multi.zip')
    await makeArchive(archive, {
      registry: { workspaces: [{ id: 'staging', label: 'Staging' }] },
      workspaces: { staging: { servers: [{ id: 'app', command: 'node' }] } },
    })

    const ensured: Array<{ id: string, label: string }> = []
    const service = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => fixture.config,
      getSources: () => fixture.sources,
      ensureWorkspace: input => ensured.push(input),
    })

    const plan = await service.restore(archive, { confirm: false })
    expect(plan.items.find(item => item.id === 'workspace:staging:servers')).toMatchObject({ restorable: true })
    expect(ensured).toEqual([])
    expect(fs.existsSync(path.join(fixture.dataRoot, 'staging'))).toBe(false)
  })

  /**
   * The data-loss half, in its sharpest form: the archive brings data for a workspace
   * whose *config* the person did not select.
   *
   * `staging`'s declaration is then not a destination, and the only declarations left
   * are `default`'s. Matching by origin alone found one anyway and wrote staging's
   * database over default's directory. A workspace the restore is not placing must be
   * reported, never guessed at.
   */
  it('never writes another workspace\'s data when its config is not selected', async () => {
    const fixture = await makeFixture({ dataPaths: [] })
    const defaultDir = path.join(fixture.root, 'data-default')
    const stagingDir = path.join(fixture.root, 'data-staging')
    fs.mkdirSync(defaultDir, { recursive: true })
    fs.mkdirSync(stagingDir, { recursive: true })
    fs.writeFileSync(path.join(defaultDir, 'db.sqlite'), 'DEFAULT-LIVE\n')
    fs.writeFileSync(path.join(stagingDir, 'db.sqlite'), 'STAGING-LIVE\n')

    const sources: BackupSources = {
      ...fixture.sources,
      workspaces: [{
        ...fixture.sources.workspaces[0]!,
        servers: [serverConfig({ id: 'app', dataEnvs: { DATA_DIR: defaultDir } })],
      }],
    }
    const service = new BackupService({ dataRoot: fixture.dataRoot, getConfig: () => fixture.config, getSources: () => sources })

    const archive = path.join(fixture.root, 'multi.zip')
    await makeArchive(archive, {
      registry: { workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }] },
      workspaces: {
        default: { servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: defaultDir } }] },
        staging: { servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: stagingDir } }] },
      },
      data: [
        { slug: 'default-data', path: defaultDir, origin: 'app:DATA_DIR', workspace: 'default' },
        { slug: 'staging-data', path: stagingDir, origin: 'app:DATA_DIR', workspace: 'staging' },
      ],
      files: {
        'data/default-data/db.sqlite': 'DEFAULT-ARCHIVED\n',
        'data/staging-data/db.sqlite': 'STAGING-ARCHIVED\n',
      },
    })

    // Only `default`'s config is applied; staging's declaration never becomes a destination.
    const plan = await service.restore(archive, { confirm: true, include: ['workspace:default:servers', `workspace:default:data:${defaultDir}`] })
    expect(plan.error).toBeUndefined()

    expect(fs.readFileSync(path.join(defaultDir, 'db.sqlite'), 'utf8')).toBe('DEFAULT-ARCHIVED\n')
    // Staging's live data is untouched, and its entry is reported rather than misrouted.
    expect(fs.readFileSync(path.join(stagingDir, 'db.sqlite'), 'utf8')).toBe('STAGING-LIVE\n')
    const stagingItem = plan.items.find(item => item.label === stagingDir || item.label.endsWith('stagingDir'))
    expect(stagingItem?.restorable).not.toBe(true)
  })

  /**
   * The data-loss half. `staging` declares a data directory; `default` declares its own.
   * A restore must write each under *its own* workspace's declaration, never let the
   * un-scoped origin fallback carry one over the other.
   */
  it('never writes one workspace\'s data into another one\'s declared path', async () => {
    const fixture = await makeFixture({ dataPaths: [] })
    const defaultDir = path.join(fixture.root, 'data-default')
    const stagingDir = path.join(fixture.root, 'data-staging')
    fs.mkdirSync(defaultDir, { recursive: true })
    fs.mkdirSync(stagingDir, { recursive: true })
    fs.writeFileSync(path.join(defaultDir, 'db.sqlite'), 'DEFAULT-LIVE\n')
    fs.writeFileSync(path.join(stagingDir, 'db.sqlite'), 'STAGING-LIVE\n')

    // The live host: `default` only, declaring its own directory.
    const sources: BackupSources = {
      ...fixture.sources,
      workspaces: [{
        ...fixture.sources.workspaces[0]!,
        servers: [serverConfig({ id: 'app', dataEnvs: { DATA_DIR: defaultDir } })],
      }],
    }
    const service = new BackupService({ dataRoot: fixture.dataRoot, getConfig: () => fixture.config, getSources: () => sources })

    const archive = path.join(fixture.root, 'multi.zip')
    await makeArchive(archive, {
      registry: { workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }] },
      workspaces: {
        default: { servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: defaultDir } }] },
        staging: { servers: [{ id: 'app', command: 'node', dataEnvs: { DATA_DIR: stagingDir } }] },
      },
      data: [
        { slug: 'default-data', path: defaultDir, origin: 'app:DATA_DIR', workspace: 'default' },
        { slug: 'staging-data', path: stagingDir, origin: 'app:DATA_DIR', workspace: 'staging' },
      ],
      files: {
        'data/default-data/db.sqlite': 'DEFAULT-ARCHIVED\n',
        'data/staging-data/db.sqlite': 'STAGING-ARCHIVED\n',
      },
    })

    const plan = await service.restore(archive, { confirm: true })
    expect(plan.error).toBeUndefined()

    // Each workspace's data landed under its own declaration, as distinct items.
    expect(fs.readFileSync(path.join(defaultDir, 'db.sqlite'), 'utf8')).toBe('DEFAULT-ARCHIVED\n')
    expect(fs.readFileSync(path.join(stagingDir, 'db.sqlite'), 'utf8')).toBe('STAGING-ARCHIVED\n')
    const dataItems = plan.items.filter(item => item.kind === 'data')
    expect(new Set(dataItems.map(item => item.id)).size).toBe(dataItems.length)
  })
})

/**
 * The archive-entry allowlist is the boundary that stops a crafted backup writing outside the
 * layout, and it had no test of its own — only two shapes exercised end-to-end through `restore`.
 *
 * The shapes below are the ones worth pinning: `..` is made of allowed characters, so a regex
 * cannot catch it; backslash is a separator on Windows only, so it must be refused as a character
 * that is simply not allowed; and an archive written on one platform may be restored on another.
 */
describe('archive entry allowlist', () => {
  it('accepts the layout the service itself writes', () => {
    for (const entry of ['global/settings.json', 'workspaces/a/servers.config.json', 'data/file.txt', 'manifest.json', 'global', './global/settings.json', 'global/settings.json/'])
      expect(isSafeArchiveEntry(entry), entry).toBe(true)
  })

  it('refuses anything that could resolve outside the staging directory', () => {
    const bad = [
      '../evil',
      'global/../../evil',
      './../evil',
      '/abs/evil',
      'global/..',
      'global/.',
      'global//evil',
      'notaroot/evil',
      // A raw backslash is not an allowed character. The root must be a real one, or these are
      // refused by the root allowlist instead and the character rule goes untested — which is
      // exactly what a first draft of this list did.
      'global\\evil',
      'global/sub\\..\\..\\evil',
      'data/a\\b',

    ]
    for (const entry of bad) expect(isSafeArchiveEntry(entry), entry).toBe(false)
  })

  it('decides containment the way the platform does', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    // The prefix trap: `/a/bc` is a sibling, not a child.
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

/**
 * The secrets split: each secret is its own selectable slice, and restoring one must
 * leave the secrets beside it untouched. The aggregate ids stay for older clients.
 */
describe('secrets as separate slices', () => {
  const globalSecrets = JSON.stringify({ password: { algo: 'scrypt', hash: 'PW' }, apiToken: { algo: 'sha256', hash: 'TOK' } })
  const workspaceSecrets = JSON.stringify({
    telegram: { botToken: 'TELEGRAM' },
    ddns: { home: { algo: 'aes-256-gcm', iv: 'a', tag: 'b', data: 'c' } },
    ddnsKdf: { algo: 'scrypt', cost: { N: 2, r: 1, p: 1 }, salt: 'c2FsdA==' },
  })

  async function withSecrets() {
    return await makeFixture({ globalSecrets: `${globalSecrets}\n`, workspaceSecrets: `${workspaceSecrets}\n` })
  }

  it('offers one leaf per secret, beside the whole-file leaf', async () => {
    const fixture = await withSecrets()
    const view = fixture.service.view()

    const global = view.entries.find(entry => entry.id === 'global:secrets')!
    expect(global.items.map(item => item.id)).toEqual(['global:secrets:password', 'global:secrets:apiToken'])
    expect(global.items.every(item => item.kind === 'secrets')).toBe(true)
    expect(global.items.map(item => item.secret)).toEqual(['password', 'apiToken'])

    const workspace = view.entries.find(entry => entry.id === 'workspace:default')!
    const ids = workspace.items.map(item => item.id)
    expect(ids).toContain('workspace:default:secrets')
    expect(ids).toContain('workspace:default:secrets:telegram')
    expect(ids).toContain('workspace:default:secrets:ddns')
  })

  it('gives a secret it does not know its own leaf instead of hiding it', async () => {
    const fixture = await withSecrets()
    fs.writeFileSync(fixture.globalSecretsPath, `${JSON.stringify({ password: { hash: 'P' }, webhookSecret: 'FUTURE' })}\n`, { mode: 0o600 })

    const global = fixture.service.view().entries.find(entry => entry.id === 'global:secrets')!
    const unknown = global.items.find(item => item.secret === 'webhookSecret')
    expect(unknown?.id).toBe('global:secrets:webhookSecret')
    // No catalog key exists for it, so it reads as its own name rather than as a raw key.
    expect(unknown?.label).toBe('webhookSecret')
    expect(unknown?.labelKey).toBeUndefined()
  })

  it('captures only the picked secret, and leaves the others out of the archive', async () => {
    const fixture = await withSecrets()
    const result = await fixture.service.create({ include: ['global:secrets:password'] })

    expect(result.ok).toBe(true)
    const archivePath = path.join(fixture.service.directory, result.file!.name)
    const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-unzip-'))
    dirs.push(staging)
    await extractZip(archivePath, staging, { names: ['global/secrets.json'] })

    const archived = JSON.parse(fs.readFileSync(path.join(staging, 'global', 'secrets.json'), 'utf8')) as Record<string, unknown>
    expect(archived.password).toEqual({ algo: 'scrypt', hash: 'PW' })
    // The API token was not picked, so it is not in the archive at all.
    expect(archived).not.toHaveProperty('apiToken')
  })

  it('keeps the DDNS key metadata with the credentials it opens', async () => {
    const fixture = await withSecrets()
    const result = await fixture.service.create({ include: ['workspace:default:secrets:ddns'] })

    const archivePath = path.join(fixture.service.directory, result.file!.name)
    const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-unzip-'))
    dirs.push(staging)
    await extractZip(archivePath, staging, { names: ['workspaces/default/secrets.json'] })

    const archived = JSON.parse(fs.readFileSync(path.join(staging, 'workspaces', 'default', 'secrets.json'), 'utf8')) as Record<string, unknown>
    expect(archived.ddns).toBeDefined()
    // Without the KDF parameters the sealed entries cannot be opened, so they travel together.
    expect(archived.ddnsKdf).toBeDefined()
    expect(archived).not.toHaveProperty('telegram')
  })

  it('restores one secret without disturbing the one beside it', async () => {
    const fixture = await withSecrets()
    const created = await fixture.service.create({ include: ['global:secrets:password'] })
    const archivePath = path.join(fixture.service.directory, created.file!.name)

    // The live file moved on: a token exists that the archive never carried.
    fs.writeFileSync(fixture.globalSecretsPath, `${JSON.stringify({ apiToken: { algo: 'sha256', hash: 'LIVE' } })}\n`, { mode: 0o600 })

    const applied = await fixture.service.restore(archivePath, { confirm: true, include: ['global:secrets:password'] })
    expect(applied.dryRun).toBe(false)
    const after = JSON.parse(fs.readFileSync(fixture.globalSecretsPath, 'utf8')) as Record<string, unknown>
    expect(after.password).toEqual({ algo: 'scrypt', hash: 'PW' })
    // Restoring the password must not have wiped the token the panel is still using.
    expect(after.apiToken).toEqual({ algo: 'sha256', hash: 'LIVE' })
    if (process.platform !== 'win32')
      expect(fs.statSync(fixture.globalSecretsPath).mode & 0o777).toBe(0o600)
  })

  it('restores the Telegram token without touching the DDNS credentials', async () => {
    const fixture = await withSecrets()
    const created = await fixture.service.create({ include: ['workspace:default:secrets:telegram'] })
    const archivePath = path.join(fixture.service.directory, created.file!.name)

    const plan = await fixture.service.restore(archivePath, { confirm: false })
    expect(plan.items.map(item => item.id)).toContain('workspace:default:secrets:telegram')

    const applied = await fixture.service.restore(archivePath, { confirm: true, include: ['workspace:default:secrets:telegram'] })
    expect(applied.appliedIds).toContain('workspace:default:secrets:telegram')
    const after = JSON.parse(fs.readFileSync(fixture.workspaceSecretsPath, 'utf8')) as Record<string, unknown>
    expect(after.telegram).toEqual({ botToken: 'TELEGRAM' })
    // The credentials the archive did not carry are still there, sealed and openable.
    expect(after.ddns).toBeDefined()
    expect(after.ddnsKdf).toBeDefined()
  })

  it('still captures and restores the whole file when the aggregate id is named', async () => {
    const fixture = await withSecrets()
    const created = await fixture.service.create({ include: ['global:secrets'] })
    const archivePath = path.join(fixture.service.directory, created.file!.name)

    fs.writeFileSync(fixture.globalSecretsPath, '{}\n', { mode: 0o600 })
    await fixture.service.restore(archivePath, { confirm: true, include: ['global:secrets'] })

    const after = JSON.parse(fs.readFileSync(fixture.globalSecretsPath, 'utf8')) as Record<string, unknown>
    expect(after.password).toBeDefined()
    expect(after.apiToken).toBeDefined()
  })

  it('reports where the archive came from, and refuses a newer schema', async () => {
    const fixture = await withSecrets()
    const created = await fixture.service.create()
    const archivePath = path.join(fixture.service.directory, created.file!.name)

    const plan = await fixture.service.restore(archivePath, { confirm: false })
    expect(plan.archive?.writtenBy).toBe(appVersion())
    expect(plan.archive?.schema).toBe(CONFIG_SCHEMA)

    // An archive from a release this one cannot read is refused outright, rather than
    // restoring the parts it happens to understand and reporting a partial success.
    const future = path.join(fixture.service.directory, 'future.zip')
    const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-up-'))
    dirs.push(staging)
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      hostname: 'elsewhere',
      writtenBy: '99.0.0',
      schema: CONFIG_SCHEMA + 1,
      data: [],
    })}\n`)
    await createZipFile(staging, future)

    const refused = await fixture.service.restore(future, { confirm: false })
    expect(refused.error).toContain('config schema')
    expect(refused.applied).toHaveLength(0)
  })
})

/**
 * The schedule, and the two retention budgets it must not confuse.
 *
 * `keep` is what a person agreed to store by hand; `schedule.keep` is what the panel keeps on
 * its own. Pruning them against one number would lose a hand-taken archive to make room for a
 * scheduled one — the copy someone deliberately made is the one that matters least to replace.
 */
describe('the backup schedule', () => {
  it('writes nothing until it is due, and one archive when it is', async () => {
    const fixture = await makeFixture({ schedule: { intervalMs: 60_000, keep: 7 } })
    const now = Date.now()

    fixture.service.tick(now)
    // The pass runs in the background; give it a turn to finish before asserting.
    await vi.waitFor(() => expect(fixture.service.list()).toHaveLength(1), { timeout: 15_000 })
    expect(fixture.service.list()[0]!.name.startsWith('auto-'), 'a scheduled archive is marked as one').toBe(true)

    // Not due: the newest automatic archive is younger than the interval.
    fixture.service.tick(now + 30_000)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fixture.service.list()).toHaveLength(1)

    // Due: past the interval, so a second pass runs.
    fixture.service.tick(now + 61_000)
    await vi.waitFor(() => expect(fixture.service.list()).toHaveLength(2), { timeout: 15_000 })
  })

  it('stays off at intervalMs 0, and while backups are disabled', async () => {
    const off = await makeFixture({ schedule: { intervalMs: 0, keep: 7 } })
    off.service.tick(Date.now())
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(off.service.list(), 'the schema default is off').toHaveLength(0)

    const disabled = await makeFixture({ enabled: false, schedule: { intervalMs: 60_000, keep: 7 } })
    disabled.service.tick(Date.now())
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(disabled.service.list(), 'a disabled service archives nothing').toHaveLength(0)
  })

  it('prunes automatic archives by schedule.keep, and leaves the manual ones alone', async () => {
    const fixture = await makeFixture({ keep: 1, schedule: { intervalMs: 60_000, keep: 2 } })
    const dir = fixture.service.directory
    fs.mkdirSync(dir, { recursive: true })

    // Four automatic and two manual archives, oldest first by name, written directly so the
    // test does not depend on how long a real archive takes.
    const stamp = (index: number): string => `2026-01-0${index + 1}T00-00-00-000`
    for (let index = 0; index < 4; index += 1)
      fs.writeFileSync(path.join(dir, `auto-${stamp(index)}.zip`), 'auto')
    for (let index = 0; index < 2; index += 1)
      fs.writeFileSync(path.join(dir, `backup-${stamp(index)}.zip`), 'manual')

    // A real pass runs the prune; `create` is what calls it.
    const created = await fixture.service.create({ automatic: true })
    expect(created.ok).toBe(true)

    const remaining = fixture.service.list().map(file => file.name)
    const automatic = remaining.filter(name => name.startsWith('auto-'))
    const manual = remaining.filter(name => name.startsWith('backup-'))

    // 5 automatic were written (4 fixtures + the pass), so `schedule.keep: 2` leaves 2 — and
    // `keep: 1` independently leaves 1 manual. The point is that each budget bounds only its own
    // kind: a single shared `keep` would have left 1 archive in total.
    expect(automatic, 'schedule.keep bounds the scheduled archives').toHaveLength(2)
    expect(manual, 'keep bounds the manual archives').toHaveLength(1)
    expect(remaining, 'the two budgets are counted apart').toHaveLength(3)
  })

  /**
   * A pass that writes nothing must still start the clock.
   *
   * The newest archive is the durable record across a restart, but a *failed* pass leaves no
   * archive — so without an attempt timestamp every panel tick (once a second) would retry the
   * same failing archive for as long as the failure lasts.
   */
  it('does not retry a failed pass on every tick', async () => {
    const fixture = await makeFixture({ schedule: { intervalMs: 60_000, keep: 7 } })
    const now = Date.now()

    // Make the pass fail by pointing the archive directory at a path a file already occupies.
    const blocker = path.join(fixture.root, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const failing = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => ({ ...fixture.config, dir: blocker }),
      getSources: () => fixture.sources,
    })
    const attempts: string[] = []
    const original = failing.create.bind(failing)
    // Count the attempts rather than the archives: a failed pass writes none.
    failing.create = async (options = {}) => {
      attempts.push(options.automatic === true ? 'auto' : 'manual')
      return original(options)
    }

    failing.tick(now)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(attempts, 'the first tick tries').toHaveLength(1)

    // Many ticks inside the interval: no further attempt.
    for (let step = 1; step <= 5; step += 1)
      failing.tick(now + step * 1000)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(attempts, 'a failed pass is not retried every second').toHaveLength(1)

    // Past the interval, it tries again — the schedule is not disabled by one failure.
    failing.tick(now + 61_000)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(attempts).toHaveLength(2)
  })

  /**
   * A failing schedule has to be visible on the page, not only in the console.
   *
   * "Enabled, zero archives" looked identical to "failing every interval for a week": the failure
   * wrote a `logger.warn` and nothing else, and `lastAutomaticAt` never advances on a failed pass.
   */
  it('reports why the last scheduled pass failed, and clears it when one works', async () => {
    const fixture = await makeFixture({ schedule: { intervalMs: 60_000, keep: 7 } })
    const blocker = path.join(fixture.root, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const failing = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => ({ ...fixture.config, dir: blocker }),
      getSources: () => fixture.sources,
    })

    expect(failing.view().scheduleError, 'nothing has run yet').toBeUndefined()

    failing.tick(Date.now())
    await new Promise(resolve => setTimeout(resolve, 400))

    const failed = failing.view().scheduleError
    expect(failed, 'a failed pass must be readable from the view').toBeDefined()
    expect(failed!.message.length).toBeGreaterThan(0)
    expect(failed!.at).toBeGreaterThan(0)

    // A pass that works clears it, so a stale error does not outlive the problem.
    const working = new BackupService({
      dataRoot: fixture.dataRoot,
      getConfig: () => fixture.config,
      getSources: () => fixture.sources,
    })
    working.tick(Date.now())
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(working.view().scheduleError).toBeUndefined()
  })

  it('exposes the schedule and the last automatic time to the page', async () => {
    const fixture = await makeFixture({ schedule: { intervalMs: 3_600_000, keep: 3 } })
    expect(fixture.service.view().schedule).toEqual({ intervalMs: 3_600_000, keep: 3 })
    expect(fixture.service.view().lastAutomaticAt, 'nothing has run yet').toBeNull()

    await fixture.service.create({ automatic: true })
    const after = fixture.service.view()
    expect(after.lastAutomaticAt).not.toBeNull()
    // The manual one that a person takes is not what "last automatic" reports.
    await fixture.service.create()
    expect(fixture.service.view().lastAutomaticAt).toBe(after.lastAutomaticAt)
  })
})
