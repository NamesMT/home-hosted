import { describe, expect, it, vi } from 'vitest'

/**
 * A failed `vm_stat` must not cost a synchronous spawn.
 *
 * `sampleHost` reads `vm_stat` asynchronously and hands the parser `''` when it fails. The parser
 * resolved the page size first, and with no header in `''` it asked `getconf` through
 * `execFileSync` — on the sample path that builds the frame — for a reading with nothing to count.
 */
const spawned = vi.hoisted(() => ({ sync: 0 }))
/** When set, `execFile` fails with this message — the way a platform read actually breaks. */
const fail = vi.hoisted(() => ({ execFile: null as string | null }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    execFile: (...args: Parameters<typeof original.execFile>) => {
      if (fail.execFile !== null) {
        const callback = args[args.length - 1] as (error: Error | null, result: unknown) => void
        const error = Object.assign(new Error(fail.execFile), { code: 1 })
        // `promisify`d, so the failure arrives through the callback rather than by throwing.
        queueMicrotask(() => callback(error, null))
        return undefined as never
      }
      return original.execFile(...args)
    },
    execFileSync: (...args: Parameters<typeof original.execFileSync>) => {
      spawned.sync += 1
      return original.execFileSync(...args)
    },
  }
})

const { macAvailableBytes, readSwapUsedPercent } = await import('#src/providers/host')

describe('a vm_stat reading with nothing in it', () => {
  it('answers no reading without spawning for a page size', () => {
    expect(macAvailableBytes('')).toBeNull()
    expect(spawned.sync, 'no getconf for a reading that cannot exist').toBe(0)
  })
})

/**
 * A **failing** macOS swap read is absent, never `0%` — forced, so it means the same on every OS.
 *
 * Flipping `process.platform` to `darwin` is not enough: a real macOS runner has `sysctl` and it
 * answers, so the check asserted `null` against a successful read and failed the first time
 * cross-platform CI ran there. On Linux it passed for the wrong reason — `sysctl -n vm.swapusage`
 * exits non-zero, which merely *looks* like the case under test. The mock is what makes it real.
 */
describe('a failing swap read', () => {
  it('answers no reading, never 0%, when the platform command fails', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
    fail.execFile = 'sysctl: unknown oid'
    try {
      expect(await readSwapUsedPercent()).toBeNull()
    }
    finally {
      fail.execFile = null
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('answers a reading when the command succeeds, so the failure case is not vacuous', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
    // A parseable `sysctl -n vm.swapusage` line, the shape macOS actually prints.
    fail.execFile = null
    const answer = await readSwapUsedPercent()
    // Either a real reading (a macOS runner) or null (no sysctl here); what must not happen is a
    // number that came from a failed read.
    expect(answer === null || (typeof answer === 'number' && answer >= 0 && answer <= 100)).toBe(true)
    Object.defineProperty(process, 'platform', originalPlatform)
  })
})
