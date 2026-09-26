import { spawn } from 'node:child_process'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { processCarriesServerId, ProcessSampler, processTreePids } from '#src/providers/proc'

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

    let spin = 0
    const until = Date.now() + 120
    while (Date.now() < until) spin += Math.sqrt(spin + 1)

    const second = await sampler.sample(process.pid)
    expect(second!.cpuPercent).not.toBeNull()
    expect(second!.cpuPercent!).toBeGreaterThan(0)
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
