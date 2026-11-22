import type { Fixture } from './fixture'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * Every `/api` route the app mounts is in the published spec, and every documented path is mounted.
 *
 * `AGENTS.md` requires it — "Document every route (`describeRoute` + `jsonBody(schema)`)" — and the
 * product promise is that "the API, its SSE frames and its spec are the contract". Nothing checked it,
 * so a new route that forgot `describeRoute` would simply be absent from `/openapi/spec.json`: the
 * panel would serve it and no generated client would know it exists. The opposite drift is worse — a
 * path in the spec that nothing answers — because a generator emits a method that 404s.
 *
 * Compared in one spelling: the router writes `:id`, OpenAPI writes `{id}`.
 */
describe('the spec covers the routes the app mounts', () => {
  /** `:id` and `{id}` in one shape, so the two spellings can be compared. */
  const shape = (path: string): string => path
    .replaceAll(/\{([A-Z_]\w*)\}/gi, '<$1>')
    .replaceAll(/:([A-Z_]\w*)/gi, '<$1>')

  it('documents every /api route and mounts every documented one', async () => {
    const created = await fixture()
    try {
      const response = await created.app.request('/openapi/spec.json')
      expect(response.status).toBe(200)
      const spec = await response.json() as { paths: Record<string, Record<string, unknown>> }
      const documented = new Set(Object.keys(spec.paths).map(shape))

      /**
       * The routes the app answers, from the app's own route table.
       *
       * Reading `src/app.ts`'s mounts plus each factory's path literals rather than the spec is the
       * whole point: this is the independent side of the comparison.
       */
      const root = new URL('../../', import.meta.url)
      const read = (relative: string): string => readFileSync(new URL(relative, root), 'utf8')
      const app = read('src/app.ts')
      const imports = new Map(
        [...app.matchAll(/import \{ (\w+) \} from '#src\/api\/([\w/$.-]+)'/g)].map(match => [match[1]!, match[2]!]),
      )
      const mounts = new Map<string, string[]>()
      for (const match of app.matchAll(/\.route\('([^']+)',\s*(\w+)\(/g)) {
        const module = imports.get(match[2]!)
        if (module === undefined)
          continue
        const key = module.endsWith('/$.routes') ? module.slice(0, -9) : module
        mounts.set(key, [...(mounts.get(key) ?? []), match[1]!])
      }
      expect(mounts.size, 'the mount scan must find the /api factories').toBeGreaterThan(5)

      const mounted: string[] = []
      for (const file of readdirSync(new URL('src/api/', root), { recursive: true, withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.ts'))
          continue
        /**
         * `fileURLToPath`, not `new URL(...).pathname`.
         *
         * A `file:` URL's `.pathname` is **POSIX-shaped even on Windows** — `/C:/Users/runner/...`,
         * with a leading slash and forward slashes — while `path.join` returns `C:\Users\runner\...`.
         * `path.relative` between the two is nonsense: it produced a chain of `../../..` that matched
         * no factory, so the scan found **0 routes** on Windows while Linux found 57 and the whole
         * comparison passed vacuously.
         *
         * My first fix replaced backslashes with slashes, which treated the symptom and left the drive
         * letter and the leading slash in place. The `mounted.length` guard below is what kept printing
         * the real number until the cause was found.
         */
        const relative = path
          .relative(fileURLToPath(new URL('src/api/', root)), path.join(file.parentPath, file.name))
          // Normalised to `/` so the key compares against a module specifier written that way, on every
          // platform — `fileURLToPath` already gives the right separator, this makes it the same one.
          .replaceAll('\\', '/')
        const key = relative.replace(/\.ts$/, '').replace(/\/\$(\.routes)?$/, '').replace(/\$$/, '')
        const bare = key.endsWith('/$') ? key.slice(0, -2) : key
        const prefixes = mounts.get(key) ?? mounts.get(bare) ?? []
        if (prefixes.length === 0)
          continue
        const source = readFileSync(path.join(file.parentPath, file.name), 'utf8')
        // The calls are pretty-printed across lines, so the quote is not necessarily on the same line
        // as the verb — a `\s*'` alone matched nothing after `eslint --fix` reflowed them.
        for (const match of source.matchAll(/\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
          for (const prefix of prefixes)
            mounted.push(prefix.replace(/\/$/, '') + (match[2]!.startsWith('/') ? match[2]! : `/${match[2]!}`))
        }
      }
      expect(mounted.length, 'the route scan must find the /api routes').toBeGreaterThan(30)

      /**
       * A mount prefix plus an empty path (`''` or `'/'`) is the factory's own index route, which the
       * spec writes without the trailing slash: `/api/servers/` and `/api/servers` are the same route.
       */
      const tidy = (route: string): string => (route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route)
      const documentedTidy = new Set([...documented].map(tidy))
      const undocumented = [...new Set(mounted.map(tidy))].filter(route => !documentedTidy.has(shape(route)))
      /**
       * Three routes are not `/api` surface and are absent on purpose: the static-UI catch-all (`/*`),
       * the ACME challenge channel (`/_acme/...`, which has its own generated credentials and is
       * described in `docs/REVERSE_PROXY.md`), and `/api/*`, the API's own fall-through.
       */
      const notApiSurface = (route: string): boolean =>
        route === '/*' || route === '/api/*' || route.startsWith('/_acme')
      expect(
        undocumented.filter(route => !notApiSurface(route)),
        'a route is served but absent from the spec',
      ).toEqual([])

      const mountedShapes = new Set(mounted.map(route => shape(tidy(route))))
      const unmounted = [...documentedTidy].filter(route => route.startsWith('/api/') && !mountedShapes.has(route))
      expect(unmounted, 'the spec documents a path the app does not mount').toEqual([])
    }
    finally {
      await created.cleanup()
    }
  })
})

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

/**
 * Every operation publishes what an API token needs, as `x-required-scope`.
 *
 * The declaration is enforced in `src/middleware/token-scope.ts` and the document copies it, so a
 * generated client can show — or check — what a credential has to hold. An extension rather than a
 * standard field because OpenAPI's `security` names a *scheme*, and has no vocabulary for an
 * application-defined scope.
 */
describe('the spec publishes each route\'s token scope', () => {
  it('marks the routes a token can reach', async () => {
    const doc = await spec() as unknown as { paths: Record<string, Record<string, { 'x-required-scope'?: string }>> }
    // A read route, a lifecycle one, a config one and an admin one: the four scopes, each on a route
    // that genuinely needs it.
    expect(doc.paths['/api/state']!.get!['x-required-scope']).toBe('read')
    expect(doc.paths['/api/servers/{id}/start']!.post!['x-required-scope']).toBe('lifecycle')
    expect(doc.paths['/api/servers/{id}']!.patch!['x-required-scope']).toBe('config')
    expect(doc.paths['/api/auth/accounts']!.post!['x-required-scope']).toBe('admin')
  })

  /**
   * A **public** operation declares no scope, because it wants no credential.
   *
   * `tokenScopesFor` classifies by method and path, and answers `read` for the three `/api/auth/*`
   * routes that `PUBLIC_API_PATHS` opens. They already carried `security: []`, so the document said
   * "no credential" and "needs `read`" about the same operation — a generated client would be told to
   * send one to an endpoint that does not want it. Measured before the fix: `POST /api/auth/login` had
   * `security: []` beside `x-required-scope: read`.
   */
  it('declares no scope on a public operation, which needs no credential', async () => {
    const doc = await spec() as unknown as { paths: Record<string, Record<string, { 'security'?: unknown[], 'x-required-scope'?: string }>> }
    for (const [route, method] of [['/api/auth/login', 'post'], ['/api/auth/session', 'get'], ['/api/auth/logout', 'post'], ['/healthz', 'get']] as const) {
      const operation = doc.paths[route]![method]!
      expect(operation.security, `${method} ${route} must be open`).toEqual([])
      expect(operation['x-required-scope'], `${method} ${route} needs no scope, so it must declare none`).toBeUndefined()
    }
  })

  it('leaves a local-channel route unmarked, since a token never reaches it', async () => {
    const doc = await spec() as unknown as { paths: Record<string, Record<string, { 'x-required-scope'?: string }>> }
    // `/_hh` is guarded by the run.json token plus loopback, not by an API token.
    expect(doc.paths['/_hh/servers']!.get!['x-required-scope']).toBeUndefined()
  })
})
