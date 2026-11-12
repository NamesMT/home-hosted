import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDefaultWorkspaceId, slugifyWorkspaceId, WorkspaceError, WorkspaceRegistry } from '#src/config/workspaces'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function tempFile(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-workspaces-'))
  dirs.push(dir)
  return path.join(dir, 'workspaces.json')
}

function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
}

async function loaded(contents?: unknown): Promise<{ registry: WorkspaceRegistry, file: string }> {
  const file = await tempFile()
  if (contents !== undefined)
    await fs.promises.writeFile(file, JSON.stringify(contents, null, 2))
  const registry = new WorkspaceRegistry(file)
  registry.load()
  return { registry, file }
}

describe('workspace registry', () => {
  it('seeds the `default` workspace when the registry does not exist', async () => {
    const { registry, file } = await loaded()

    expect(registry.configError).toBeNull()
    expect(registry.all()).toEqual([{ id: 'default', label: 'Default' }])
    expect(registry.has('default')).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
    expect(read(file).workspaces).toEqual([{ id: 'default', label: 'Default' }])
  })

  it('reads the workspaces it lists, in order', async () => {
    const { registry } = await loaded({ workspaces: [{ id: 'alpha', label: 'Alpha' }, { id: 'default', label: 'Default' }] })

    expect(registry.all().map(workspace => workspace.id)).toEqual(['alpha', 'default'])
    // `default` is preferred as the fallback even when it is not first.
    expect(registry.defaultId).toBe('default')
  })

  it('falls back to the first workspace when there is no `default`', async () => {
    const { registry } = await loaded({ workspaces: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }] })
    expect(registry.defaultId).toBe('alpha')
  })

  /**
   * The same rule, for a caller that has a registry file and no panel.
   *
   * `logs` and `status` name a workspace when none was given, and both read the registry directly
   * because they must work with no panel running. They had re-derived it as the literal
   * `DEFAULT_WORKSPACE_ID`, so on a host declaring `["media"]` they named `.hh/default/.logs`,
   * while the panel resolved the same omission to `media`. `readDefaultWorkspaceId` is the one
   * answer; the fallbacks below are what keeps a diagnostic command working over a broken registry
   * the panel itself would refuse to start on.
   */
  it('answers the same way from a registry file as from the loaded registry', async () => {
    const { file } = await loaded({ workspaces: [{ id: 'media', label: 'Media' }] })
    expect(readDefaultWorkspaceId(file)).toBe('media')

    const withDefault = await loaded({ workspaces: [{ id: 'alpha', label: 'Alpha' }, { id: 'default', label: 'Default' }] })
    expect(readDefaultWorkspaceId(withDefault.file)).toBe('default')
  })

  it('falls back to `default` for a registry it cannot read', async () => {
    const missing = path.join(os.tmpdir(), 'hh-workspaces-missing', 'workspaces.json')
    expect(readDefaultWorkspaceId(missing)).toBe('default')

    const broken = await tempFile()
    await fs.promises.writeFile(broken, '{ not json')
    expect(readDefaultWorkspaceId(broken)).toBe('default')

    // An empty registry is refused at startup; a read of one log must not fail over it.
    const empty = await tempFile()
    await fs.promises.writeFile(empty, JSON.stringify({ workspaces: [] }))
    expect(readDefaultWorkspaceId(empty)).toBe('default')
  })

  it('creates a workspace, deriving the id from the label', async () => {
    const { registry, file } = await loaded()

    const created = registry.create({ label: 'My Second Project' })

    expect(created).toEqual({ id: 'my-second-project', label: 'My Second Project' })
    expect(registry.all().map(workspace => workspace.id)).toEqual(['default', 'my-second-project'])
    expect(read(file).workspaces).toHaveLength(2)
    expect(read(file).meta.schema).toBe(1)
  })

  it('creates a workspace with an explicit id and label', async () => {
    const { registry } = await loaded()
    expect(registry.create({ id: 'work', label: 'Work' })).toEqual({ id: 'work', label: 'Work' })
  })

  it('refuses a duplicate id', async () => {
    const { registry } = await loaded()
    expect(() => registry.create({ id: 'default', label: 'Again' })).toThrow(WorkspaceError)
    // The refused create must not have changed anything.
    expect(registry.all()).toEqual([{ id: 'default', label: 'Default' }])
  })

  it('refuses an id that is not a directory-safe slug', async () => {
    const { registry } = await loaded()
    expect(() => registry.create({ id: 'Not Safe!', label: 'x' })).toThrow(WorkspaceError)
    expect(() => registry.create({ id: 'Upper', label: 'x' })).toThrow(WorkspaceError)
    expect(() => registry.create({ id: '-leading', label: 'x' })).toThrow(WorkspaceError)
    expect(() => registry.create({ id: 'a'.repeat(41), label: 'x' })).toThrow(/at most 40/)
    for (const reserved of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9'])
      expect(() => registry.create({ id: reserved, label: 'x' })).toThrow(/Windows device name/)
    expect(registry.create({ id: 'a'.repeat(40), label: 'x' }).id).toHaveLength(40)
    expect(registry.create({ id: 'console', label: 'x' }).id).toBe('console')
  })

  it('still reads a registry an older release wrote with a longer id', async () => {
    const { registry } = await loaded({ workspaces: [{ id: 'a'.repeat(60), label: 'Long' }, { id: 'con', label: 'Con' }] })
    expect(registry.configError).toBeNull()
    expect(registry.all()).toHaveLength(2)
  })

  it('renames a workspace without changing its id', async () => {
    const { registry } = await loaded()
    expect(registry.rename('default', '  Renamed  ')).toEqual({ id: 'default', label: 'Renamed' })
    expect(registry.get('default')?.label).toBe('Renamed')
    expect(registry.all()).toHaveLength(1)
  })

  it('refuses to rename an unknown workspace, or to an empty label', async () => {
    const { registry } = await loaded()
    expect(() => registry.rename('ghost', 'Ghost')).toThrow(WorkspaceError)
    expect(() => registry.rename('default', '   ')).toThrow(WorkspaceError)
  })

  it('removes a workspace, and refuses to remove the last one', async () => {
    const { registry } = await loaded()
    registry.create({ id: 'second', label: 'Second' })

    expect(registry.remove('second')).toEqual({ id: 'second', label: 'Second' })
    expect(registry.all().map(workspace => workspace.id)).toEqual(['default'])

    // At least one workspace always exists.
    expect(() => registry.remove('default')).toThrow(WorkspaceError)
    expect(registry.all()).toHaveLength(1)
    expect(() => registry.remove('ghost')).toThrow(WorkspaceError)
  })

  it('tells its listeners about a change', async () => {
    const { registry } = await loaded()
    let notified = 0
    const stop = registry.onChange(() => notified++)

    registry.create({ label: 'One' })
    expect(notified).toBe(1)
    stop()
    registry.create({ label: 'Two' })
    expect(notified).toBe(1)
  })

  it('refuses a registry that declares no workspace', async () => {
    const { registry } = await loaded({ workspaces: [] })
    expect(registry.configError).toContain('at least one')
    expect(registry.all()).toEqual([])
  })

  it('refuses a registry it cannot parse or validate', async () => {
    const bad = await loaded({ workspaces: [{ id: 'Not Safe!', label: 'x' }] })
    expect(bad.registry.configError).not.toBeNull()

    const file = await tempFile()
    await fs.promises.writeFile(file, '{ nope')
    const broken = new WorkspaceRegistry(file)
    broken.load()
    expect(broken.configError).toContain('cannot read')
  })
})

