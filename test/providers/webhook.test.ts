import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { sendWebhook } from '#src/providers/webhook'

describe('a webhook URL built from the environment', () => {
  it('never reports the expanded secret, only the placeholder', async () => {
    process.env.HH_TEST_HOOK_SECRET = 's3cr3t-value'
    try {
      const failing: typeof fetch = async () => {
        throw new TypeError(`Failed to parse URL from https://hooks.example.com/s3cr3t-value/x`)
      }
      // eslint-disable-next-line no-template-curly-in-string -- the literal placeholder is the point
      const target = { url: 'https://hooks.example.com/${HH_TEST_HOOK_SECRET}/x', method: 'POST' as const, format: 'json' as const, headers: '' }
      const outcome = await sendWebhook(target, { serverId: 'web', label: 'Web', reason: 'crash', detail: 'x' } as never, failing)
      expect(outcome.ok).toBe(false)
      expect(outcome.error).not.toContain('s3cr3t-value')
      // eslint-disable-next-line no-template-curly-in-string -- the literal placeholder is the point
      expect(outcome.error).toContain('${HH_TEST_HOOK_SECRET}')
    }
    finally {
      delete process.env.HH_TEST_HOOK_SECRET
    }
  })
})
