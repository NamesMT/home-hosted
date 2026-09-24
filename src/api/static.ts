import type { Context } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
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

    const file = resolveWithin(root, pathname)
    if (file !== null) {
      const response = await serveFile(c, file, pathname)
      if (response !== null)
        return response
    }

    const indexFile = path.join(root, entry)
    if (fs.existsSync(indexFile)) {
      const response = await serveFile(c, indexFile, '/')
      if (response !== null)
        return response
    }

    return c.text('no UI is installed — build one and upload it under Settings → Interface', 503)
  })

  return route
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return null
  }
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
  const immutable = pathname.startsWith('/assets/')
  const payload = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer

  return c.body(payload, 200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': String(stats.size),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
}
