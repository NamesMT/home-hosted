import type { ChildProcess } from 'node:child_process'
import type net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `restore --from` against a **running** panel.
 *
 * With a panel up, the CLI does not read the archive: it hands the path over the local control
 * channel and the panel reads it. That makes the path a piece of wire input, and the thing worth
 * pinning is that it travels *in place of* `name` — a request carrying both would be refused by the
 * route, and one carrying `name` instead would restore the wrong archive.
 *
 * `spawn`, never `spawnSync`: the stub panel is a listener in this process, and a synchronous wait
 * would freeze the event loop that has to answer it.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-restore-online-'))

function runCli(args: string[]): Promise<{ status: number | null, output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home, NO_COLOR: '1' },
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })
    child.once('close', status => resolve({ status, output }))
  })
}

const servers: http.Server[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  for (const child of children.splice(0))
    child.kill('SIGKILL')
  await fs.promises.rm(path.join(home, '.hh', 'run.json'), { force: true })
})

interface Stub {
  url: string
  /** The query of the last `/_hh/backups/restore` the CLI sent. */
  seen: URLSearchParams | null
}

/** A panel stand-in: answers `/healthz` so the CLI believes it is up, and the restore plan. */
async function stubPanel(body: unknown): Promise<Stub> {
  const seen = { url: '', seen: null as URLSearchParams | null }
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/_hh/backups/restore') === true) {
      seen.seen = new URL(req.url, 'http://127.0.0.1').searchParams
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
      return
    }
    // `/healthz`: anything 2xx says "reachable", which is all `usesPanel` asks.
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end('{"status":"ok"}')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  seen.url = `http://127.0.0.1:${address.port}`
  return seen
}

/** A `run.json` the CLI accepts: this process is the "panel", and it is alive. */
function writeRuntime(url: string): void {
  const address = new URL(url)
  const file = path.join(home, '.hh', 'run.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({
    version: '0.9.11',
    pid: process.pid,
    url,
    probeUrl: url,
    protocol: 'http',
    port: Number(address.port),
    bindHost: '127.0.0.1',
    startedAt: Date.now(),
    projectDir: home,
    dataRoot: home,
    configPath: path.join(home, '.hh', 'default', 'servers.config.json'),
    logFile: path.join(home, '.hh', '.logs', 'home-hosted.log'),
    token: 'local-token',
  }, null, 2)}\n`)
}

/** A plan body the CLI reads back, with one selected item so the tree prints something. */
function planBody(): unknown {
  return {
    dryRun: true,
    encrypted: false,
    needsPassword: false,
    items: [{ id: 'global:settings', label: 'Global settings', kind: 'settings', restorable: true, selected: true, note: null }],
    applied: [],
    skipped: [],
    restartRequired: false,
    reloaded: false,
  }
}

describe('restore --from against a running panel', () => {
  it('sends the path as `from`, and never as a name', async () => {
    const created = await stubPanel(planBody())
    writeRuntime(created.url)
    const archive = path.join(home, 'carried', 'backup.zip')
    // The CLI checks the file exists before it hands the path over — the panel is on this same
    // machine (the local channel is loopback), so a missing file is the person's typo, not the
    // panel's, and the panel's "not a home-hosted backup" would send them to the wrong place.
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    fs.writeFileSync(archive, 'stub: this panel never reads it')

    const result = await runCli(['backup', 'restore', '--from', archive, '--all'])
    expect(result.status, result.output).toBe(0)
    expect(created.seen, 'the restore request must have reached the panel').not.toBeNull()
    expect(created.seen?.get('from')).toBe(archive)
    // Both would be refused by the route, and a name would restore the wrong archive.
    expect(created.seen?.get('name')).toBeNull()
    // The plan prints the file it read, so the person can tell two carried archives apart.
    expect(result.output).toContain('backup.zip')
  })

  it('sends a name as `name` on the old path, unchanged', async () => {
    const created = await stubPanel(planBody())
    writeRuntime(created.url)

    const result = await runCli(['backup', 'restore', 'nightly.zip', '--all'])
    expect(result.status, result.output).toBe(0)
    expect(created.seen?.get('name')).toBe('nightly.zip')
    expect(created.seen?.get('from')).toBeNull()
  })
})
