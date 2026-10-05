import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreStoredBackup, restoreUploadedBackup } from '../src/lib/api'

/**
 * The panel speaks one error envelope — `{ message, code, detail }` — and the UI is what
 * turns it into something a person reads. The restore-by-upload path read `error` from
 * that envelope, which the envelope does not carry, so every refusal showed the generic
 * "restore failed with 400" instead of the panel's reason.
 *
 * These drive `fetch` directly: the existing dialog tests mock the api function, so
 * nothing at this layer was exercised.
 */

function stubJson(status: number, body: unknown): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('restore failures', () => {
  it('surfaces the panel\'s message from an uploaded restore that fails', async () => {
    stubJson(400, { message: 'the archive needs a password', code: 'BACKUP_PASSWORD_REQUIRED' })

    await expect(restoreUploadedBackup(new File(['x'], 'a.zip'), true))
      .rejects
      .toThrow('the archive needs a password')
  })

  it('still reports the plan\'s own reason when the archive is accepted but refuses', async () => {
    // A `RestorePlan` is a 200 with its own `error`, so that field stays a fallback.
    stubJson(200, { error: 'the archive has no manifest' })

    const plan = await restoreUploadedBackup(new File(['x'], 'a.zip'), true)
    expect(plan.error).toBe('the archive has no manifest')
  })

  it('falls back to the status when the body says nothing useful', async () => {
    stubJson(500, {})

    // The stored-backup path goes through the generic `request()` helper, which already
    // reads the envelope; an empty body leaves its own status line.
    await expect(restoreStoredBackup('x.zip', true)).rejects.toThrow(/request failed with 500/)
  })
})
