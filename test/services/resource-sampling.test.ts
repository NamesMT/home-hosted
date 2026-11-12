import type { ComposeReading, ComposeTarget, DockerMetrics } from '#src/providers/docker'
import type { ProcessSampler } from '#src/providers/proc'
import type { Entry } from '#src/services/supervisor/entry'
import type { ProcessResources } from '#src/shared/contracts'
import { describe, expect, it } from 'vitest'
import { sampleResources } from '#src/services/supervisor/health'

/** The narrowest live `Entry` `sampleResources` reads. */
function liveEntry(id: string, pid: number, compose: ComposeTarget | null = null): Entry {
  return {
    config: { id },
    pid,
    child: {},
    adopted: false,
    runToken: 0,
    resources: null,
    resourcesFromContainers: false,
    resourcesSampledAt: 0,
    compose,
  } as unknown as Entry
}

function sampler(sampleMany: (pids: number[]) => Promise<Map<number, ProcessResources | null>>): ProcessSampler {
  return { sampleMany } as unknown as ProcessSampler
}

const reading = (pid: number): ProcessResources => ({ cpuPercent: 5, rssBytes: pid, processes: 1, sampledAt: 1 })

describe('resource sampling across a run', () => {
  it('does not write a sample onto an entry whose run ended while the scan was out', async () => {
    // A compose entry: the container sum does not depend on the pid, so only the run check stops it.
    const target: ComposeTarget = { key: 'project:web', project: 'web', configFiles: [] }
    const entry = liveEntry('web', 100, target)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const containers = new Map<string, ComposeReading>([['project:web', { cpuPercent: 40, rssBytes: 1024, processes: 2, containers: 1 }]])
    const scan = sampleResources([entry], sampler(async () => {
      await gate
      return new Map([[100, reading(100)]])
    }), { readings: () => containers } as unknown as DockerMetrics, 10_000)

    // A stop lands mid-scan: `endProcessReadings` bumps the token and clears the pid.
    entry.runToken += 1
    entry.pid = null
    release()
    await scan

    expect(entry.resources, 'a stopped entry must not keep the dead run’s CPU/RSS').toBeNull()
    expect(entry.resourcesFromContainers).toBe(false)
  })
})

describe('container readings for stacks due on different seconds', () => {
  it('asks docker about every live stack, not only the ones due this tick', async () => {
    const a: ComposeTarget = { key: 'project:a', project: 'a', configFiles: [] }
    const b: ComposeTarget = { key: 'project:b', project: 'b', configFiles: [] }
    const asked: string[][] = []
    const docker = {
      readings: (targets: ComposeTarget[]) => {
        asked.push(targets.map(target => target.key))
        return new Map<string, ComposeReading>()
      },
    } as unknown as DockerMetrics
    const first = liveEntry('a', 1, a)
    const second = liveEntry('b', 2, b)
    // `b` was sampled a moment ago, so only `a` is due.
    second.resourcesSampledAt = 9_000
    await sampleResources([first, second], sampler(async () => new Map()), docker, 10_000)

    expect(asked).toEqual([['project:a', 'project:b']])
  })
})
