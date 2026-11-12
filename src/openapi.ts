import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Hono } from 'hono'
import { describeRoute, generateSpecs } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { appVersion } from '#src/helpers/version'
import { PUBLIC_API_PATHS } from '#src/middleware/auth'
import { tokenScopesFor } from '#src/middleware/token-scope'
import { openApiReferencePage } from '#src/openapi-reference'
import { actionResultSchema, apiErrorSchema, appStateSchema, serverViewSchema, sseLogFrameSchema, sseMessageSchema, ssePingFrameSchema, sseServerFrameSchema, sseStateFrameSchema } from '#src/shared/contracts'

const PREFIX = '/openapi'

/**
 * The shapes a client needs **by name**.
 *
 * Every response schema was inlined, so `serverViewSchema` appeared ~250 times in full and
 * `openapi-typescript` produced one anonymous 90-line type per route — no two of them comparable,
 * and no way for a generator to name the type it writes. A generator wants the repeats to be a
 * `$ref` to one named component.
 *
 * These are **derived from the contracts, never re-declared**: each entry is the schema
 * `contracts.ts` exports, rendered through the same pipeline a route's `jsonBody` takes, and
 * `liftNamedSchemas` replaces every byte-identical inline occurrence with a `$ref`. A field added to
 * `serverViewSchema` therefore reaches the spec once, and a hand-written parallel definition — the
 * shape that drifts — never exists.
 */
const NAMED_SCHEMA_SOURCES: Record<string, StandardSchemaV1> = {
  ServerView: serverViewSchema,
  AppState: appStateSchema,
  ErrorEnvelope: apiErrorSchema,
  ActionResult: actionResultSchema,
  // One entry per frame, not just the union: a generator needs a name for each arm of the stream's
  // `oneOf`, and `SseMessage` stays for a reader who wants the whole set in one place.
  SseMessage: sseMessageSchema,
  SseStateFrame: sseStateFrameSchema,
  SseServerFrame: sseServerFrameSchema,
  SseLogFrame: sseLogFrameSchema,
  SsePingFrame: ssePingFrameSchema,
}

/**
 * Each named schema as the spec renders it.
 *
 * Rendered by asking hono-openapi to document a throwaway route whose only job is to carry the
 * schema, so the component is produced by the exact conversion the routes use — not by a second
 * call to `toJsonSchema()` that a library upgrade could change underneath us.
 */
async function renderNamedSchemas(): Promise<Record<string, unknown>> {
  const rendered: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(NAMED_SCHEMA_SOURCES)) {
    // Through a real `describeRoute`, because that is the path a route's `jsonBody` takes: the
    // resolver is invoked when the route is described, and injecting the document by hand leaves the
    // schema as `{ vendor: 'arktype' }` — measured while writing this.
    const app = new Hono().get(
      '/component',
      describeRoute({ responses: { 200: { description: name, content: jsonBody(schema) } } }),
      c => c.json({}),
    )
    const spec = await generateSpecs(app, { documentation: { info: { title: 'component', version: '1' } } })
    const documented = spec as unknown as {
      paths?: Record<string, { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } }>
    }
    rendered[name] = documented.paths?.['/component']?.get?.responses?.['200']?.content?.['application/json']?.schema
  }
  return rendered
}

/**
 * Replaces every inline occurrence of a named shape with a `$ref` to its component.
 *
 * Deep equality, not a marker. The two occurrences of `serverViewSchema` in one document are
 * byte-identical — `resolver()` renders the same schema the same way every time (verified) — and that
 * equality is what this walks on. A schema that is *nearly* `ServerView` stays inline rather than
 * silently borrowing its name, which is the failure a name-by-convention scheme would have.
 */
function liftNamedSchemas(spec: Record<string, unknown>, rendered: Record<string, unknown>): void {
  const refs = new Map<string, string>()
  for (const [name, schema] of Object.entries(rendered)) {
    if (schema !== undefined)
      refs.set(JSON.stringify(schema), `#/components/schemas/${name}`)
  }

  const components = (spec.components ??= {}) as Record<string, unknown>
  const schemas = (components.schemas ??= {}) as Record<string, unknown>
  for (const [name, schema] of Object.entries(rendered)) {
    if (schema !== undefined)
      schemas[name] = schema
  }

  const lift = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(lift)
    if (value === null || typeof value !== 'object')
      return value
    // Never rewrite a node that is already a reference, and never inside `components` (the entries
    // there are the definitions themselves).
    if (typeof (value as { $ref?: unknown }).$ref === 'string')
      return value
    const target = refs.get(JSON.stringify(value))
    if (target !== undefined)
      return { $ref: target }
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value))
      out[key] = lift(child)
    return out
  }

  const paths = (spec.paths ?? {}) as Record<string, unknown>
  for (const [route, item] of Object.entries(paths))
    paths[route] = lift(item)
}

