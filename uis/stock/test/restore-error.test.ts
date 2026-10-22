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

  /**
   * An upload carries both directions of the selection, the way a stored restore does.
   *
   * The two upload helpers were byte-identical copies in each UI and each carried only `include`,
   * so a restore from a file could tick items but never say "everything except the credentials" —
   * the shape the docs recommend for an archive that moves between machines. Asserted on the
   * `FormData` the request really sends, since a multipart body is where a dropped field hides.
   */
  it('sends both selection directions on an uploaded restore', async () => {
    let sent: FormData | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = init.body as FormData
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await restoreUploadedBackup(new File(['x'], 'a.zip'), true, {
      include: ['workspace:default'],
      exclude: ['workspace:default:secrets'],
    })

    expect(sent).not.toBeNull()
    expect(sent!.get('exclude')).toBe('["workspace:default:secrets"]')
    expect(sent!.get('include')).toBe('["workspace:default"]')
    // The file itself still travels, and `password` stays a plain string.
    expect(sent!.get('file')).toBeInstanceOf(File)
  })

  /** An empty list is a mistake the caller must see, not a key silently dropped. */
  it('refuses an empty selection before sending anything', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await expect(restoreUploadedBackup(new File(['x'], 'a.zip'), true, { exclude: [] }))
      .rejects
      .toThrow('nothing is excluded')
    expect(calls, 'nothing may be sent for a selection that names nothing').toEqual([])
  })
})
