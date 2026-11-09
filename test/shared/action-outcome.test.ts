import { describe, expect, it } from 'vitest'
import { runThenRefetch } from '#src/shared/action-outcome'

describe('runThenRefetch', () => {
  it('reports a successful action as successful when only the refresh failed', async () => {
    const run = await runThenRefetch(async () => 'saved', async () => {
      throw new Error('panel restarting')
    })
    expect(run.outcome).toEqual({ ok: true, value: 'saved' })
    expect(run.refetchError).toBeInstanceOf(Error)
    expect(run.actionError).toBeUndefined()
  })

  it('reports the action\'s own failure and skips the refresh', async () => {
    let refreshed = false
    const run = await runThenRefetch(async () => {
      throw new Error('port is held')
    }, async () => {
      refreshed = true
    })
    expect(run.outcome).toEqual({ ok: false, error: 'port is held' })
    expect(refreshed).toBe(false)
  })
})