/**
 * The machine-readable contract, generated from the same ArkType schemas the
 * routes validate with — one source of truth, no second set of DTOs to drift.
 * `/openapi/ui` is the browsable reference and needs no session, since a UI
 * author has to be able to read it before they can log in.
 */
export function setupOpenAPI(app: Parameters<typeof generateSpecs>[0]) {
  let spec: Record<string, unknown> | undefined
  return appFactory.createApp()
    .get(
      `${PREFIX}/spec.json`,
      async (c) => {
        spec ??= finishSpec(await generateSpecs(app, {
        /**
         * The `400` every validated route gets, written as this server's own envelope.
         *
         * hono-openapi injects its own default on any operation that has a validator and does not
         * name a `400`: `{ success: false, error: [], data }`. This API has never sent that shape —
         * `src/helpers/error.ts` maps every failure through one `DetailedError` envelope,
         * `{ message, code, detail }`, which is what AGENTS.md promises and what a client parses.
         * Measured on 29 operations: `GET /api/servers`, `POST /api/servers/{id}/start`, every
         * `/_hh` lifecycle route, `GET /api/logs/{id}`. The document described a body no successful
         * client would ever see, and every generated client was typed against it.
         *
         * Spelled as a resolved JSON schema rather than `ERROR_RESPONSES[400]`: this option takes
         * an OpenAPI response object, not a Standard Schema, and `apiErrorSchema` is what that
         * envelope is defined by (`test/api/panel.test.ts` pins the two together).
         */
          defaultValidationErrorResponse: {
            description: ERROR_RESPONSES[400].description,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    code: { type: 'string' },
                    detail: {},
                  },
                  required: ['message', 'code'],
                },
              },
            },
          },
          documentation: {
            info: {
              title: 'home-hosted',
              version: appVersion(),
              description: 'Control plane for the processes you host at home: servers, logs, vitals, backups and settings.',
            },
            tags: [
              { name: 'panel', description: 'Snapshot, health and the local shutdown channel' },
              { name: 'servers', description: 'The processes being supervised' },
              { name: 'logs', description: 'Live and persisted logs' },
              { name: 'workspaces', description: 'The ownership boundary: one scope per setup' },
              { name: 'backups', description: 'Archives of config, secrets, TLS and data paths' },
              { name: 'auth', description: 'Sessions and the panel password' },
              { name: 'notifications', description: 'Telegram delivery and webhook destinations' },
              { name: 'ddns', description: 'Dynamic DNS accounts and hostnames' },
              { name: 'proxy', description: 'The reverse proxy: engine, routes and certificates' },
              { name: 'tls', description: 'The panel certificate' },
            ],
            /**
             * Both credentials a `/api` route accepts, declared so a generated client can be told how
             * to send one.
             *
             * The bearer scheme shipped alone, and a browser client had no way to say it sends a
             * cookie: `openapi-typescript`, `openapi-generator` and Scalar's "try it" all produced
             * clients with no auth hook, and the README tells an agent this document *is* the API it
             * may call. The cookie is what the served UI uses, so leaving it out described only half
             * the API's authentication.
             */
            components: {
              securitySchemes: {
                bearerAuth: {
                  type: 'http',
                  scheme: 'bearer',
                  description: 'An API token from `home-hosted set-token --generate`. It never expires.',
                },
                sessionCookie: {
                  type: 'apiKey',
                  in: 'cookie',
                  name: 'hh_session',
                  description: 'The session cookie `POST /api/auth/login` sets — what the served UI sends. A cookie-authenticated write must be same-origin; the session-only routes need this rather than a token.',
                },
                localToken: {
                  type: 'apiKey',
                  in: 'header',
                  name: 'x-home-hosted-token',
                  description: 'The local control channel: the token in `run.json`, from a loopback caller only.',
                },
              },
            },
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            servers: [{ url: '/', description: 'This panel' }],
          },
        }, c) as unknown as Record<string, unknown>, await renderNamedSchemas())
        return c.json(spec)
      },
    )
    .get(
      `${PREFIX}/ui`,
      // A page that works with no internet, with the CDN browser as optional enhancement — see
      // `src/openapi-reference.ts` for why `Scalar()` alone was blank on the box this ships to.
      c => c.html(openApiReferencePage(`${PREFIX}/spec.json`)),
    )
}

