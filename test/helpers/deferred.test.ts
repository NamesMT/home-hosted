import { describe, expect, it } from 'vitest'
import { afterResponse } from '#src/helpers/deferred'

/** Lets the `setImmediate` the helper schedules run, plus the microtask it awaits. */
function drain(): Promise<void> {
  return new Promise(resolve => setImmediate(() => setImmediate(resolve)))
}

describe('afterResponse', () => {
  it('runs the task after the current turn rather than inline', async () => {
    const order: string[] = []
    afterResponse(async () => {
      order.push('task')
    })
    order.push('sync')

    expect(order).toEqual(['sync'])
    await drain()
    expect(order).toEqual(['sync', 'task'])
  })

  it('hands a failure to the caller instead of rejecting', async () => {
    let seen: unknown
    afterResponse(async () => {
      throw new Error('rebind failed')
    }, (error) => {
      seen = error
    })

    await drain()
    expect(seen).toBeInstanceOf(Error)
    expect((seen as Error).message).toBe('rebind failed')
  })

  it('stays quiet when a failure has no handler, rather than crashing the process', async () => {
    afterResponse(async () => {
      throw new Error('nobody is listening')
    })

    await drain()
  })
})
