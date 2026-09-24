import { describe, expect, it } from 'vitest'
import { ProcessSampler } from '#src/providers/proc'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('process sampler', () => {
  it('reports the tree of the current process', async () => {
    const sampler = new ProcessSampler()
    const sample = await sampler.sample(process.pid)

    expect(sample).not.toBeNull()
    expect(sample!.rssBytes).toBeGreaterThan(1024 * 1024)
    expect(sample!.processes).toBeGreaterThanOrEqual(1)
    // No previous sample yet, so CPU needs a second reading.
    expect(sample!.cpuPercent).toBeNull()
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
    expect(after!.cpuPercent).toBeNull()
  })
})
