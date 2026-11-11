import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { testPort } from '../support/ports'

/**
 * The promise `docs/SERVERS.md` makes: **a child the panel spawns is detached, so it outlives a hard
 * panel death.**
 *
 * It was not true. The child's stdout and stderr were pipes whose *read end* was the panel, so killing
 * the panel closed them, and the child's next write to either raised `EPIPE` — which terminates a
 * process. Every server that logs anything died with the panel it was supposed to survive. These tests
 * drive the real CLI and a real child, because that is the only way to observe a signal the panel's
 * own code never sees.
 *
 * The panel runs in the foreground (`up --foreground`) so this test owns its pid and can `SIGKILL` it.
 * That is the same process tree a detached daemon would be, minus the re-spawn in between.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const homes: string[] = []
const strays: number[] = []

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {
      // Already gone, which is the usual case.
    }
  }
  /*
   * A survivor holds its transport files open — that is the whole point of the change these tests
   * cover — and Windows refuses to remove a directory holding an open handle. The kill above is
   * asynchronous there (it maps to `TerminateProcess`), so the handles are released after the pid
   * stops answering. Retry rather than fail the suite on teardown: an `EBUSY` here says nothing
   * about the behaviour under test.
   */
  await new Promise(resolve => setTimeout(resolve, 100))
  await Promise.all(homes.splice(0).map(home =>
    fs.promises.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })))
})

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-outlives-'))
  homes.push(home)
  return home
}

/**
 * A home with one supervised entry that writes to stdout every 200 ms.
 *
 * The chatter is the whole point: a silent child survives a closed pipe by never writing to it. The
 * pid file lets the test find the process the panel spawned without reaching into the panel.
 */
function seedHome(home: string, controlPort: number, options: { chatty?: boolean } = {}): { pidFile: string } {
  const hh = path.join(home, '.hh')
  const workspace = path.join(hh, 'default')
  fs.mkdirSync(workspace, { recursive: true })
  const pidFile = path.join(home, 'child.pid')
  const chatty = options.chatty ?? true

  fs.writeFileSync(path.join(hh, 'workspaces.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
    workspaces: [{ id: 'default', label: 'default' }],
  }, null, 2))
  fs.writeFileSync(path.join(hh, 'settings.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
    control: { port: controlPort, host: 'local' },
  }, null, 2))

  const childScript = [
    'const fs = require("node:fs")',
    'fs.writeFileSync(process.env.PID_FILE, String(process.pid))',
    // Writes to stdout on a timer: this is what a closed pipe kills.
    chatty
      ? 'setInterval(() => process.stdout.write("tick " + Date.now() + "\\n"), 200)'
      : 'setInterval(() => {}, 1000)',
  ].join('\n')

  fs.writeFileSync(path.join(workspace, 'servers.config.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
    servers: [{
      id: 'chatty',
      command: process.execPath,
      args: ['-e', childScript],
      env: { PID_FILE: pidFile },
      port: null,
      autostart: true,
      restart: { enabled: false },
      health: { enabled: false },
    }],
  }, null, 2))
  return { pidFile }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitForAlive(pidFile: string, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10)
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid))
        return pid
    }
    if (Date.now() > deadline)
      throw new Error(`the panel never spawned the entry (no live pid in ${pidFile})`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** The panel's own listening port, read from the `run.json` it writes once it is up. */
async function waitForPanel(home: string, timeoutMs = 60_000): Promise<{ pid: number, port: number }> {
  const file = path.join(home, '.hh', 'run.json')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const runtime = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number, port?: number }
      if (typeof runtime.pid === 'number' && typeof runtime.port === 'number')
        return { pid: runtime.pid, port: runtime.port }
    }
    catch {
      // Not written yet.
    }
    if (Date.now() > deadline)
      throw new Error('the panel never wrote run.json')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Starts `up --foreground` and hands back the process, so the test can SIGKILL it. */
function startPanel(home: string, port: number): ChildProcess {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    path.join(root, 'src', 'cli.ts'),
    'up',
    '--foreground',
    '--port',
    String(port),
  ], {
    cwd: root,
    env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
    stdio: 'ignore',
  })
  return child
}

