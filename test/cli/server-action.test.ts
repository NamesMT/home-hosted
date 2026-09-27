import type net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

/**
 * `start`/`stop` against a real listener and a real run.json: the CLI has to read the
 * token out of the file, speak `/_hh`, and turn the panel's answer into one line —
 * including the panel that is too old to know the route at all.
 *
 * `spawn`, never `spawnSync`: the panel is a listener in *this* process, and a
 * synchronous wait would freeze the event loop that has to answer it.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-server-cmd-'))

function runCli(args: string[]): Promise<{ status: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
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
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
}

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

afterAll(async () => {
  await fs.promises.rm(home, { recursive: true, force: true })
})

interface Panel {
  url: string
  seen: { path?: string, token?: string }
}

/** A throwaway panel that answers one status and body, and records what it was asked. */
async function panel(status: number, body: string, contentType = 'application/json'): Promise<Panel> {
  const seen: Panel['seen'] = {}
  const server = http.createServer((req, res) => {
    seen.path = req.url
    seen.token = req.headers['x-home-hosted-token'] as string | undefined
    res.statusCode = status
    res.setHeader('content-type', contentType)
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, seen }
}

/** A run.json the CLI accepts, pointing at `url` and claiming `version`. */
function writeRuntime(url: string, version = '0.9.9'): void {
  const address = new URL(url)
  fs.writeFileSync(path.join(home, 'run.json'), `${JSON.stringify({
    version,
    // This process is alive, which is what `isProcessAlive` asks about.
    pid: process.pid,
    url,
    probeUrl: url,
    protocol: 'http',
    port: Number(address.port),
    bindHost: '127.0.0.1',
    startedAt: Date.now(),
    projectDir: home,
    dataRoot: home,
    configPath: path.join(home, 'servers.config.json'),
    logFile: path.join(home, 'home-hosted.log'),
    token: 'local-token',
  }, null, 2)}\n`)
}

describe('start/stop against a live panel', () => {
  it('sends the run.json token to /_hh and reports what the panel answered', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    const result = await runCli(['start', 'web'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('started web')
    expect(created.seen.path).toBe('/_hh/servers/web/start')
    expect(created.seen.token).toBe('local-token')
  })

  it('turns a refused action into its reason and exit 1', async () => {
    const created = await panel(409, JSON.stringify({ ok: false, error: 'server "web" is disabled' }))
    writeRuntime(created.url)

    const result = await runCli(['stop', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('server "web" is disabled')
  })

  /** The panel a person already has running is often the previous release. */
  it('names the release when the panel is too old to know the route', async () => {
    const created = await panel(404, 'not found', 'text/plain')
    writeRuntime(created.url, '0.6.4')

    const result = await runCli(['start', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('home-hosted 0.6.4')
    expect(result.stderr).toContain('does not know this command')
  })
})
