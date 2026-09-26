import type { ApiErrorBody } from '#src/helpers/error'
import { DetailedError } from '@namesmt/utils'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { errorHandler } from '#src/helpers/error'

/**
 * The one error envelope the API speaks. Every case here is a shape a client can
 * receive, so the exact `code` and status are the contract.
 */

/**
 * Hono's own dispatch never hands a thrown *primitive* to `onError` (it rethrows, and
 * `app.request()` rejects — pinned below), so the primitive branches are only
 * reachable by invoking the handler directly.
 */
function direct(error: unknown): { status: number, body: ApiErrorBody } {
  let captured: { status: number, body: ApiErrorBody } | null = null
  const context = {
    req: { method: 'GET', url: 'http://127.0.0.1:3999/api/settings' },
    json: (body: ApiErrorBody, status: number) => {
      captured = { status, body }
      return captured
    },
  }
  errorHandler(error as Error, context as never)
  return captured!
}

function appThrowing(error: unknown): Hono {
  return new Hono().onError(errorHandler).get('/', () => {
    throw error
  })
}

async function throughHono(error: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
  const response = await appThrowing(error).request('/')
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** `isDetailedError` is a name check, so a hand-built object is a valid stand-in. */
function fakeDetailedError(fields: { statusCode?: unknown, code?: string, detail?: unknown }): Error {
  const error = new Error('settings rejected') as Error & Record<string, unknown>
  error.name = 'DetailedError'
  return Object.assign(error, fields)
}

describe('errorHandler over the wire', () => {
  it('maps an HTTPException to HTTP_EXCEPTION with its own status', async () => {
    const { status, body } = await throughHono(new HTTPException(401, { message: 'sign in first' }))
    expect(status).toBe(401)
    expect(body).toEqual({ message: 'sign in first', code: 'HTTP_EXCEPTION' })
  })

  it('carries the code and detail of a DetailedError', async () => {
    const { status, body } = await throughHono(new DetailedError('invalid token', {
      statusCode: 403,
      code: 'INVALID_TOKEN',
      detail: { field: 'token' },
    }))

    expect(status).toBe(403)
    expect(body).toEqual({ message: 'invalid token', code: 'INVALID_TOKEN', detail: { field: 'token' } })
  })

  it('turns a plain Error into INTERNAL_ERROR at 500', async () => {
    const { status, body } = await throughHono(new Error('something broke'))
    expect(status).toBe(500)
    expect(body).toEqual({ message: 'something broke', code: 'INTERNAL_ERROR' })
  })

  it('names a custom error by its class name', async () => {
    const { body } = await throughHono(new TypeError('not a function'))
    expect(body.code).toBe('TYPEERROR')
  })

  it('does not reach onError for a thrown primitive — Hono rethrows it', async () => {
    let caught: unknown = 'nothing was thrown'
    try {
      await appThrowing('just a string').request('/')
    }
    catch (error) {
      caught = error
    }

    expect(caught).toBe('just a string')
  })
})

describe('errorHandler branch by branch', () => {
  it('omits detail entirely when there is none', () => {
    const { status, body } = direct(fakeDetailedError({ statusCode: 400 }))
    expect(status).toBe(400)
    expect(body).toEqual({ message: 'settings rejected', code: 'DETAILED_ERROR' })
    expect('detail' in body).toBe(false)
  })

  it('stringifies a non-error, which only a direct call can produce', () => {
    expect(direct('just a string')).toEqual({ status: 500, body: { message: 'just a string', code: 'INTERNAL_ERROR' } })
    expect(direct(42)).toEqual({ status: 500, body: { message: '42', code: 'INTERNAL_ERROR' } })
    expect(direct(undefined)).toEqual({ status: 500, body: { message: 'undefined', code: 'INTERNAL_ERROR' } })
  })

  it('clamps a status that is not a real HTTP failure to 500', () => {
    for (const statusCode of [399, 600, 0, -1, 'teapot', undefined]) {
      expect(direct(fakeDetailedError({ statusCode })).status, String(statusCode)).toBe(500)
    }
  })

  it('keeps the boundary statuses a client can receive', () => {
    for (const statusCode of [400, 500, 599]) {
      expect(direct(fakeDetailedError({ statusCode })).status, String(statusCode)).toBe(statusCode)
    }
  })
})
