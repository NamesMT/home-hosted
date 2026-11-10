/**
 * `home-hosted/client` — a typed client for building your own tools on the panel's API.
 *
 * ```ts
 * import { createClient } from 'home-hosted/client'
 *
 * const hh = createClient({ baseUrl: 'http://127.0.0.1:3999', token: process.env.HH_TOKEN })
 * const { servers } = await hh.json(hh.api.servers.$get({ query: {} }))
 * for await (const frame of hh.events({ logs: false }))
 *   console.log(frame.type)
 * ```
 *
 * `api` is Hono's RPC client rooted at `/api`, typed from the panel's own route table, so every path,
 * body and response is checked against the server that answers it; `rpc` is the same client at the
 * root, for `/healthz` and `/openapi`. Types only travel from the server: nothing of it is imported
 * at runtime.
 */
import type { AppType } from '#src/app'
import type { SseMessage } from '#src/shared/contracts'
import { hc } from 'hono/client'
import { isLoopbackHost } from '#src/shared/server-url'

export type { AppType } from '#src/app'
export type {
  ActionResultBody,
  AppState,
  ControlView,
  ServerConfig,
  ServerView,
  SseMessage,
  WorkspaceView,
} from '#src/shared/contracts'

export interface ClientOptions {
  /** Where the panel listens, e.g. `http://127.0.0.1:3999`. */
  baseUrl: string
  /** An API token (`home-hosted set-token --generate`); omit it for a cookie session in a browser. */
  token?: string
  /** A `fetch` to use instead of the global one (tests, proxies, custom TLS). */
  fetch?: typeof fetch
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /**
   * Send `token` over plain `http` to a host that is not this machine. Off by default: the token is
   * full admin, and anyone on the path could read it. Set it only for a network you trust end to end.
   */
  allowInsecureToken?: boolean
}

/** A failed request, carrying the panel's error envelope. */
export class HomeHostedError extends Error {
  override name = 'HomeHostedError'

  constructor(
    message: string,
    /** The HTTP status. */
    readonly status: number,
    /** The stable machine-readable code (`UNKNOWN_SERVER`, `AUTH_REQUIRED`, …). */
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

export interface EventsQuery {
  /** Only this workspace's server and log frames. */
  workspace?: string
  /** Only this server's frames (pair it with `workspace`; ids are unique per workspace). */
  serverId?: string
  /** `false` drops log frames. */
  logs?: boolean
  /** Stops the stream. */
  signal?: AbortSignal
}

/** A token is sent only over https, or to this machine, unless the caller opted out. */
function assertTokenTransport(baseUrl: string, options: ClientOptions): void {
  if (options.token === undefined || options.allowInsecureToken === true)
    return
  let url: URL
  try {
    url = new URL(baseUrl)
  }
  catch {
    throw new TypeError(`home-hosted/client: baseUrl "${baseUrl}" is not an absolute URL`)
  }
  if (url.protocol === 'https:' || isLoopbackHost(url.hostname))
    return
  throw new TypeError(`home-hosted/client: refusing to send the API token over plain http to ${url.host} — use https, a loopback address, or pass allowInsecureToken: true`)
}

export function createClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  assertTokenTransport(baseUrl, options)
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const headers = (): Record<string, string> => ({
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...options.headers,
  })

  const rpc = hc<AppType>(baseUrl, { fetch: fetcher, headers })
  // Every route a client means lives under `/api`; rooting the client there keeps calls to
  // `hh.api.servers` rather than `hh.api.api.servers`.
  const api = rpc.api

  /** Awaits a call, returning its JSON body or throwing a `HomeHostedError`. */
  async function json<T>(call: Promise<{ ok: boolean, status: number, json: () => Promise<T> }>): Promise<T> {
    const response = await call
    if (!response.ok)
      throw await toError(response as unknown as Response)
    return await response.json()
  }

  /** The live feed: the first frame is always `hello` with the full state. */
  async function* events(query: EventsQuery = {}): AsyncGenerator<SseMessage> {
    const params = new URLSearchParams()
    if (query.workspace !== undefined)
      params.set('workspace', query.workspace)
    if (query.serverId !== undefined)
      params.set('serverId', query.serverId)
    if (query.logs === false)
      params.set('logs', '0')
    const suffix = params.size > 0 ? `?${params}` : ''
    const response = await fetcher(`${baseUrl}/api/events${suffix}`, {
      headers: { ...headers(), accept: 'text/event-stream' },
      signal: query.signal,
    })
    if (!response.ok || response.body === null)
      throw await toError(response)

    for await (const frame of readEventStream(response.body)) {
      if (frame.event === 'ping' || frame.data === '')
        continue
      yield JSON.parse(frame.data) as SseMessage
    }
  }

  return { api, rpc, json, events, baseUrl }
}

export type HomeHostedClient = ReturnType<typeof createClient>

async function toError(response: Response): Promise<HomeHostedError> {
  let body: unknown = null
  try {
    body = await response.json()
  }
  catch {
    // not JSON: the status is all there is
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.error === 'string' ? record.error : `request failed with ${response.status}`
  return new HomeHostedError(message, response.status, typeof record.code === 'string' ? record.code : 'HTTP_ERROR', record.detail)
}

/**
 * Cancels the body when the consumer stops reading early.
 *
 * `releaseLock()` alone does not: it drops our handle on the stream while the connection stays open,
 * so a `for await (const frame of hh.events())` that `break`s after one frame left the request running
 * — the panel kept a subscriber slot, and a Node script could not exit because the socket kept the
 * event loop alive. Measured against a real listener: `1 of 1` connections still open after leaving
 * the loop, and a plain-process run stayed awake until `process.exit()`.
 *
 * `cancel()` is a no-op once the stream has ended on its own, so this is safe on the normal path too.
 */
async function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  }
  catch {
    // Already errored or gone: the connection is closed either way, which is the point.
  }
}

/** Parses a `text/event-stream` body into `{ event, data }` frames (the subset the panel sends). */
export async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string, data: string }> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let data: string[] = []
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done)
        return
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (data.length > 0)
            yield { event, data: data.join('\n') }
          event = 'message'
          data = []
        }
        else if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        }
        else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
        newline = buffer.indexOf('\n')
      }
    }
  }
  finally {
    await cancelBody(reader)
    reader.releaseLock()
  }
}
