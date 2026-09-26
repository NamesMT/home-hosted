import { type } from 'arktype'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { errorHandler } from '#src/helpers/error'
import { parseOrThrow } from '#src/helpers/validate'
import { validate } from '#src/helpers/validator'

/**
 * Two ways in: `validate()` is the middleware a route reads once, `parseOrThrow()` is
 * for a value read by hand. Both have to fail with the same envelope, or a client
 * cannot tell one rejection from another.
 */

const bodySchema = type({ 'name': 'string >= 1', 'count?': 'number' })
const strictSchema = type({ name: 'string >= 1' }).onUndeclaredKey('reject')

describe('validate middleware', () => {
  it('hands the handler the parsed value, not the raw json', async () => {
    const app = new Hono()
      .onError(errorHandler)
      .post('/', validate('json', bodySchema), c => c.json(c.req.valid('json')))

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web', count: 2 }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'web', count: 2 })
  })

  it('does not coerce a string into a number for a typed field', async () => {
    const app = new Hono()
      .onError(errorHandler)
      .post('/', validate('json', bodySchema), c => c.json(c.req.valid('json')))

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web', count: '2' }),
    })

    expect(response.status).toBe(400)
  })

  it('rejects an invalid body with the standard envelope and a per-field detail', async () => {
    const app = new Hono()
      .onError(errorHandler)
      .post('/', validate('json', bodySchema), c => c.json(c.req.valid('json')))

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', count: 'many' }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { message: string, detail: Array<{ path: string, message: string }> }
    expect(body.message).toBe('validation failed')
    expect(Array.isArray(body.detail)).toBe(true)
    expect(body.detail.every(issue => typeof issue.path === 'string' && typeof issue.message === 'string')).toBe(true)
    expect(body.detail.map(issue => issue.path)).toContain('count')
  })

  it('rejects a malformed json body rather than letting the handler see it', async () => {
    const app = new Hono()
      .onError(errorHandler)
      .post('/', validate('json', bodySchema), c => c.json(c.req.valid('json')))

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })

    expect(response.status).toBe(400)
  })

  it('validates a query string too', async () => {
    const querySchema = type({ 'serverId?': 'string', 'logs?': 'string' })
    const app = new Hono()
      .onError(errorHandler)
      .get('/', validate('query', querySchema), c => c.json(c.req.valid('query')))

    expect(await (await app.request('/?logs=0')).json()).toEqual({ logs: '0' })
  })

  it('keeps undeclared keys unless the schema asks for a rejection', async () => {
    // ArkType is permissive by default; only `.onUndeclaredKey('reject')` refuses one,
    // which is what the create/patch contracts opt into.
    const permissive = new Hono()
      .onError(errorHandler)
      .post('/', validate('json', bodySchema), c => c.json(c.req.valid('json')))
    const response = await permissive.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web', extra: 'kept' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'web', extra: 'kept' })

    const strict = new Hono()
      .onError(errorHandler)
      .post('/', validate('json', strictSchema), c => c.json(c.req.valid('json')))
    const rejected = await strict.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web', extra: 'refused' }),
    })

    expect(rejected.status).toBe(400)
  })
})

describe('parseOrThrow', () => {
  it('returns the parsed value on success', () => {
    expect(parseOrThrow<{ name: string }>(bodySchema, { name: 'web', count: 2 }, 'body')).toEqual({ name: 'web', count: 2 })
  })

  it('throws a DetailedError naming the label and every issue', () => {
    let thrown: unknown
    try {
      parseOrThrow(bodySchema, { name: '' }, 'request body')
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as Error & { code?: string, statusCode?: number, detail?: unknown }
    expect(error.name).toBe('DetailedError')
    expect(error.statusCode).toBe(400)
    expect(error.code).toBe('INVALID_INPUT')
    expect(error.message).toContain('request body')
    expect(Array.isArray(error.detail)).toBe(true)
  })
})