describe('slugifyWorkspaceId', () => {
  it('lowercases and joins words, dropping punctuation', () => {
    expect(slugifyWorkspaceId('My Project AB!')).toBe('my-project-ab')
    expect(slugifyWorkspaceId('  spaces  everywhere  ')).toBe('spaces-everywhere')
    expect(slugifyWorkspaceId('already-slug_ok')).toBe('already-slug-ok')
  })

  it('never returns an empty id', () => {
    expect(slugifyWorkspaceId('')).toBe('workspace')
    expect(slugifyWorkspaceId('!!!')).toBe('workspace')
  })

  it('suffixes an id that is already taken', () => {
    expect(slugifyWorkspaceId('home', ['home'])).toBe('home-2')
    expect(slugifyWorkspaceId('home', ['home', 'home-2'])).toBe('home-3')
  })

  it('caps the id at 40 characters, suffix included', () => {
    expect(slugifyWorkspaceId('a'.repeat(80))).toBe('a'.repeat(40))
    expect(slugifyWorkspaceId('a'.repeat(80), ['a'.repeat(40)])).toBe(`${'a'.repeat(38)}-2`)
  })

  it('never derives a Windows device name', () => {
    expect(slugifyWorkspaceId('NUL')).toBe('nul-2')
    expect(slugifyWorkspaceId('Com1')).toBe('com1-2')
  })
})
