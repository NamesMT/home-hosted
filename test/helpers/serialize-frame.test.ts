import { describe, expect, it, vi } from 'vitest'
import { serializeFrame } from '#src/helpers/event-stream'

/**
 * The hub hands every open stream the same message object, and the state frame — the whole panel —
 * was stringified once per tab, every second. It is serialised once per published frame now.
 */
describe('a frame published to several streams', () => {
  it('is serialised once, not once per subscriber', () => {
    const frame = { type: 'state', ts: 1, state: { big: 'x'.repeat(1000) } }
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      const first = serializeFrame(frame)
      const second = serializeFrame(frame)
      expect(second).toBe(first)
      expect(stringify).toHaveBeenCalledTimes(1)
      // A new frame is its own text.
      const next = { ...frame, ts: 2 }
      expect(serializeFrame(next)).toContain('"ts":2')
    }
    finally {
      stringify.mockRestore()
    }
  })
})
