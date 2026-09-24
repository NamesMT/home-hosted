import { describe, expect, it } from 'vitest'
import { computeBackoff } from '#src/helpers/backoff'

const options = { baseDelayMs: 1000, factor: 2, maxDelayMs: 30000 }

describe('computeBackoff', () => {
  it('grows exponentially from the base delay', () => {
    expect([1, 2, 3, 4].map(attempt => computeBackoff(attempt, options)))
      .toEqual([1000, 2000, 4000, 8000])
  })

  it('caps at maxDelayMs', () => {
    expect(computeBackoff(20, options)).toBe(30000)
  })

  it('treats the first attempt as the base delay even for 0 or negative input', () => {
    expect(computeBackoff(0, options)).toBe(1000)
    expect(computeBackoff(-5, options)).toBe(1000)
  })
})
