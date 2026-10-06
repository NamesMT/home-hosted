import { describe, expect, it } from 'vitest'
import { missingServer, statusForAction } from '#src/helpers/action-result'

/**
 * The status a per-server action answers with: 404 when the entry does not exist, 409 when it exists
 * but cannot act (disabled, stopping, port busy).
 *
 * The distinction decides what a client does next — 404 means "fix the id", 409 means "retry or
 * change the entry" — and it was made by `error.startsWith('unknown server')`, i.e. by matching the
 * message text. Two other places in the repo make the same decision the same way.
 */
describe('statusForAction', () => {
  it('is 200 for a success', () => {
    expect(statusForAction({ ok: true })).toBe(200)
  })

  it('is 404 for an id that names nothing', () => {
    // The marker is what carries the meaning — the message alone is not a discriminator.
    expect(statusForAction(missingServer('web'))).toBe(404)
    expect(missingServer('web').error).toBe('unknown server "web"')
  })

  it('is 409 for an entry that exists but cannot act', () => {
    for (const error of [
      'server "web" is disabled',
      'server "web" is stopping',
      'server "web" has no port configured',
      'server "web" is busy — try again in a moment',
      'nothing is listening on port 4010 any more',
    ])
      expect(statusForAction({ ok: false, error }), error).toBe(409)
  })

  /**
   * The case that made the message match wrong: any *other* failure whose text happens to begin with
   * those words became a 404, telling the client to fix an id that is fine. A code that carries the
   * meaning is what the rule needs, not a prefix.
   */
  it('does not read a different failure as a missing server', () => {
    for (const error of [
      'unknown serverless runtime requested',
      'unknown server state: "draining"',
    ])
      expect(statusForAction({ ok: false, error }), error).toBe(409)
  })

  it('is 409 for a failure with no message at all', () => {
    expect(statusForAction({ ok: false })).toBe(409)
  })
})
