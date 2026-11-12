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
 * `start` and `restart` answer on **spawn**, which is right for a click and wrong for a script: an
 * entry whose command exits immediately printed "started" and exited 0 while it was already in its
 * crash-restart loop, so `start x && curl x` raced every boot.
 *
 * These drive the real CLI against a stub panel that answers the action and then the read-back
 * differently, because that difference is the whole subject.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-start-settle-'))

/** This file's scratch home: a leaked temp dir fails no assertion, so it is swept here. */
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const servers: http.Server[] = []

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

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  fs.rmSync(path.join(home, '.hh', 'run.json'), { force: true })
})

/**
 * A stub panel: the action answers `action`, and a `GET /_hh/servers/:id` answers `readBack`.
 *
 * Two answers from one server is what makes the read-back observable — a single fixed body could
 * only ever test one of the two calls.
 */
async function panel(action: { status: number, body: unknown }, readBack: { status: number, body: unknown }): Promise<string> {
  const server = http.createServer((req, res) => {
    const isRead = req.method === 'GET'
    const chosen = isRead ? readBack : action
    res.statusCode = chosen.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chosen.body))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return `http://127.0.0.1:${port}`
}

function writeRuntime(url: string): void {
  const address = new URL(url)
  const file = path.join(home, '.hh', 'run.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({
    version: '0.11.0',
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

describe('start reports what actually happened', () => {
  /**
   * The measured failure: `start dies` printed "started dies" and exited 0 for a command that exits
   * immediately. `status` on the read-back is `backoff` — spawned, then gone.
   */
  it('refuses an entry that exited on startup, naming the reason', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      { status: 200, body: { id: 'web', status: 'backoff', lastError: 'exited with code 1' } },
    ))

    const result = await runCli(['start', 'web'])

    expect(result.status, `a process that is already gone is not a success\n${result.stderr}`).toBe(1)
    expect(result.stderr).toContain('did not stay up')
    expect(result.stderr).toContain('exited with code 1')
    // stdout stays empty: a script reading it must not see a success line for a dead process.
    expect(result.stdout).not.toContain('started web')
  })

  /** "It was spawned; check logs" told a person nothing — the reason is in the last stderr lines. */
  it('quotes the last stderr lines of the entry that died', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      { status: 200, body: { id: 'web', status: 'backoff', lastError: 'exited with code 1' } },
    ))
    const logs = path.join(home, '.hh', 'default', '.logs')
    fs.mkdirSync(logs, { recursive: true })
    const rows = [
      { ts: 1, stream: 'stdout', text: 'booting' },
      ...Array.from({ length: 7 }, (_, index) => ({ ts: 2 + index, stream: 'stderr', text: `trace ${index}` })),
      { ts: 20, stream: 'system', text: 'exited with code 1' },
    ]
    fs.writeFileSync(path.join(logs, 'web.log'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    try {
      const result = await runCli(['start', 'web'])
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('It was spawned')
      expect(result.stderr).toContain('its last output:')
      expect(result.stderr).toContain('trace 6')
      expect(result.stderr).toContain('trace 2')
      // Five lines, stderr only.
      expect(result.stderr).not.toContain('trace 1')
      expect(result.stderr).not.toContain('booting')
    }
    finally {
      fs.rmSync(logs, { recursive: true, force: true })
    }
  })

  /** A single stop does not cascade; the panel only logged who still depends on it. */
  it('says which dependents a stop left running', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true, dependents: ['worker'] } },
      { status: 200, body: {} },
    ))
    const result = await runCli(['stop', 'web'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('stopped web')
    expect(result.stdout).toContain('still running and depending on this: worker')
  })

  /** A genuinely running entry must still be reported as started, and exit 0. */
  it('still reports a healthy start as success', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      { status: 200, body: { id: 'web', status: 'running', lastError: null } },
    ))

    const result = await runCli(['start', 'web'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('started web')
    expect(result.stderr).toBe('')
  })

  /**
   * `restart <id>` is the same spawn path, so the same defect: an entry that dies on boot answers
   * `ok` from either one. Fixed in the same place rather than left as a second instance.
   */
  it('refuses a restart whose entry exited on startup', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      { status: 200, body: { id: 'web', status: 'backoff', lastError: 'exited with code 1' } },
    ))

    const result = await runCli(['restart', 'web'])

    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('did not stay up')
  })

  /** `stop` spawns nothing, so it must not pay the settle wait nor gain a read-back. */
  it('does not read back after stop', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      { status: 500, body: { ok: false, error: 'stop must not read back' } },
    ))

    const result = await runCli(['stop', 'web'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('stopped web')
  })
})

/**
 * `usage` answers "which of my servers is eating the machine" without a browser.
 *
 * Two rules are pinned here: the loudest server leads (the question is "what is eating the
 * machine", so the answer must), and a reading that was never taken is a dash rather than a zero —
 * a `0` on a CPU column reads as "idle" and hides a server nobody is measuring.
 */