describe('a supervised child outlives a hard panel death', () => {
  /**
   * Test 1 of the task, and the acceptance test for the whole change.
   *
   * Before this change the child was gone within ~2 s of the kill: its stdout pipe lost its reader,
   * the next `tick` write drew `EPIPE`, and Node ended the process. It is asserted as "alive two
   * seconds later" rather than "never receives SIGPIPE", because that is what a person observes — and
   * two seconds is four writes at the child's own 200 ms cadence, so it cannot pass by luck.
   */
  it('survives the panel being SIGKILLed, and is still alive 2 s later', async () => {
    const home = makeHome()
    // Two ports: the panel's control listener, and the entry's own (the panel refuses one it cannot bind).
    const port = await testPort()
    const controlPort = await testPort()
    const { pidFile } = seedHome(home, controlPort)

    const panel = startPanel(home, port)
    strays.push(panel.pid!)
    const childPid = await waitForAlive(pidFile)
    strays.push(childPid)

    /*
     * Kill the *panel*, by the pid `run.json` reports. `up --foreground` execs the daemon in this
     * process, so `panel.pid` is that pid on every platform that does not interpose a launcher.
     */
    const runtime = await waitForPanel(home)
    expect(runtime.pid, 'the panel records its own pid').toBe(panel.pid)

    // SIGKILL, not SIGTERM: a graceful stop is the panel's own `dispose()`, which would close the
    // pipes by design and prove nothing. This is the death the contract is about.
    process.kill(runtime.pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 2000))

    expect(isAlive(childPid), 'the child died with the panel: its output was a pipe the panel held').toBe(true)
  }, 120_000)

  /**
   * Test 2: while the panel is alive, the child's output still reaches the surface a person reads.
   *
   * The transport changed; the *log* did not. A child's `tick` has to arrive as a `LogLine` in the
   * JSONL the Logs page and `logs <id>` read — that is the whole point of reading the file back
   * rather than simply detaching the streams, and it is what would silently break if the reader were
   * wired to the wrong place.
   */
  it('still delivers the child\'s output to the panel\'s own log', async () => {
    const home = makeHome()
    const port = await testPort()
    const controlPort = await testPort()
    const { pidFile } = seedHome(home, controlPort)

    const panel = startPanel(home, port)
    strays.push(panel.pid!)
    const childPid = await waitForAlive(pidFile)
    strays.push(childPid)

    // The entry's JSONL, which is where `logs <id>` and the Logs page read from.
    const logFile = path.join(home, '.hh', 'default', '.logs', 'chatty.log')

    /**
     * Reads only the **complete** lines: the file is appended in batches, and a child writing every
     * 200 ms leaves a partial tail behind most of the time. Parsing that tail threw a `JSON.parse`
     * error out of the poll, which read as "the output never arrived" rather than as a torn read.
     */
    const childLines = (): Array<{ stream?: string, text?: string }> => {
      let text = ''
      try {
        text = fs.readFileSync(logFile, 'utf8')
      }
      catch {
        return []
      }
      const complete = text.split('\n').slice(0, -1)
      const parsed: Array<{ stream?: string, text?: string }> = []
      for (const line of complete) {
        try {
          parsed.push(JSON.parse(line) as { stream?: string, text?: string })
        }
        catch {
          // A line torn by the batch boundary is skipped, not fatal.
        }
      }
      return parsed
    }

    // A real `LogLine`, not raw text: the reader has to go through the same path a pipe's data did.
    const fromChild = (): Array<{ stream?: string, text?: string }> =>
      childLines().filter(line => line.stream === 'stdout' && line.text?.startsWith('tick'))
    const deadline = Date.now() + 30_000
    while (fromChild().length === 0) {
      if (Date.now() > deadline)
        throw new Error(`the child's stdout never reached ${logFile}; it holds: ${JSON.stringify(childLines().slice(-5))}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(fromChild().length, 'the child\'s lines are in the served log').toBeGreaterThan(0)
  }, 120_000)
})
