import type { AppState } from '#src/shared/contracts'
import { type } from 'arktype'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appStateSchema, sseMessageSchema } from '#src/shared/contracts'
import { isStateShape, parseFrame, parseState } from '#src/shared/live-frames'
import { makeFixture, makeView } from '../api/fixture'

/**
 * A newer panel may send an enum value this UI has never heard of. The full schema refused the whole
 * frame for it — and every frame after it — so the UI froze on its last good frame. The client parser
 * keeps the envelope and the containers strict and lets an unknown leaf through as-is.
 */
let state: AppState
let cleanup: () => Promise<void>

beforeAll(async () => {
  const fixture = await makeFixture({ views: [makeView('web', { status: 'running' })] })
  cleanup = fixture.cleanup
  const response = await fixture.app.request('/api/state')
  state = await response.json() as AppState
})

afterAll(async () => {
  await cleanup()
})

function withStatus(status: string): AppState {
  const copy = structuredClone(state)
  ;(copy.workspaces[0]!.servers[0] as { status: string }).status = status
  return copy
}

describe('the lenient frame parser', () => {
  it('uses the full schema when the frame passes it', () => {
    expect(appStateSchema(state) instanceof type.errors).toBe(false)
    const parsed = parseFrame(JSON.stringify({ type: 'state', ts: 1, state }))
    expect(parsed?.lenient).toBe(false)
    expect(parseState(state)).not.toBeNull()
  })

  it('accepts a state frame carrying a status this UI does not know', () => {
    const frame = { type: 'state', ts: 1, state: withStatus('hibernating') }
    // The strict schema is unchanged: this is exactly the frame it refuses.
    expect(sseMessageSchema(frame) instanceof type.errors).toBe(true)

    const parsed = parseFrame(JSON.stringify(frame))
    expect(parsed?.lenient).toBe(true)
    expect(parsed?.frame.type).toBe('state')
    // The unknown value is carried as it came, for the UI to show.
    const servers = parsed?.frame.type === 'state' ? parsed.frame.state.workspaces[0]!.servers : []
    expect(servers[0]?.status).toBe('hibernating')
    expect(parseState(withStatus('hibernating'))?.workspaces[0]?.servers[0]?.status).toBe('hibernating')
  })

  it('accepts server and log frames with unknown leaves', () => {
    const server = { ...state.workspaces[0]!.servers[0]!, status: 'paused', health: 'degraded' }
    expect(parseFrame(JSON.stringify({ type: 'server', ts: 1, serverId: 'web', server }))?.lenient).toBe(true)
    const log = { type: 'log', ts: 1, workspaceId: 'default', serverId: 'web', lines: [{ ts: 1, stream: 'trace', text: 'hi' }] }
    expect(parseFrame(JSON.stringify(log))?.lenient).toBe(true)
  })

  it('still refuses a frame whose envelope or containers are wrong', () => {
    const bad = [
      'not json',
      JSON.stringify(null),
      JSON.stringify({ type: 'state', state }),
      JSON.stringify({ type: 'nope', ts: 1, state }),
      JSON.stringify({ type: 'state', ts: 1, state: { ...state, workspaces: {} } }),
      JSON.stringify({ type: 'state', ts: 1, state: { ...state, proxy: 'on' } }),
      JSON.stringify({ type: 'server', ts: 1, serverId: 'web', server: { id: 'web' } }),
      JSON.stringify({ type: 'server', ts: 1, workspaceId: 3, serverId: 'web', server: state.workspaces[0]!.servers[0] }),
      JSON.stringify({ type: 'log', ts: 1, serverId: 'web', lines: [{ ts: 1, text: 'no stream' }] }),
      JSON.stringify({ type: 'log', ts: 1, serverId: 'web', lines: 'x' }),
    ]
    for (const raw of bad)
      expect(parseFrame(raw), raw.slice(0, 60)).toBeNull()
    expect(parseState({ ...state, control: null })).toBeNull()
    expect(isStateShape([])).toBe(false)
  })
})