describe('usage', () => {
  it('ranks by memory and never prints a zero for a reading it does not have', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      {
        status: 200,
        body: {
          servers: [
            { id: 'quiet', workspaceId: 'default', label: 'quiet', status: 'stopped' },
            { id: 'small', workspaceId: 'default', label: 'small', status: 'running', cpuPercent: 1.5, rssBytes: 10 * 1024 * 1024, processes: 1 },
            { id: 'big', workspaceId: 'default', label: 'big', status: 'running', cpuPercent: 42, rssBytes: 900 * 1024 * 1024, processes: 3 },
          ],
          sampledAt: Date.now(),
        },
      },
    ))

    const result = await runCli(['usage'])

    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n')
    // Header, then loudest first.
    expect(lines[0]).toContain('SERVER')
    expect(lines[1]).toContain('big')
    expect(lines[2]).toContain('small')
    expect(lines[3]).toContain('quiet')
    // The stopped entry has no readings: a dash, not `0.0%` / `0.0 MB`.
    expect(lines[3]).toContain('—')
    expect(lines[3]).not.toMatch(/\b0\.0%/)
  })

  /**
   * A live snapshot cannot say "this has restarted nine times in the last hour", which is exactly
   * what a flapping entry looks like from a terminal — it uses almost nothing at any one sample and
   * is still the thing worth fixing. The window's numbers come from the same `ServerView.history`
   * the page reads.
   */
  it('shows the history window, so a flapping entry is visible without a browser', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      {
        status: 200,
        body: {
          servers: [
            { id: 'steady', workspaceId: 'default', label: 'steady', status: 'running', cpuPercent: 0.4, rssBytes: 40 * 1024 * 1024, processes: 1, crashes: 0, uptimeRatio: 1 },
            { id: 'flaps', workspaceId: 'default', label: 'flaps', status: 'crashed', crashes: 9, uptimeRatio: 0.25 },
            // Restarting every few minutes, but never given up on: no crash is counted.
            { id: 'loops', workspaceId: 'default', label: 'loops', status: 'running', restarts: 37, crashes: 0, uptimeRatio: 0.9 },
          ],
          sampledAt: Date.now(),
        },
      },
    ))

    const result = await runCli(['usage'])

    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toContain('CRASH')
    // Ranked by memory, so the running entry leads and the crashed one follows.
    expect(lines[1]).toContain('steady')
    expect(lines[2]).toContain('flaps')
    // The flapping entry's crash count and share of the window are why it is worth a look.
    expect(lines[2]).toMatch(/\b9\b/)
    expect(lines[2]).toContain('25%')
    // A restart loop the panel has not given up on shows up in the window, not in CRASH.
    expect(lines[0]).toContain('STARTS')
    expect(lines.find(line => line.includes('loops'))).toMatch(/\b37\b/)
  })

  /**
   * The count is **starts**, and the header must say so.
   *
   * It was `RESTARTS`, counting `start` events in the history window — so a server that had never
   * been restarted showed `1`, while the API's own `server.restarts` (the crash budget spent on the
   * current sequence) showed `0` for the same entry. Two numbers, one word, and the CLI was the one
   * lying. "starts minus one" would not have fixed it: the window clips the first start of anything
   * up long enough, so a server running for months and restarted twice today has two starts in the
   * window and one real restart. The column is renamed for what is counted instead.
   */
  it('names the column STARTS, so it cannot be read as the API\'s crash budget', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      {
        status: 200,
        body: {
          servers: [
            // One start, never restarted: the entry that showed "RESTARTS 1" beside an API "0".
            { id: 'fresh', workspaceId: 'default', label: 'fresh', status: 'running', restarts: 1, crashes: 0, uptimeRatio: 1 },
          ],
          sampledAt: Date.now(),
        },
      },
    ))

    const result = await runCli(['usage'])
    expect(result.status, result.stderr).toBe(0)
    const header = result.stdout.split('\n')[0]!
    expect(header).toContain('STARTS')
    expect(header, 'RESTARTS is the API\'s crash-budget field, a different number').not.toContain('RESTARTS')
  })

  /**
   * `--json` must not keep the old spelling: a table that says STARTS beside a JSON field called
   * `restarts` is the same confusion moved to a second surface, and a script reading it has no way
   * to tell the two quantities apart.
   */
  it('reports the count as `starts` in --json too, dropping the wire name', async () => {
    writeRuntime(await panel(
      { status: 200, body: { ok: true } },
      {
        status: 200,
        body: {
          servers: [
            { id: 'a', workspaceId: 'default', label: 'a', status: 'running', restarts: 5, crashes: 2 },
            // A panel that already sends the renamed field is read the same way.
            { id: 'b', workspaceId: 'default', label: 'b', status: 'running', starts: 7, crashes: 0 },
            // An entry with no history at all keeps the key absent, never `0`.
            { id: 'c', workspaceId: 'default', label: 'c', status: 'stopped' },
          ],
          sampledAt: 1_700_000_000_000,
        },
      },
    ))

    const result = await runCli(['usage', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout) as { servers: Array<Record<string, unknown>>, sampledAt?: number }
    const byId = new Map(body.servers.map(server => [server.id as string, server]))
    expect(byId.get('a')!.starts).toBe(5)
    expect(byId.get('a')).not.toHaveProperty('restarts')
    expect(byId.get('b')!.starts).toBe(7)
    expect(byId.get('c')).not.toHaveProperty('starts')
    expect(body.sampledAt, 'the rest of the document is passed through').toBe(1_700_000_000_000)
  })
})
