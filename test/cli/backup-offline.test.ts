import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOfflineBackup } from '#src/cli/backup-offline'
import { entryStatePath, readEntryState } from '#src/providers/entry-state'
import { runCli } from '../support/run-cli'

/**
 * `backup` used to need the panel, because the service is built inside the daemon — so backing up
 * or restoring meant leaving it running, which is the opposite of what someone migrating a machine
 * wants. Every source is a file, so the offline path reads the same ones the panel does.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/** A minimal home: global settings, a registry with one workspace, and that workspace's servers. */
function makeHome(servers: Record<string, unknown>[] = [{ id: 'db', command: 'node' }]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-offline-'))
  dirs.push(home)
  const hh = path.join(home, '.hh')
  fs.mkdirSync(path.join(hh, 'default'), { recursive: true })
  fs.writeFileSync(path.join(hh, 'settings.json'), '{"control":{}}\n')
  fs.writeFileSync(path.join(hh, 'workspaces.json'), `${JSON.stringify({ workspaces: [{ id: 'default', label: 'default' }] })}\n`)
  fs.writeFileSync(path.join(hh, 'default', 'settings.json'), '{}\n')
  fs.writeFileSync(path.join(hh, 'default', 'servers.config.json'), `${JSON.stringify({ meta: { writtenBy: 'test', schema: 2 }, servers })}\n`)
  return home
}

describe('the offline backup service', () => {
  it('builds sources from the files, with no panel', async () => {
    const home = makeHome()
    const { service } = createOfflineBackup({ hhDir: path.join(home, '.hh'), settingsPath: path.join(home, '.hh', 'settings.json') })
    await service.warm()

    const ids = service.selection().entries.map(entry => entry.id)
    expect(ids).toContain('global:settings')
    // The workspace and its leaves come from the registry on disk, not from a runtime.
    expect(ids).toContain('workspace:default')
  })

  it('creates an archive and reads it back without a panel', async () => {
    const home = makeHome()
    const hh = path.join(home, '.hh')
    const data = path.join(home, 'data')
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, 'f.txt'), 'hello')
    fs.writeFileSync(path.join(hh, 'default', 'servers.config.json'), `${JSON.stringify({ meta: { writtenBy: 'test', schema: 2 }, servers: [{ id: 'db', command: 'node', backupPaths: [data] }] })}\n`)

    const { service } = createOfflineBackup({ hhDir: hh, settingsPath: path.join(hh, 'settings.json') })
    await service.warm()
    const created = await service.create({})
    expect(created.ok, created.error).toBe(true)

    const listing = service.list()
    expect(listing.map(file => file.name)).toContain(created.file!.name)
  })

  /**
   * The archive's **contents**, not just that a file appeared.
   *
   * Nothing asserted this, which is how an offline archive came to carry an empty `servers.config.json`:
   * the data was captured while the entry declaring it was not, and a restore would have written data
   * nobody owns.
   */
  it('archives the workspace config the panel would read, byte for byte', async () => {
    const home = makeHome([{ id: 'web', command: 'node', port: 8080 }])
    const hh = path.join(home, '.hh')
    const { service } = createOfflineBackup({ hhDir: hh, settingsPath: path.join(hh, 'settings.json') })
    await service.warm()

    const created = await service.create({})
    expect(created.ok, created.error).toBe(true)

    // Read the archive back with the same tool the service uses.
    const { listZip, extractZip } = await import('#src/providers/archive')
    const archive = path.join(hh, '.backups', created.file!.name)
    expect((await listZip(archive)).map(entry => entry.name)).toContain('workspaces/default/servers.config.json')

    const out = path.join(home, 'unpacked')
    await extractZip(archive, out, { names: ['workspaces/default/servers.config.json'] })
    const archived = JSON.parse(fs.readFileSync(path.join(out, 'workspaces/default/servers.config.json'), 'utf8')) as { servers?: Array<{ id: string }> }
    expect(archived.servers?.map(server => server.id), 'the entry must be in the archive, not just its data').toEqual(['web'])
  })

  /**
   * The staged load must be written where the supervisor reads it, with fields it accepts.
   *
   * Two spellings of one thing broke this twice: `<id>.json` vs `<id>.run.json`, and a hand-rolled
   * object missing `restarts`/`bootstrapDone`, which `readEntryState` rejects **silently** — so the
   * dump was staged and then never loaded.
   */
  it('writes the staged load where the supervisor will find it', async () => {
    const home = makeHome()
    const hh = path.join(home, '.hh')
    // A dump hook is what produces an archive with something to load; without one there is nothing
    // to stage and the assertion below would pass for the wrong reason.
    fs.writeFileSync(path.join(hh, 'default', 'servers.config.json'), `${JSON.stringify({
      meta: { writtenBy: 'test', schema: 2 },
      servers: [{
        id: 'db',
        command: 'node',
        dump: { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1] + "/db.archive", "D")', '{dumpDir}'] },
        load: { command: 'node', args: ['-e', '0'] },
      }],
    })}\n`)

    const { service } = createOfflineBackup({ hhDir: hh, settingsPath: path.join(hh, 'settings.json') })
    await service.warm()
    await service.create({})
    const archive = path.join(hh, '.backups', service.list()[0]!.name)
    const plan = await service.restore(archive, { confirm: true })
    expect(plan.error, plan.error).toBeUndefined()

    // The exact path the supervisor uses, and a file `readEntryState` accepts.
    const stateFile = entryStatePath(path.join(hh, 'default', '.state'), 'db')
    expect(fs.existsSync(stateFile), `expected ${stateFile}`).toBe(true)
    const state = readEntryState(stateFile)
    expect(state, 'readEntryState must accept what we wrote').not.toBeNull()
    expect(state?.pendingLoad).toContain('pending-load')
    // `false`, not `true`: claiming the bootstrap already ran skipped a blank host's install step.
    expect(state?.bootstrapDone, 'a staged load must not claim the bootstrap ran').toBe(false)
  })

  it('reports a persistent entry that is still running, from its state file', async () => {
    const home = makeHome()
    const hh = path.join(home, '.hh')
    const stateDir = path.join(hh, 'default', '.state')
    fs.mkdirSync(stateDir, { recursive: true })
    // A nanny that is alive (this process) with a fresh heartbeat, exactly as a persistent entry
    // leaves it — the panel is down, but that entry is not.
    fs.writeFileSync(path.join(stateDir, 'gitea.json'), `${JSON.stringify({
      serverId: 'gitea',
      nannyPid: process.pid,
      childPid: null,
      startedAt: Date.now() - 60_000,
      logFile: path.join(hh, 'default', '.logs', 'gitea.log'),
      heartbeatAt: Date.now(),
    })}\n`)

    const { runningNow } = createOfflineBackup({ hhDir: hh, settingsPath: path.join(hh, 'settings.json') })
    expect(runningNow().map(entry => entry.serverId)).toContain('gitea')
  })
})

