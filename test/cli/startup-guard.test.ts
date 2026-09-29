import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

/**
 * `up` refuses to start — exit 1, the exact problem printed — when any file this
 * release cannot read is on disk, global or per workspace. A panel that starts
 * anyway would either drop every server in that workspace (which looks like they
 * were removed) or run with defaults it did not ask for.
 *
 * The guard runs before the listener binds and before `run.json` is written, so
 * these tests assert both: the exit and the absence of the daemon's identity file.
 *
 * Every case seeds a free 6xxx control port. The port preflight runs before the
 * config guard, so relying on the shipped 3999 default would make these tests fail
 * whenever a dev or installed panel already holds it — for the wrong reason.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => fs.promises.rm(home, { recursive: true, force: true })))
})

afterAll(() => {
  // Nothing global to restore: every case gets its own HHOSTED_HOME.
})

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-startup-'))
  homes.push(home)
  return home
}

/** Writes a workspace directory a broken file can be dropped into. */
function seedWorkspace(home: string, id = 'default'): { workspace: string, hh: string } {
  const hh = path.join(home, '.hh')
  const workspace = path.join(hh, id)
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(hh, 'workspaces.json'), JSON.stringify({
    $schema: './workspaces.schema.json',
    workspaces: [{ id, label: id }],
  }, null, 2))
  return { workspace, hh }
}

/** A free port in the dev range, so a panel on 3999 (installed or dev) cannot interfere. */
function freeDevPort(from = 6100, to = 6199): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number): void => {
      if (port > to) {
        reject(new Error(`no free port in ${from}-${to}`))
        return
      }
      const probe = net.createServer()
      probe.once('error', () => attempt(port + 1))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)))
    }
    attempt(from)
  })
}

/** Gives the home a control port of its own unless the case wrote its own settings. */
async function seedControlPort(home: string): Promise<void> {
  const file = path.join(home, '.hh', 'settings.json')
  if (fs.existsSync(file))
    return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({
    meta: { writtenBy: 'test', schema: 1 },
    control: { port: await freeDevPort() },
  }, null, 2)}\n`)
}

/**
 * Runs `up --foreground` and resolves what it printed. The guard must exit on its
 * own; if it does not, the child would stay alive as a panel, so the timeout kills
 * it and the case fails on the missing output rather than hanging the suite.
 */
async function runUp(home: string, timeoutMs = 6000): Promise<{ status: number | null, stdout: string, stderr: string }> {
  await seedControlPort(home)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'up', '--foreground', '--no-autostart'], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (status: number | null): void => {
      if (settled)
        return
      settled = true
      if (timer !== undefined)
        clearTimeout(timer)
      resolve({ status, stdout, stderr })
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, timeoutMs)
    child.once('close', status => finish(status))
  })
}

describe('startup guard: an unreadable file stops `up`', () => {
  it('refuses a workspace whose servers config is not valid json', async () => {
    const home = makeHome()
    const { workspace } = seedWorkspace(home)
    fs.writeFileSync(path.join(workspace, 'servers.config.json'), '{ nope')

    const result = await runUp(home)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to start')
    expect(result.stderr).toContain('workspace "default"')
    expect(result.stderr).toContain('cannot parse')
    // Nothing bound and no daemon identity written before the refusal.
    expect(fs.existsSync(path.join(home, '.hh', 'run.json'))).toBe(false)
  })

  it('refuses a workspace with a duplicate server id', async () => {
    const home = makeHome()
    const { workspace } = seedWorkspace(home)
    fs.writeFileSync(path.join(workspace, 'servers.config.json'), JSON.stringify({
      servers: [{ id: 'dup', command: 'node' }, { id: 'dup', command: 'node' }],
    }, null, 2))

    const result = await runUp(home)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('duplicate id')
    expect(fs.existsSync(path.join(home, '.hh', 'run.json'))).toBe(false)
  })

  it('refuses a workspace settings file from a newer release', async () => {
    const home = makeHome()
    const { workspace } = seedWorkspace(home)
    fs.writeFileSync(path.join(workspace, 'settings.json'), JSON.stringify({
      meta: { writtenBy: '9.9.9', schema: 99 },
      defaults: {},
    }, null, 2))
    fs.writeFileSync(path.join(workspace, 'servers.config.json'), JSON.stringify({ servers: [] }, null, 2))

    const result = await runUp(home)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to start')
    expect(result.stderr).toContain('workspace "default"')
    expect(result.stderr).toContain('schema 99')
    expect(fs.existsSync(path.join(home, '.hh', 'run.json'))).toBe(false)
  })

  it('refuses an unreadable global settings file', async () => {
    const home = makeHome()
    fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'settings.json'), '{ nope')

    const result = await runUp(home)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to start')
    expect(fs.existsSync(path.join(home, '.hh', 'run.json'))).toBe(false)
  })
})
