import type net from 'node:net'
import type { Runtime } from '#src/helpers/daemon'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { type } from 'arktype'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

/**
 * `run.json` is the daemon's identity and `down`'s credential. The probe deliberately
 * talks http/https by hand so a self-signed TLS pair still answers, which is the part
 * worth pinning: it is what `status` and a graceful `down` depend on.
 */

const originalHome = process.env.HHOSTED_HOME
const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-daemon-'))
process.env.HHOSTED_HOME = home

const { clearRuntime, isProcessAlive, newToken, probeRuntime, readRuntime, requestShutdown, runtimeSchema, writeRuntime } = await import('#src/helpers/daemon')

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

afterAll(async () => {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  await fs.promises.rm(home, { recursive: true, force: true })
})

function validRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    version: '0.6.2',
    pid: process.pid,
    url: 'http://127.0.0.1:3999',
    probeUrl: 'http://127.0.0.1:3999',
    protocol: 'http',
    port: 3999,
    bindHost: '127.0.0.1',
    startedAt: Date.now(),
    projectDir: home,
    dataRoot: home,
    configPath: path.join(home, 'servers.config.json'),
    logFile: path.join(home, 'home-hosted.log'),
    token: 'a-token',
    ...overrides,
  }
}

/** A throwaway listener that answers everything with one status. */
async function listener(status: number, options: { hang?: boolean, onRequest?: (req: http.IncomingMessage) => void } = {}): Promise<string> {
  const server = http.createServer((req, res) => {
    options.onRequest?.(req)
    if (options.hang === true)
      return
    res.statusCode = status
    res.end('x')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('runtimeSchema', () => {
  it('accepts what the daemon writes', () => {
    expect(runtimeSchema(validRuntime())).not.toBeInstanceOf(type.errors)
  })

  it('rejects a file missing the parts `down` needs', () => {
    for (const key of ['token', 'probeUrl', 'pid', 'port'] as const) {
      const broken: Record<string, unknown> = { ...validRuntime() }
      delete broken[key]
      expect(runtimeSchema(broken), key).toBeInstanceOf(type.errors)
    }
  })

  it('rejects an out-of-range port and a token that is empty', () => {
    expect(runtimeSchema(validRuntime({ port: 70000 }))).toBeInstanceOf(type.errors)
    expect(runtimeSchema(validRuntime({ token: '' }))).toBeInstanceOf(type.errors)
  })

  it('rejects an undeclared key, so a foreign run.json is not mistaken for ours', () => {
    expect(runtimeSchema({ ...validRuntime(), unexpected: true })).toBeInstanceOf(type.errors)
  })
})

describe('run.json round trip', () => {
  it('writes the file 0600, reads it back, and clears it', () => {
    const runtime = validRuntime({ token: newToken() })
    writeRuntime(runtime)

    expect(readRuntime()).toEqual(runtime)
    // Windows has no POSIX mode bits: `chmod` there only toggles the read-only flag, and
    // `stat` reports 0o666 for any writable file, so the mode is a POSIX-only assertion.
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(home, 'run.json')).mode & 0o777).toBe(0o600)

    clearRuntime()
    expect(readRuntime()).toBeNull()
    expect(fs.existsSync(path.join(home, 'run.json'))).toBe(false)
  })

  it('reads a corrupt or foreign file as "no daemon" instead of throwing', () => {
    fs.writeFileSync(path.join(home, 'run.json'), 'not json')
    expect(readRuntime()).toBeNull()

    fs.writeFileSync(path.join(home, 'run.json'), JSON.stringify({ pid: 1 }))
    expect(readRuntime()).toBeNull()
  })

  it('clearing a file that is not there is not an error', () => {
    clearRuntime()
    expect(() => clearRuntime()).not.toThrow()
  })
})

describe('newToken', () => {
  it('is long, url-safe and never repeats', () => {
    const token = newToken()
    expect(token).toMatch(/^[\w-]+$/)
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(newToken()).not.toBe(token)
  })
})

describe('isProcessAlive', () => {
  it('is true for this process and false for a reaped one', () => {
    expect(isProcessAlive(process.pid)).toBe(true)

    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
    expect(child.pid).toBeGreaterThan(0)
    expect(isProcessAlive(child.pid!)).toBe(false)
  })
})

describe('probeRuntime', () => {
  it('reports a reachable panel as up and not degraded', async () => {
    const probeUrl = await listener(200)
    expect(await probeRuntime(validRuntime({ probeUrl }))).toEqual({ reachable: true, degraded: false })
  })

  it('reads a 503 as reachable but degraded — a crashed autostart server is still serving', async () => {
    const probeUrl = await listener(503)
    expect(await probeRuntime(validRuntime({ probeUrl }))).toEqual({ reachable: true, degraded: true })
  })

  it('reports an unreachable port as down', async () => {
    // Port 1 is privileged and nothing listens there for a test runner.
    const probe = await probeRuntime(validRuntime({ probeUrl: 'http://127.0.0.1:1' }), 500)
    expect(probe).toEqual({ reachable: false, degraded: false })
  })

  it('gives up on a listener that accepts but never answers', async () => {
    const probeUrl = await listener(200, { hang: true })
    const started = Date.now()
    expect(await probeRuntime(validRuntime({ probeUrl }), 300)).toEqual({ reachable: false, degraded: false })
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('requestShutdown', () => {
  it('pOSTs the run.json token to /_hh/shutdown and treats 2xx as accepted', async () => {
    let seenPath: string | undefined
    let seenToken: string | undefined
    const probeUrl = await listener(204, {
      onRequest: (req) => {
        seenPath = req.url
        seenToken = req.headers['x-home-hosted-token'] as string | undefined
      },
    })

    expect(await requestShutdown(validRuntime({ probeUrl, token: 'secret-token' }))).toBe(true)
    expect(seenPath).toBe('/_hh/shutdown')
    expect(seenToken).toBe('secret-token')
  })

  it('refuses a status the panel did not accept', async () => {
    const probeUrl = await listener(403)
    expect(await requestShutdown(validRuntime({ probeUrl }))).toBe(false)
  })

  it('is false when nothing is listening', async () => {
    expect(await requestShutdown(validRuntime({ probeUrl: 'http://127.0.0.1:1' }), 500)).toBe(false)
  })
})
