import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { passwordLengthVerdict } from '#src/cli/set-password'
import { controlSchema, proxyConfigSchema } from '#src/shared/contracts'

function settings(control: Record<string, unknown>, proxy: Record<string, unknown> = {}) {
  const parsedControl = controlSchema(control)
  const parsedProxy = proxyConfigSchema(proxy)
  if (parsedControl instanceof type.errors || parsedProxy instanceof type.errors)
    throw new Error('bad fixture')
  return { control: parsedControl, proxy: parsedProxy }
}

/**
 * A one-character password was stored without a word beyond "short", and the panel could then be
 * put on the LAN behind it. The exposure bar is 12 characters; `set-password` says so up front.
 */
describe('set-password and the length of what it stores', () => {
  it('refuses a short password while the config exposes the panel', async () => {
    const verdict = await passwordLengthVerdict('a', settings({ host: 'lan' }))
    expect(verdict.refusal).not.toBeNull()
    expect(verdict.refusal!).toContain('shorter than 12 characters')
  })

  it('refuses one while a proxy route serves the panel', async () => {
    const verdict = await passwordLengthVerdict('short', settings({}, { enabled: true, routes: [{ id: 'p', host: 'panel.example.com', target: 'panel' }] }))
    expect(verdict.refusal).not.toBeNull()
  })

  it('warns below 8 characters on a loopback panel, and notes the exposure bar below 12', async () => {
    const tiny = await passwordLengthVerdict('a', settings({}))
    expect(tiny.refusal).toBeNull()
    expect(tiny.warning).toContain('easy to guess')

    const middling = await passwordLengthVerdict('ninechars', settings({}))
    expect(middling.refusal).toBeNull()
    expect(middling.warning).toContain('at least 12')
  })

  it('says nothing about a long enough password', async () => {
    expect(await passwordLengthVerdict('a-long-enough-one', settings({ host: 'lan' }))).toEqual({ refusal: null, warning: null })
  })
})
