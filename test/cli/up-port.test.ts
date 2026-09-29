import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `up --port` / `-p` move the listener. The port is also persisted for the next
 * boot, but the running server must bind what the command asked for — building it
 * from the file on disk instead would silently ignore the flag, which is exactly
 * the regression this pins.
 *
 * Ports come from the 6xxx range: the suite must not depend on the shipped 3999
 * default being free while a dev or installed panel may hold it.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const homes: string[] = []
const children: ReturnType<typeof spawn>[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL')
    }
    catch {
      // already gone
    }
  }
  await Promise.all(homes.splice(0).map(home => fs.promises.rm(home, { recursive: true, force: true })))
})

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-up-port-'))
  homes.push(home)
  return home
}

function freeDevPort(from = 6200, to = 6299): Promise<number> {
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

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok)
        return true
    }
    catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

function startPanel(home: string, args: string[]): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: root,
    env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
  })
  children.push(child)
  return child
}

function persistedPort(home: string): number {
  const file = path.join(home, '.hh', 'settings.json')
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { control: { port: number } }).control.port
}

describe('`up` binds the port it is given', () => {
  it('serves on --port, not on the port already in the file', async () => {
    const home = makeHome()
    const port = await freeDevPort()
    startPanel(home, ['up', '--foreground', '--no-autostart', '--port', String(port)])

    expect(await waitForHealth(`http://127.0.0.1:${port}/healthz`, 20000)).toBe(true)
    expect(persistedPort(home)).toBe(port)
  }, 30000)

  it('accepts the `-p` shorthand for the same thing', async () => {
    const home = makeHome()
    const port = await freeDevPort()
    startPanel(home, ['-p', String(port), '--foreground', '--no-autostart'])

    expect(await waitForHealth(`http://127.0.0.1:${port}/healthz`, 20000)).toBe(true)
    expect(persistedPort(home)).toBe(port)
  }, 30000)
})
