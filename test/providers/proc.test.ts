import { spawn } from 'node:child_process'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { processCarriesServerId, ProcessSampler, processTreePids, treeCpuUsedSeconds } from '#src/providers/proc'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * macOS has no cumulative CPU counter to diff — `ps` hands back an instantaneous
 * percentage on the first read — so "no baseline yet" is only meaningful on the
 * platforms that compute a delta.
 */
const computesCpuFromDelta = process.platform !== 'darwin'

describe('process sampler', () => {
  it('reports the tree of the current process', async () => {
    const sampler = new ProcessSampler()
    const sample = await sampler.sample(process.pid)

    expect(sample).not.toBeNull()
    expect(sample!.rssBytes).toBeGreaterThan(1024 * 1024)
    expect(sample!.processes).toBeGreaterThanOrEqual(1)
    if (computesCpuFromDelta) {
      // No previous sample yet, so CPU needs a second reading.
      expect(sample!.cpuPercent).toBeNull()
    }
    else {
      expect(sample!.cpuPercent).toBeGreaterThanOrEqual(0)
    }
  })

  it('computes cpu percent between two samples', async () => {
    const sampler = new ProcessSampler()
    await sampler.sample(process.pid)

    // Busy until the sampler reports a number, rather than for a fixed 120 ms. Windows
    // updates its CPU counters on a coarse tick and reports some processes with empty time
    // fields, so a single short spin occasionally produced a null on a busy CI runner — and
    // "expected null not to be null" says nothing about which of those happened.
    let spin = 0
    const deadline = Date.now() + 5000
    let second = await sampler.sample(process.pid)
    while ((second!.cpuPercent === null || second!.cpuPercent === 0) && Date.now() < deadline) {
      const until = Date.now() + 60
      while (Date.now() < until) spin += Math.sqrt(spin + 1)
      second = await sampler.sample(process.pid)
    }

    // Named separately: a null means the platform reported no time for this tree at all,
    // while a zero means the counters did not move. They are different problems.
    expect(second!.cpuPercent, `the sampler reported no CPU time for this tree after spinning (spin=${Math.round(spin)})`).not.toBeNull()
    expect(second!.cpuPercent!, 'the CPU counters did not advance while this process spun').toBeGreaterThan(0)
  })

  it('returns null for a process that does not exist', async () => {
    const sampler = new ProcessSampler()
    expect(await sampler.sample(999_999_999)).toBeNull()
  })

  it('samples many roots in one pass', async () => {
    const sampler = new ProcessSampler()
    const samples = await sampler.sampleMany([process.pid, 999_999_999])
    expect(samples.size).toBe(2)
    expect(samples.get(process.pid)).not.toBeNull()
    expect(samples.get(999_999_999)).toBeNull()
  })

  it('drops its cpu baseline when forgotten', async () => {
    const sampler = new ProcessSampler()
    await sampler.sample(process.pid)
    await sleep(30)
    sampler.forget(process.pid)
    const after = await sampler.sample(process.pid)
    if (computesCpuFromDelta)
      expect(after!.cpuPercent).toBeNull()
    else
      expect(after!.cpuPercent).toBeGreaterThanOrEqual(0)
  })
})

describe('processCarriesServerId', () => {
  const children: ReturnType<typeof spawn>[] = []

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.pid !== undefined)
        child.kill('SIGKILL')
    }
  })

  it.runIf(process.platform !== 'win32')('recognizes the marker the supervisor handed a child', async () => {
    // This is what separates a detached successor from a stranger on the port.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { ...process.env, HHOSTED_SERVER_ID: 'probe-demo' },
    })
    children.push(child)
    if (child.pid === undefined)
      throw new Error('no pid')
    await sleep(150)

    expect(await processCarriesServerId(child.pid, 'probe-demo')).toBe(true)
    expect(await processCarriesServerId(child.pid, 'someone-else')).toBe(false)
  })

  it('says no when there is no process to ask', async () => {
    expect(await processCarriesServerId(2 ** 30, 'web')).toBe(false)
  })
})

describe('processTreePids', () => {
  const children: ReturnType<typeof spawn>[] = []

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.pid !== undefined)
        child.kill('SIGKILL')
    }
  })

  /**
   * The pid the panel records is rarely the pid holding the port: a nanny, or a
   * wrapper like the one the sampler's own docs describe, puts the real server one
   * generation down. Ownership has to reach it, or `kill`/`free-port` stops our own.
   */
  it('includes a grandchild, which is where a wrapped server actually listens', async () => {
    const parent = spawn(process.execPath, [
      '-e',
      'const { spawn } = require("node:child_process");const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });console.log(c.pid);setInterval(() => {}, 1000)',
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(parent)
    if (parent.pid === undefined)
      throw new Error('no pid')

    const grandchild = await new Promise<number>((resolve, reject) => {
      parent.stdout!.once('data', (chunk: { toString: () => string }) => resolve(Number.parseInt(chunk.toString().trim(), 10)))
      parent.once('error', reject)
    })
    children.push({ kill: () => process.kill(grandchild, 'SIGKILL') } as unknown as ReturnType<typeof spawn>)

    const pids = await processTreePids([parent.pid])
    expect(pids.has(parent.pid)).toBe(true)
    expect(pids.has(grandchild)).toBe(true)
    expect(pids.has(process.pid)).toBe(false)
  })
})

/**
 * A process tree is not a fixed set of processes, and both ways it changes used to corrupt the
 * CPU reading.
 *
 * The sampler differenced "the sum of cumulative CPU seconds over whatever is in the tree now"
 * against that same sum from the previous sample. A child that **exited** made the sum drop, the
 * delta went negative, and the reading was discarded — measured against a wrapper that respawns a
 * short-lived worker, **two samples in every three were thrown away**, which is the "gaps" a person
 * sees on a live server.
 *
 * The burner has to be spawned *by the root*, not by this test process: a sibling is not in the
 * tree, and asserting against one proves nothing. That mistake is why the first version of these
 * tests passed against the unfixed sampler.
 */