/**
 * Looking is not writing. `backup list` on a fresh home created `settings.json`, `workspaces.json`
 * and the default workspace's two files, because every store seeds a missing file on `load()` — so a
 * read-only command left a home that `status` then reported as initialised.
 */
describe('the offline backup service on a fresh home', () => {
  it('reads a missing config as the seed without creating any file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-offline-fresh-'))
    dirs.push(home)
    const hh = path.join(home, '.hh')
    const { service } = createOfflineBackup({ hhDir: hh, settingsPath: path.join(hh, 'settings.json') })
    await service.warm()

    expect(service.selection().entries.length).toBeGreaterThan(0)
    expect(fs.existsSync(hh), 'nothing under .hh may be created by a read').toBe(false)
  })
})

/**
 * `backup list` prints the archive's time in the **host's** zone, in the panel's one spelling.
 *
 * The archive *name* is UTC — it is the retention key and `archiveStamp` parses it back — but the
 * column beside it was rendered from `toISOString()` too, so an archive taken at 10:11 +07 printed
 * `03:11`. It now uses the shared `formatDateTimeIso`, the same `YYYY-MM-DD HH:MM:SS` the UIs and every
 * other CLI surface print, so a log line and a row on screen agree character for character.
 */
describe('the backup list column', () => {
  it('renders the archive time in the host zone, as the panel spells a date', async () => {
    const home = makeHome()
    const hh = path.join(home, '.hh')
    fs.mkdirSync(path.join(hh, '.backups'), { recursive: true })
    // A real archive name: the stamp is UTC, and its `.zip` must satisfy ARCHIVE_NAME for the list to
    // show it at all. `03:11:43.654Z` is 10:11:43 +07:00, the case the audit measured.
    fs.writeFileSync(path.join(hh, '.backups', 'backup-2026-11-17-03-11-43-654.zip'), 'x')

    const listed = runCli(['backup', 'list'], { home })
    expect(listed.status, listed.stderr).toBe(0)

    const line = listed.stdout.split('\n').find(text => text.includes('backup-2026-11-17-03-11-43-654'))!
    expect(line).toBeDefined()
    const expected = (() => {
      const date = new Date(Date.UTC(2026, 10, 17, 3, 11, 43, 654))
      const pad = (value: number): string => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    })()
    expect(line, 'the column follows the host zone, in ISO').toContain(expected)
    // And it is not the UTC reading of the same instant, which is the bug this replaced — skipped on a
    // machine whose zone *is* UTC, where the two spellings are legitimately identical.
    if (new Date().getTimezoneOffset() !== 0)
      expect(line).not.toContain('03:11:43')
  })
})
