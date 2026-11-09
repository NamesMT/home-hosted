import type { ChildProcess } from 'node:child_process'
import type net from 'node:net'
import type { NannyState } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { nannyStatePath, writeNannyState } from '#src/providers/nanny'
import { isProcessAlive } from '#src/providers/port'

/**
 * The `down-persistent*` CLI suites: a throwaway home, stand-in nannies and the state files that
 * describe them. Each file calls `downPersistentFixture()` once, at its top level, and gets its own
 * home and hooks.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))

export function downPersistentFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-down-persistent-'))

  /** This file's scratch home: a leaked temp dir fails no assertion, so it is swept here. */
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  const spawned: ChildProcess[] = []

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

  /** A long-lived process standing in for a nanny, killed whatever the test does. */
  function spawnStub(): number {
    const child = spawn(process.execPath, ['-e', 'process.on(\'SIGTERM\', () => process.exit(0)); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    child.unref()
    spawned.push(child)
    return child.pid!
  }

  /** Listeners a test opened, closed afterwards. */
  const listening: net.Server[] = []

  /** Removes the record a previous test may have left, so it cannot answer for this one. */
  function zshHome(): void {
    fs.rmSync(path.join(home, '.hh', 'run.json'), { force: true })
  }

  /** A settings.json naming `port` — the only record left once run.json is gone. */
  function writeSettings(port: number): void {
    const settings = { meta: { writtenBy: '0.11.0', schema: CONFIG_SCHEMA }, control: { port, host: 'local' } }
    fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
  }

  /**
   * A workspace whose `.state` describes one running persistent entry.
   *
   * The servers config declares the entry so the stop can read *its* policy rather than the
   * defaults — that is the difference this test would otherwise not see.
   */
  function writePersistent(
    workspaceId: string,
    serverId: string,
    nannyPid: number,
    overrides: Partial<NannyState> = {},
    config: Record<string, unknown> = {},
  ): string {
    const stateDir = path.join(home, '.hh', workspaceId, '.state')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(path.join(home, '.hh', workspaceId), { recursive: true })
    // Stamped as the current schema, like the servers file below: an unstamped file reads as the oldest
    // shape, which has a migration pending and is therefore refused — the same trap this helper's
    // sibling comment records. `down` now reports an unreadable settings file as "cannot tell", which
    // widens its stop budget to the ceiling, so an unstamped fixture made every case here wait 10 min.
    fs.writeFileSync(path.join(home, '.hh', workspaceId, 'settings.json'), `${JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA } })}\n`)
    // Stamped as the current schema: an unstamped file reads as the oldest shape, which has a
    // migration pending and is therefore refused — the stop would fall back to default policy.
    fs.writeFileSync(path.join(home, '.hh', workspaceId, 'servers.config.json'), `${JSON.stringify({
      $schema: './servers.config.schema.json',
      meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
      servers: [{ id: serverId, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], persistent: true, autostart: false, ...config }],
    }, null, 2)}\n`)
    const file = nannyStatePath(stateDir, serverId)
    writeNannyState(file, {
      serverId,
      nannyPid,
      childPid: null,
      startedAt: Date.now(),
      logFile: path.join(home, '.hh', workspaceId, '.logs', `${serverId}.log`),
      heartbeatAt: Date.now(),
      ...overrides,
    } as NannyState)
    return file
  }

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      if (child.pid !== undefined && isProcessAlive(child.pid)) {
        try {
          child.kill('SIGKILL')
        }
        catch {
          // Already gone.
        }
      }
    }
    for (const server of listening.splice(0))
      await new Promise<void>(resolve => server.close(() => resolve()))
  })

  return { home, runCli, spawned, spawnStub, listening, zshHome, writeSettings, writePersistent }
}
