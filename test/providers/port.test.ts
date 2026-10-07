import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isProcessAlive, killPortHolders, listPortHolders, parseFiletime, parseProcBirth, parsePsBirth, processBirth, processLiveness, terminatePids } from '#src/providers/port'

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && isProcessAlive(child.pid))
      child.kill('SIGKILL')
  }
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * A real child process, which is the only thing a signal can be tested against.
 * It reports "ready" on stdout once its signal handler is installed — a signal
 * sent before then would race the runtime's own startup and prove nothing.
 */
function spawnSleeper(options: { ignoreTerm?: boolean } = {}): Promise<number> {
  const handler = options.ignoreTerm === true ? 'process.on("SIGTERM", () => {}); ' : ''
  const script = `${handler}process.stdout.write("ready\\n"); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  if (child.pid === undefined)
    throw new Error('could not spawn a helper process')
  const pid = child.pid

  return new Promise((resolve) => {
    child.stdout?.once('data', () => resolve(pid))
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate())
      return
    await delay(25)
  }
  throw new Error('waitFor timed out')
}

/** A port the OS just handed out, and that nothing is listening on any more. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * The zombie child of a parent that has **exec'd** away, so nothing will ever reap it. Found by
 * asking the process table for the parent's child rather than by guessing a pid.
 */
async function waitForZombieChild(parentPid: number): Promise<number> {
  let found: number | null = null
  await waitFor(() => {
    const rows = execFileSync('ps', ['-o', 'pid=,stat=', '--ppid', String(parentPid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, state] = line.trim().split(/\s+/)
        return { pid: Number(pid), state: state ?? '' }
      })
      .filter(row => row.state.startsWith('Z'))
    if (rows.length > 0) {
      found = rows[0]!.pid
      return true
    }
    return false
  })
  if (found === null)
    throw new Error('no zombie child appeared')
  return found
}

describe('isProcessAlive', () => {
  it('reports a running child, and stops reporting it once it exits', async () => {
    const pid = await spawnSleeper()
    expect(isProcessAlive(pid)).toBe(true)

    process.kill(pid, 'SIGKILL')
    await waitFor(() => !isProcessAlive(pid))
    expect(isProcessAlive(pid)).toBe(false)
  })

  /**
   * `EPERM` means the process exists but is not ours to signal — and reading it as gone was a real
   * defect, not a detail.
   *
   * `nannyIsAlive` starts with this predicate, so a nanny owned by another user read as absent:
   * `resumePersistent` then consumed its state file (deleting the only record of the running entry) and
   * started a **second** copy, while the first kept running untracked. `helpers/daemon.ts` already
   * treated `EPERM` as alive in its own copy; the two predicates disagreed and have now been unified.
   *
   * The branch is exercised through the real function rather than a mock: a pid we are allowed to
   * signal is the `true` case, and an impossible-to-own pid would need root, so `ESRCH` gives the
   * `false` case on both sides of the fix.
   */
  it('treats an unserveable pid as alive, and a gone one as dead', () => {
    // Signal 0 against a pid that cannot exist: `ESRCH`, which is genuinely not alive.
    expect(isProcessAlive(2 ** 30), 'no such process').toBe(false)

    // The `EPERM` answer is the one that changed, and it needs a process owned by another user to
    // happen for real — so `process.kill` is made to answer the way the OS does. Driving the
    // predicate this way is what the previous version could not do: it read `port.ts` as *text* and
    // looked for `code === 'EPERM'`, which passed while the branch was `'EPERM' && false` — the
    // exact semantics bug it claimed to guard.
    const original = process.kill
    try {
      process.kill = (() => {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }) as typeof process.kill
      expect(isProcessAlive(1), 'EPERM means alive but not ours to signal').toBe(true)

      process.kill = (() => {
        const error = new Error('no such process') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }) as typeof process.kill
      expect(isProcessAlive(1), 'ESRCH means gone').toBe(false)
    }
    finally {
      process.kill = original
    }
  })
})

describe('processLiveness', () => {
  /**
   * The bug this exists for: a pid is not an identity.
   *
   * A stale `run.json` whose pid the OS had since handed to an unrelated process made `up` refuse
   * with "already running", `status` report "running, but not answering", and `down` SIGTERM then
   * SIGKILL that stranger. `startedAt` is the tiebreak: the daemon stamps its record during its own
   * boot, so a pid born *after* that stamp cannot be the daemon.
   */
  it('calls a pid born after the record recycled, and one born before it live', async () => {
    const pid = await spawnSleeper()
    const birth = await processBirth(pid)
    expect(birth, 'the platform must report a birth time for this test to mean anything').not.toBeNull()

    // The record was written an hour after the process started: the process really is older.
    expect(await processLiveness(pid, birth!.startMs + 3600_000)).toBe('live')
    // The record was written an hour before the pid was born: the OS handed that number out again.
    expect(await processLiveness(pid, birth!.startMs - 3600_000)).toBe('recycled')
  })

  it('reads a dead pid as gone', async () => {
    const pid = await spawnSleeper()
    process.kill(pid, 'SIGKILL')
    await waitFor(() => !isProcessAlive(pid))
    expect(await processLiveness(pid, Date.now())).toBe('gone')
  })

  /**
   * A zombie has exited but its parent has not reaped it, so signal 0 still succeeds. Treating that
   * as "alive" is the second way a stale record survived — and a zombie cannot be the daemon, which
   * would have been reaped by the very parent that owned it.
   *
   * Built from a real one rather than a mock: `sh` forks the background child and then **execs**, so
   * the child is orphaned in place and nothing ever waits for it.
   */
  it.runIf(process.platform === 'linux')('reads a zombie as gone, though signal 0 succeeds', async () => {
    const parent = spawn('sh', ['-c', 'sleep 0.3 & exec sleep 30'], { stdio: 'ignore' })
    children.push(parent)
    try {
      const pid = await waitForZombieChild(parent.pid!)
      expect(isProcessAlive(pid), 'a zombie still answers signal 0').toBe(true)
      expect(await processLiveness(pid, Date.now())).toBe('gone')
    }
    finally {
      parent.kill('SIGKILL')
    }
  })

  /**
   * `unknown` must not collapse into `gone`: a platform that cannot report a birth time would
   * otherwise have a **running** panel's record cleared out from under it.
   */
  it('reports unknown when the platform cannot give a birth time', async () => {
    const pid = await spawnSleeper()
    expect(await processLiveness(pid, Date.now(), { readBirth: async () => null })).toBe('unknown')
  })

  it('parses a ps start line, with and without the weekday', () => {
    const parsed = parsePsBirth('S Wed Oct  7 19:43:26 2026')
    expect(parsed).not.toBeNull()
    expect(parsed!.zombie).toBe(false)
    expect(new Date(parsed!.startMs).getFullYear()).toBe(2026)
    expect(parsePsBirth('Z Wed Oct  7 19:43:26 2026')!.zombie).toBe(true)
    // An empty read is "no answer", never a zero timestamp.
    expect(parsePsBirth('')).toBeNull()
    expect(parsePsBirth('S')).toBeNull()
  })

  /**
   * `/proc/<pid>/stat` counts fields after the **last** `)`: the comm field is parenthesised and may
   * itself contain a `)` and spaces. Counting from the first would shift every offset by one for a
   * process named like that, and this value decides whether a record is stale.
   */
  it('counts /proc fields from after the last parenthesis in the command name', () => {
    // `S` (state) + 19 fields + starttime at field 22, with a command name containing `)`.
    const stat = `1234 (weird ) name) S ${Array.from({ length: 18 }).fill('0').join(' ')} 500`
    const parsed = parseProcBirth(stat, 1000, 100)
    expect(parsed).not.toBeNull()
    // 1000s of boot + 500 ticks at 100 Hz = 5s.
    expect(parsed!.startMs).toBe(1000 * 1000 + 5000)
    expect(parsed!.zombie).toBe(false)
    expect(parseProcBirth(stat.replace(') S ', ') Z '), 1000, 100)!.zombie).toBe(true)
    expect(parseProcBirth('no parenthesis here', 1000)).toBeNull()
  })

  /**
   * The Windows epoch, pinned because getting it wrong is silent and severe.
   *
   * `DateTime.Ticks` counts 100ns from **0001**, while FILETIME counts from **1601** — 1600 years
   * apart. Reading a `.Ticks` value with this FILETIME conversion put every Windows panel that far
   * in the future, so `processLiveness` called a *live* panel `recycled` and it could no longer
   * signal-stop itself. Nothing on Linux CI exercises the line, which is exactly why the arithmetic
   * itself is asserted here against a known instant.
   *
   * 2026-01-01T00:00:00Z is `11644473600 + 1767225600` seconds after the FILETIME epoch.
   */
  it('converts FILETIME ticks from the 1601 epoch, not the 0001 one', () => {
    const expected = Date.UTC(2026, 0, 1)
    const filetimeTicks = (expected + 11644473600000) * 1e4
    expect(parseFiletime(filetimeTicks)).toBe(expected)

    // The mistake this guards: a .NET DateTime's own Ticks for the same instant is 1600 years larger,
    // and must never be accepted as-is.
    const dateTimeTicks = (expected + 62135596800000) * 1e4
    expect(dateTimeTicks).toBeGreaterThan(filetimeTicks)
    expect(parseFiletime(dateTimeTicks)).not.toBe(expected)

    // No answer, rather than a nonsense epoch.
    expect(parseFiletime(Number.NaN)).toBeNull()
    expect(parseFiletime(0)).toBeNull()
    expect(parseFiletime(-1)).toBeNull()
  })
})

describe('terminatePids', () => {
  it('stops a process on SIGTERM, without forcing it', async () => {
    const pid = await spawnSleeper()
    const result = await terminatePids([pid], { graceMs: 4000 })

    expect(result.stopped).toEqual([pid])
    expect(result.forced).toEqual([])
    expect(isProcessAlive(pid)).toBe(false)
  })

  // Windows turns every signal into an immediate terminate, so "ignores SIGTERM"
  // cannot be expressed there; the escalation itself is POSIX-only behaviour.
  it.runIf(process.platform !== 'win32')('kills what ignores SIGTERM', async () => {
    const pid = await spawnSleeper({ ignoreTerm: true })
    const result = await terminatePids([pid], { graceMs: 300 })

    expect(result.stopped).toEqual([])
    expect(result.forced).toEqual([pid])
    await waitFor(() => !isProcessAlive(pid))
  })

  it('claims nothing about a pid that is already gone', async () => {
    const pid = await spawnSleeper()
    process.kill(pid, 'SIGKILL')
    await waitFor(() => !isProcessAlive(pid))

    const result = await terminatePids([pid], { graceMs: 100 })
    expect(result.stopped).toEqual([])
    expect(result.forced).toEqual([])
  })

  it('deduplicates the pids it was given', async () => {
    const pid = await spawnSleeper()
    const result = await terminatePids([pid, pid], { graceMs: 4000 })

    expect(result.stopped).toEqual([pid])
    expect(result.forced).toEqual([])
  })
})

describe('killPortHolders', () => {
  it('never touches a listener it was told to exclude', async () => {
    const port = await freePort()
    const child = spawn(process.execPath, ['-e', `require("node:net").createServer().listen(${port}, "127.0.0.1")`], { stdio: 'ignore' })
    children.push(child)
    if (child.pid === undefined)
      throw new Error('could not spawn a listener')
    const pid = child.pid

    try {
      await waitFor(async () => (await listPortHolders(port)).includes(pid))

      // The panel's own process tree is never a leftover to kill: a sibling entry
      // under `onPortConflict: warn` shares a port without becoming a target.
      expect(await killPortHolders(port, new Set([pid]))).toEqual([])
      expect(isProcessAlive(pid)).toBe(true)

      expect(await killPortHolders(port)).toContain(pid)
      await waitFor(() => !isProcessAlive(pid))
    }
    finally {
      if (isProcessAlive(pid))
        process.kill(pid, 'SIGKILL')
    }
  })
})