describe('process sampler across a changing tree', () => {
  const trees: ReturnType<typeof spawn>[] = []

  afterEach(() => {
    for (const child of trees.splice(0)) {
      if (child.pid !== undefined) {
        try {
          child.kill('SIGKILL')
        }
        catch {
          // Already gone.
        }
      }
    }
  })

  /** A root that spawns a busy child of its own, so the child is really inside the tree. */
  function rootWithChild(childSource: string, delayMs = 0): ReturnType<typeof spawn> {
    const script = `
      const { spawn } = require('node:child_process')
      setTimeout(() => {
        spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' })
      }, ${delayMs})
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    trees.push(child)
    return child
  }

  it.skipIf(process.platform === 'win32')('keeps reporting cpu after a busy child exits the tree', async () => {
    // The child burns for ~1.5 s then exits, so the tree SHRINKS between the second and third
    // sample. The root is alive throughout: there is always a real interval to report.
    const root = rootWithChild('const end = Date.now() + 1500; while (Date.now() < end);')
    const sampler = new ProcessSampler()
    await sampler.sample(root.pid!)

    await sleep(600)
    const whileBurning = await sampler.sample(root.pid!)
    expect(whileBurning).not.toBeNull()
    expect(whileBurning!.processes, 'the burner must be counted inside the tree').toBe(2)

    // Well after the burner exited: this is the sample the old code threw away.
    await sleep(1600)
    const afterExit = await sampler.sample(root.pid!)
    expect(afterExit, 'the root outlived its child').not.toBeNull()
    expect(afterExit!.processes, 'the tree is the root alone again').toBe(1)
    expect(
      afterExit!.cpuPercent,
      'the tree shrank, but the root is alive — a discarded reading is the gap a user sees',
    ).not.toBeNull()
  }, 30_000)

  it.skipIf(process.platform === 'win32')('does not count a new child\'s whole lifetime as one interval', async () => {
    // The child is spawned only AFTER the first sample, and it has already banked ~1 s of CPU by
    // the time the second sample runs. Adding that lifetime to one window is the inflation bug.
    const root = rootWithChild('const end = Date.now() + 4000; while (Date.now() < end);', 700)
    const sampler = new ProcessSampler()
    await sampler.sample(root.pid!)

    await sleep(1500)
    const sample = await sampler.sample(root.pid!)
    expect(sample).not.toBeNull()
    expect(sample!.cpuPercent, 'the new child is in the tree').not.toBeNull()
    // One burner on one core cannot exceed one core for the whole window. Anything near several
    // hundred is the child's banked lifetime being charged to this interval.
    expect(
      sample!.cpuPercent,
      'a single burner cannot account for more than one core of this window',
    ).toBeLessThan(150)
  }, 30_000)
})

/**
 * The interval arithmetic itself, which no live scan can pin.
 *
 * Both CPU bugs were in how two scans were combined, and whether they appear at all depends on
 * which pids existed* in each scan — a wrapper respawning a worker changes that every few
 * seconds, a plain test process never does. Feeding the maps directly makes the arithmetic
 * deterministic, so a wrong rule fails here instead of looking like an occasional gap in
 * production.
 *
 * Two cases are deliberately absent: "a child that exits contributes nothing" and "a new child is
 * charged its whole counter" are each *true of the old algorithm too* when you line the sums up.
 * What the old algorithm got wrong was the sign and the magnitude once the two sides disagreed —
 * which is what the cases below pin. Asserting a case the buggy code already satisfies would be a
 * test that cannot fail.
 */
describe('treeCpuUsedSeconds', () => {
  it('ignores a recycled pid, whose counter restarted lower', () => {
    // Pid 101 is a different process now: 0.3 s against the old 50 s is not a -49.7 s delta.
    // The old rule summed both sides and returned -49.5 for the tree, which the caller discarded.
    const previous = new Map([[100, 10], [101, 50]])
    const next = new Map([[100, 10.2], [101, 0.3]])
    expect(treeCpuUsedSeconds(previous, next, [100, 101])).toBeCloseTo(0.2)
  })

  it('charges a tree that is entirely new only what it accrued, never the previous total', () => {
    // Every pid in this tree is new (a restarted entry, or one whose children were all replaced).
    // There is no previous reading for them, so their cumulative counters are the whole story —
    // and the previous scan's totals for *other* pids must not enter the subtraction at all.
    expect(treeCpuUsedSeconds(new Map([[100, 5]]), new Map([[100, 5], [200, 3]]), [200])).toBe(3)
  })

  it('reports no reading when the tree it was asked about is gone', () => {
    // Nothing in the tree was seen in the new scan: no interval exists. The old rule returned a
    // negative number here, which the caller turned into either a gap or a bogus 0.
    expect(treeCpuUsedSeconds(new Map([[100, 5]]), new Map(), [100])).toBeNull()
  })

  it('returns zero, not null, when the tree is alive and simply idle', () => {
    expect(treeCpuUsedSeconds(new Map([[100, 5]]), new Map([[100, 5]]), [100])).toBe(0)
  })

  it('does not charge the tree for a pid outside it', () => {
    const previous = new Map([[100, 1], [999, 100]])
    const next = new Map([[100, 1.5], [999, 200]])
    // 999 is another server's process; its busy interval must not land on this tree.
    expect(treeCpuUsedSeconds(previous, next, [100])).toBeCloseTo(0.5)
  })
})
