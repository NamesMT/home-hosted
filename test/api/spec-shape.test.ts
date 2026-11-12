import type { Fixture } from './fixture'
import { afterAll, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

/**
 * The published spec has to be usable by a code generator, not only by a reader.
 *
 * Every response schema was inlined — `serverViewSchema` appeared hundreds of times in full — so
 * `openapi-typescript` produced one anonymous type per route and a generated client had no name for
 * the shape it was handed. A `oneOf` SSE stream, a multipart body and a cookie scheme were absent for
 * the same reason: the document described what a route *returns*, not how to call it.
 *
 * Each case here names the generator feature it protects, so a future "cleanup" of the spec fails
 * with the reason rather than a bare diff.
 */

const fixtures: Fixture[] = []

async function fixture(): Promise<Fixture> {
  const created = await makeFixture({ views: [makeView('web')] })
  fixtures.push(created)
  return created
}

afterAll(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

interface Content {
  schema?: unknown
}
interface Operation {
  parameters?: Array<{ in: string, name: string, schema?: unknown }>
  requestBody?: { content?: Record<string, Content> }
  responses: Record<string, { content?: Record<string, Content>, headers?: Record<string, unknown> }>
  security?: Array<Record<string, unknown>>
}
interface Spec {
  components?: { schemas?: Record<string, unknown>, securitySchemes?: Record<string, unknown> }
  paths: Record<string, Record<string, Operation>>
  security?: Array<Record<string, unknown>>
}

async function spec(): Promise<Spec> {
  const created = await fixture()
  return await (await created.app.request('/openapi/spec.json')).json() as Spec
}

/** Every `$ref` string anywhere in a value. */
function refs(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node === null || typeof node !== 'object')
      return
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref' && typeof child === 'string')
        found.push(child)
      else
        walk(child)
    }
  }
  walk(value)
  return found
}

describe('the published spec is usable by a code generator', () => {
  it('names the shapes a client repeats', async () => {
    const doc = await spec()
    const names = Object.keys(doc.components?.schemas ?? {})
    for (const name of ['ServerView', 'AppState', 'ErrorEnvelope', 'ActionResult', 'SseMessage'])
      expect(names, `components.schemas must declare ${name}`).toContain(name)
  })

  it('references those components instead of inlining them again', async () => {
    const doc = await spec()
    const found = refs(doc.paths)
    // The point of the exercise: a server view is one named type, referenced by every route that
    // returns one, rather than an anonymous copy per route.
    expect(found, 'a ServerView must be a $ref').toContain('#/components/schemas/ServerView')
    expect(found, 'an error envelope must be a $ref').toContain('#/components/schemas/ErrorEnvelope')
    expect(found.filter(ref => ref === '#/components/schemas/ServerView').length).toBeGreaterThan(3)
  })

  it('declares the cookie session beside the bearer token', async () => {
    const doc = await spec()
    const schemes = doc.components?.securitySchemes ?? {}
    expect(Object.keys(schemes)).toEqual(expect.arrayContaining(['bearerAuth', 'sessionCookie', 'localToken']))
    expect(schemes.sessionCookie).toMatchObject({ in: 'cookie', name: 'hh_session' })
    // Both are offered at the document level, so a generated client can pick.
    expect(doc.security).toEqual(expect.arrayContaining([{ bearerAuth: [] }, { sessionCookie: [] }]))
  })

  it.each(['/api/events', '/api/servers/{id}/stream'])('describes %s as an event stream with discriminated frames', async (route) => {
    const doc = await spec()
    const response = doc.paths[route]!.get!.responses['200']!
    // A generated client needs the media type to know it is not JSON.
    expect(Object.keys(response.content ?? {}), `${route} must declare its media type`).toContain('text/event-stream')
    const schema = response.content!['text/event-stream']!.schema as { oneOf?: unknown[], discriminator?: { propertyName: string } }
    expect(schema.oneOf, `${route} must describe the frames`).toBeInstanceOf(Array)
    expect(schema.oneOf!.length).toBeGreaterThan(1)
    expect(schema.discriminator?.propertyName).toBe('type')
  })

  it('declares the UI upload as a multipart file body', async () => {
    const doc = await spec()
    const body = doc.paths['/api/settings/ui']!.post!.requestBody
    expect(body, 'the upload route must document its body').toBeDefined()
    const multipart = body!.content?.['multipart/form-data'] as { schema?: { properties?: Record<string, unknown>, required?: string[] } }
    expect(multipart, 'the upload is multipart/form-data').toBeDefined()
    expect(multipart.schema?.properties).toHaveProperty('file')
    expect(multipart.schema?.required).toContain('file')
  })

  it.each([
    ['/api/metrics', 'text/plain'],
    ['/api/logs/{id}/download', 'application/x-ndjson'],
    ['/api/backups/{name}/download', 'application/zip'],
  ])('gives %s a content type', async (route, type) => {
    const doc = await spec()
    const content = doc.paths[route]!.get!.responses['200']!.content ?? {}
    expect(Object.keys(content), `${route} must name its media type`).toContain(type)
  })
})

/**
 * Response enums stay open.
 *
 * `status` and `health` are closed schemas the panel stores, but they are published as **response**
 * enums too — so a generated client types `status` as a union of today's values and refuses the frame
 * a newer panel sends after a minor upgrade. Response fields are additive by contract
 * (`COMPATIBILITY.md`), so a closed response enum turns a compatible upgrade into a parse error in
 * exactly the clients this project exists to serve.
 *
 * OpenAPI has no "may grow" keyword, so each string enum carries `x-extensible-enum` beside its
 * `enum`; a request body keeps its closed enum, because a value the panel does not know is a `400`.
 */
describe('response enums are extensible, request enums are not', () => {
  interface Marked { 'enum'?: unknown[], 'x-extensible-enum'?: unknown }

  /** Every node under `value` that carries a string `enum`. */
  function enumsUnder(value: unknown): Marked[] {
    const found: Marked[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node === null || typeof node !== 'object')
        return
      const record = node as Record<string, unknown>
      if (Array.isArray(record.enum) && record.enum.every(entry => typeof entry === 'string'))
        found.push(record as Marked)
      Object.values(record).forEach(walk)
    }
    walk(value)
    return found
  }

  it('widens the enums in a response', async () => {
    const doc = await spec()
    // Through the named component: the response is a `$ref` to `ServerView`, which is where the
    // `status` enum actually lives now that the repeats are components.
    const serverView = (doc.components?.schemas as Record<string, unknown> | undefined)?.ServerView
    expect(serverView, 'ServerView must be a named component').toBeDefined()
    const marked = enumsUnder(serverView)
    expect(marked.length, 'the server view must carry an enum to guard').toBeGreaterThan(0)
    for (const node of marked) {
      expect(node['x-extensible-enum'], `enum ${JSON.stringify(node.enum)} must be extensible`).toEqual(node.enum)
    }
    // The one that matters by name: a newer panel's `status` must not be a parse error.
    const status = (serverView as { properties: { status: Marked } }).properties.status
    expect(status.enum).toContain('running')
    expect(status['x-extensible-enum']).toEqual(status.enum)
  })

  it('leaves a request body enum closed', async () => {
    const doc = await spec()
    const patch = doc.paths['/api/servers/{id}']!.patch!.requestBody
    const marked = enumsUnder(patch)
    expect(marked.length, 'a request schema must carry an enum to guard').toBeGreaterThan(0)
    for (const node of marked)
      expect(node['x-extensible-enum'], 'a request enum is genuinely closed').toBeUndefined()
  })
})
