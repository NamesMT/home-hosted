import type { ServerConfig } from '#src/shared/contracts'
import type { ServerEditForm } from '#src/shared/server-form'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { serverPatchSchema, serverSchema } from '#src/shared/contracts'
import { liveConfigUpdate, serverEditForm, serverEditPatch, serverEditPayload } from '#src/shared/server-form'

function config(overrides: Record<string, unknown> = {}): ServerConfig {
  const parsed = serverSchema({ id: 'web', command: 'node', port: 4000, ...overrides })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return { ...parsed, port: parsed.port ?? null } as ServerConfig
}

describe('the shared server edit form', () => {
  it('round-trips an untouched entry to an empty patch', () => {
    const filled = config({
      label: 'Web',
      health: { http: { expectStatus: 204 } },
      bootstrap: { command: 'install.sh', timeoutMs: 1500 },
      dump: { command: 'mongodump', waitMs: 9000 },
    })
    expect(serverEditPatch(serverEditForm(filled), filled)).toEqual({})
  })

  /**
   * The console read every box with `Number(...)`: a cleared `grace (ms)` saved `0`, an instant
   * SIGKILL on the next stop; cleared retries saved `0`, and a cleared `healthy below` saved `0`,
   * which no response satisfies.
   */
  it('treats a cleared box as "nothing decided", never as 0', () => {
    const filled = config({ stop: { graceMs: 8000 }, restart: { maxRetries: 4 } })
    const form: ServerEditForm = serverEditForm(filled)
    form.stop.graceMs = ''
    form.restart.maxRetries = ''
    form.health.http.expectStatusBelow = ''
    form.logBufferLines = ''
    form.health.intervalMs = Number.NaN

    expect(serverEditPatch(form, filled)).toEqual({})
    const payload = serverEditPayload(form, filled)
    expect((payload.stop as { graceMs: number }).graceMs).toBe(8000)
    expect((payload.restart as { maxRetries: number }).maxRetries).toBe(4)
  })

  it('reads string boxes and keeps blanks that mean something', () => {
    const filled = config({ health: { http: { expectStatus: 204 } }, resources: { maxRssBytes: 512 * 1024 * 1024 } })
    const form: ServerEditForm = serverEditForm(filled)
    form.stop.graceMs = '250'
    form.port = ''
    form.maxRssMb = ''
    form.health.http.expectStatus = ''

    expect(serverEditPatch(form, filled)).toEqual({
      stop: { graceMs: 250 },
      port: null,
      resources: { maxRssBytes: 0 },
      health: { http: { ...filled.health.http, expectStatus: null } },
    })
  })

  it('edits the hook timeouts in seconds, keeping the group whole', () => {
    const filled = config({ load: { command: 'mongorestore', timeoutMs: 600_000, waitMs: 9000 } })
    const form: ServerEditForm = serverEditForm(filled)
    expect(form.load.timeoutSeconds).toBe(600)
    expect(form.bootstrap.timeoutSeconds).toBe(120)

    form.load.timeoutSeconds = '30'
    form.dump = { enabled: true, command: 'mongodump', args: '--archive\n{dumpDir}/db', env: '', timeoutSeconds: '' }
    const patch = serverEditPatch(form, filled)

    expect(patch.load).toEqual({ command: 'mongorestore', args: [], env: {}, timeoutMs: 30_000, waitMs: 9000 })
    // A cleared box on a new hook is the default, not 0 (which the schema refuses).
    expect(patch.dump).toEqual({ command: 'mongodump', args: ['--archive', '{dumpDir}/db'], env: {}, timeoutMs: 600_000 })
    expect(serverPatchSchema(serverEditPayload(form, filled)) instanceof type.errors).toBe(false)
  })

  it('diffs against the filled snapshot, so a change made elsewhere is not reverted', () => {
    const filled = config({ label: 'old' })
    const form: ServerEditForm = serverEditForm(filled)
    form.command = 'bun'

    // Another client renamed the entry after this form was filled.
    expect(serverEditPatch(form, filled)).toEqual({ command: 'bun' })
  })
})

describe('liveConfigUpdate', () => {
  const filled = config()

  it('ignores a frame that only re-created the same config', () => {
    expect(liveConfigUpdate(config(), filled, true)).toBe('keep')
  })

  it('refills a clean form, and keeps a dirty one with a notice', () => {
    const moved = config({ label: 'renamed' })
    expect(liveConfigUpdate(moved, filled, false)).toBe('refill')
    expect(liveConfigUpdate(moved, filled, true)).toBe('notice')
  })
})
