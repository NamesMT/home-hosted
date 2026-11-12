import { describe, expect, it, vi } from 'vitest'

/**
 * A failed `vm_stat` must not cost a synchronous spawn.
 *
 * `sampleHost` reads `vm_stat` asynchronously and hands the parser `''` when it fails. The parser
 * resolved the page size first, and with no header in `''` it asked `getconf` through
 * `execFileSync` — on the sample path that builds the frame — for a reading with nothing to count.
 */
const spawned = vi.hoisted(() => ({ sync: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    execFileSync: (...args: Parameters<typeof original.execFileSync>) => {
      spawned.sync += 1
      return original.execFileSync(...args)
    },
  }
})

const { macAvailableBytes } = await import('#src/providers/host')

describe('a vm_stat reading with nothing in it', () => {
  it('answers no reading without spawning for a page size', () => {
    expect(macAvailableBytes('')).toBeNull()
    expect(spawned.sync, 'no getconf for a reading that cannot exist').toBe(0)
  })
})