/** Routes answered without any credential: the guard's own list, plus the liveness probe. */
const PUBLIC_OPERATIONS = new Set(['/healthz', ...PUBLIC_API_PATHS])

const ERROR_BODY = {
  'application/json': {
    schema: {
      type: 'object',
      properties: { message: { type: 'string' }, code: { type: 'string' }, detail: {} },
      required: ['message', 'code'],
    },
  },
}

/**
 * Marks every closed string enum as extensible.
 *
 * `status` and `health` are closed **request** schemas — the panel only ever stores those values — but
 * they are published as response enums too, so a generated client types `status` as a four-value
 * union and refuses the frame a newer panel sends after a minor upgrade. That is backwards: response
 * fields are additive by contract (`COMPATIBILITY.md`), and a closed enum on the response side turns
 * a compatible upgrade into a parse error in exactly the clients this project exists to serve.
 *
 * OpenAPI has no "this enum may grow" keyword, so each gets `x-extensible-enum` beside its `enum`:
 * a client generator that understands the extension emits a wider type, and one that does not still
 * sees the currently valid values. Applied to **every** string enum in a response, because the rule is
 * about the wire, not about two names — a new status or a new proxy route state is the same change.
 */
function markExtensibleEnums(node: unknown, insideRequest = false): void {
  if (Array.isArray(node)) {
    for (const child of node)
      markExtensibleEnums(child, insideRequest)
    return
  }
  if (node === null || typeof node !== 'object')
    return
  const record = node as Record<string, unknown>
  if (!insideRequest && Array.isArray(record.enum) && record.enum.every(value => typeof value === 'string'))
    record['x-extensible-enum'] = record.enum
  for (const [key, child] of Object.entries(record)) {
    // A request body is the panel's input, and there the enum is genuinely closed: a value it does
    // not know is a `400` today, so publishing it as extensible would invite a request that fails.
    const requestBody = key === 'requestBody'
    markExtensibleEnums(child, insideRequest || requestBody)
  }
}

/**
 * What the route table cannot say for itself: which credential each group takes, the failures the
 * guards answer before any handler runs, a body on every documented error, and the named components
 * `rendered` carries (absent only in a caller that wants the raw document).
 */
export function finishSpec(spec: Record<string, unknown>, rendered?: Record<string, unknown>): Record<string, unknown> {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>
  for (const route of Object.keys(paths)) {
    // The engine's DNS-01 channel is internal plumbing, not part of the API.
    if (route.startsWith('/_acme')) {
      delete paths[route]
      continue
    }
    for (const operation of Object.values(paths[route]!)) {
      const responses = (operation.responses ??= {}) as Record<string, Record<string, unknown>>
      if (PUBLIC_OPERATIONS.has(route))
        operation.security = []
      else if (route.startsWith('/_hh'))
        operation.security = [{ localToken: [] }]
      if (route.startsWith('/api') && !PUBLIC_OPERATIONS.has(route)) {
        responses['401'] ??= { description: 'No valid session or token (`AUTH_REQUIRED`)' }
        responses['403'] ??= { description: 'A cross-origin write, or an operation this credential may not perform' }
      }
      responses['421'] ??= { description: 'The `Host` header names a host this panel does not answer to (`HOST_NOT_ALLOWED`)' }
      for (const [status, response] of Object.entries(responses)) {
        if (Number(status) >= 400 && response.content === undefined)
          response.content = ERROR_BODY
      }
    }
  }
  /**
   * What an API token needs for each route, published as `x-required-scope`.
   *
   * The declaration lives in `src/middleware/token-scope.ts` and is enforced there; this copies it
   * into the document so a generated client can show, or check, what a credential needs. An extension
   * rather than a standard field because OpenAPI has no vocabulary for "this operation needs one of
   * these application-defined scopes" — `security` only names a scheme.
   */
  for (const [route, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const scope = tokenScopesFor(method.toUpperCase(), route.replace(/\{[^}]+\}/g, ':param'))
      if (scope !== null)
        (operation as Record<string, unknown>)['x-required-scope'] = scope
    }
  }

  if (rendered !== undefined)
    liftNamedSchemas(spec, rendered)
  // After the lift, so a component's enum is widened once rather than at each `$ref`.
  markExtensibleEnums(spec)
  return spec
}
