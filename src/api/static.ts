import type { Context } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { DetailedError } from '@namesmt/utils'
import { Hono } from 'hono'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

export interface StaticRouteOptions {
  /** Resolved per request, so a UI installed at runtime takes effect on refresh. */
  dir: string | (() => string)
  entry?: string
}

/**
 * Serves the built control UI and falls back to `index.html` for client routes,
 * so a deep URL like `/servers/static` works after a refresh.
 *
 * The fallback is for *pages* only: a request for a file the install does not have is a 404, so a
 * missing script is visible instead of arriving as HTML with a confusing syntax error.
 */
export function createStaticRoute(options: StaticRouteOptions): Hono {
  const route = new Hono()
  const entry = options.entry ?? 'index.html'
  const currentRoot = (): string => path.resolve(typeof options.dir === 'function' ? options.dir() : options.dir)

  route.get('*', async (c) => {
    const root = currentRoot()
    const pathname = safeDecode(new URL(c.req.url).pathname)
    if (pathname === null)
      return c.text('bad path', 400)

    // A path under `/api` that reached this catch-all matched no route, so it is a client
    // mistake — never a UI route. Falling through to `index.html` answered a typo'd API call
    // with `200 text/html`, which `curl --fail` and a `.json()` parse both treat as success.
    if (isApiPath(pathname))
      throw noRoute(c)

    const file = resolveWithin(root, pathname)
    if (file === null)
      throw noRoute(c)
    const response = await serveFile(c, file, pathname)
    if (response !== null)
      return response

    // A miss is a client route only when it can be one. `index.html` answers a person who
    // refreshed a deep URL; it must never answer a file request — a browser handed HTML where it
    // asked for `.js` raises a syntax error on the HTML and hides the 404 the build really has.
    if (!isClientRoute(pathname, c.req.header('accept')))
      throw noRoute(c)

    const indexFile = path.join(root, entry)
    if (fs.existsSync(indexFile)) {
      const response = await serveFile(c, indexFile, '/')
      if (response !== null)
        return response
    }

    return c.text('no UI is installed — build one and upload it under Settings → Interface', 503)
  })

  // Only `GET` serves the UI; any other method that got this far matched no route, and answers the
  // API's envelope rather than Hono's plain-text 404, which a JSON client cannot parse.
  route.all('*', (c) => {
    throw noRoute(c)
  })

  return route
}

function noRoute(c: Context): DetailedError {
  return new DetailedError(`no route for ${c.req.method} ${new URL(c.req.url).pathname}`, { statusCode: 404, code: 'NOT_FOUND' })
}

/** The panel's own JSON surfaces: never a UI route, so a miss there is a 404, not `index.html`. */
const API_PREFIXES = ['/api', '/_hh', '/_acme', '/openapi']

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return null
  }
}

/**
 * Whether a missing path may be answered with `index.html`.
 *
 * A deep URL a person refreshed is a client route, and only GET reaches here. A **file** request
 * is not: a browser handed `text/html` where it asked for a `.js` raises a syntax error on the
 * HTML and the network tab hides the 404 the build really has. `/assets/` is never a client route
 * at all — a name there that the install does not have is a broken reference in the build, not a
 * page, so it stays a 404 even for a request that accepts HTML.
 */
function isClientRoute(pathname: string, accept: string | undefined): boolean {
  if (pathname.startsWith('/assets/'))
    return false
  return path.extname(pathname) === '' || (accept ?? '').includes('text/html')
}

/**
 * Whether a name under `/assets/` is content-hashed — the only thing a year of caching is safe
 * for, because the URL changes with the bytes.
 *
 * Vite writes `[name]-<hash>[ext]`, where the hash is 8 base64url characters (it may itself
 * contain `-` or `_`, and may start or end with one). Matching that *shape* rather than the
 * directory is the point: a UI that copies `public/` files verbatim, or any build that does not
 * hash, keeps the same URL across releases, and `immutable` on such a name froze a rebuilt UI in
 * every browser. Requiring both a letter and an upper-case character or digit keeps a hand-named
 * `logo-20240101.svg` out. A hash this misses only costs a revalidation — the safe direction.
 */
const CHUNK_HASH = /-[\w-]{8}$/

function isHashedAsset(pathname: string): boolean {
  if (!pathname.startsWith('/assets/'))
    return false
  const base = pathname.slice(pathname.lastIndexOf('/') + 1)
  const stem = base.slice(0, base.length - path.extname(base).length)
  const matched = CHUNK_HASH.exec(stem)
  if (matched === null)
    return false
  const hash = matched[0].slice(1)
  return /[a-z]/i.test(hash) && /[A-Z0-9]/.test(hash)
}

function resolveWithin(root: string, pathname: string): string | null {
  const resolved = path.resolve(root, `.${pathname}`)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    return null
  return resolved
}

async function serveFile(c: Context, file: string, pathname: string): Promise<Response | null> {
  let stats: fs.Stats
  try {
    stats = await fs.promises.stat(file)
  }
  catch {
    return null
  }
  if (!stats.isFile())
    return null

  const body = await fs.promises.readFile(file)
  const ext = path.extname(file).toLowerCase()
  const payload = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer

  return c.body(payload, 200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': String(stats.size),
    // A hashed name is immutable. Everything else — the entry document above all, which points at
    // the hashed names a rebuild deletes — is revalidated, so a new build is picked up on refresh.
    'Cache-Control': isHashedAsset(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
}
