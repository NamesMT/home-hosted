import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOfflineBackup } from '#src/cli/backup-offline'

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

    const view = service.view()
    const ids = view.entries.map(entry => entry.id)
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
