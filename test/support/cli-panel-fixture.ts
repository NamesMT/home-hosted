import type { ChildProcess } from 'node:child_process'
import type net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach } from 'vitest'
import { isProcessAlive } from '#src/providers/port'
import { testPort } from './ports'
import { cliArgv } from './run-cli'

/**
 * The `server-action*` CLI suites: a throwaway home, a fake panel listening in this process, and
 * the run.json that points the CLI at it. Each file calls `cliPanelFixture()` once, at its top level,
 * and gets its own home and hooks.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))

export interface Panel {
  url: string
  /** The last **action** request — never the read-back `start` now makes. */
  seen: { path?: string, token?: string, readBack?: string }
}

export async function cliPanelFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-server-cmd-'))

  /**
   * A control port nothing else can be holding.
   *
   * The fixture's `settings.json` is seeded by the first `--print-config` run, naming the default
   * 3999 — so a developer with a panel on 3999 made `down`'s `configuredPanelAddress` probe find it and
   * refuse, and this file failed against a perfectly good CLI. The port comes from this worker's own
   * block (`ports.ts`): an ephemeral one, probed and released, was soon another fixture's, and `down`
   * then refused for real.
   */
  const controlPort = await testPort()
  fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hh', 'settings.json'), JSON.stringify({
    meta: { writtenBy: '0.11.0', schema: 2 },
    control: { port: controlPort, host: 'local' },
  }, null, 2))

  function runCli(args: string[]): Promise<{ status: number | null, stdout: string, stderr: string }> {
    return new Promise((resolve) => {
      const [executable, ...argv] = cliArgv(args)
      const child = spawn(executable, argv, {
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
  /** Stranger processes spawned as stand-ins for a recycled pid; killed after each test. */
  const children: ChildProcess[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })))
    for (const child of children.splice(0)) {
      if (child.pid !== undefined && isProcessAlive(child.pid))
        child.kill('SIGKILL')
    }
    // Dropped per test, not only at the end: a run.json naming this process is what `down`
    // would signal, and leaving one behind made a later test shoot its own worker.
    await fs.promises.rm(path.join(home, '.hh', 'run.json'), { force: true })
  })

  afterAll(async () => {
    await fs.promises.rm(home, { recursive: true, force: true })
  })

  /** A throwaway panel that answers one status and body, and records what it was asked. */
  async function panel(status: number, body: string, contentType = 'application/json'): Promise<Panel> {
    const seen: Panel['seen'] = {}
    const server = http.createServer((req, res) => {
      seen.token = req.headers['x-home-hosted-token'] as string | undefined
      // A real panel answers a read-back as well as the action, and `start` now asks for one: a stub
      // that replays the action's `{ ok: true }` for every request describes an entry with no
      // `status`, which is exactly the shape `start` refuses. The read-back is recorded apart, so a
      // test that asserts which *action* was sent still reads the action.
      if (req.method === 'GET' && req.url?.startsWith('/_hh/servers/')) {
        seen.readBack = req.url
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'web', status: 'running', lastError: null }))
        return
      }
      seen.path = req.url
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
  function writeRuntime(url: string, version = '0.9.9', overrides: { pid?: number, startedAt?: number } = {}): void {
    const address = new URL(url)
    const file = path.join(home, '.hh', 'run.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({
      version,
      // This process is alive, which is what `isProcessAlive` asks about.
      pid: overrides.pid ?? process.pid,
      url,
      probeUrl: url,
      protocol: 'http',
      port: Number(address.port),
      bindHost: '127.0.0.1',
      startedAt: overrides.startedAt ?? Date.now(),
      projectDir: home,
      dataRoot: home,
      configPath: path.join(home, '.hh', 'default', 'servers.config.json'),
      logFile: path.join(home, '.hh', '.logs', 'home-hosted.log'),
      token: 'local-token',
    }, null, 2)}\n`)
  }

  /** A pid that is alive but whose process started long after the record was written. */
  async function recycledPid(): Promise<{ pid: number, startedAt: number }> {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    children.push(child)
    if (child.pid === undefined)
      throw new Error('could not spawn the stranger')
    // The record claims to have been written an hour ago, so a pid born just now cannot be it.
    return { pid: child.pid, startedAt: Date.now() - 3600_000 }
  }

  return { home, controlPort, runCli, servers, panel, writeRuntime, recycledPid }
}
