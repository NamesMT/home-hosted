import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A UI that reads a non-`/api` panel path needs the dev proxy to forward it.
 *
 * `docs/UI_CREATION.md` names exactly two unauthenticated reads outside `/api` — `/healthz` and
 * `/openapi/*` — and tells a UI author they are same-origin. `uis/vite.shared.ts` proxied only
 * `/api`, so Vite answered both with `index.html`. Nothing in the panel could see it: the broken
 * request never left the dev server.
 *
 * Measured against a real `pnpm dev`: `GET /healthz` through the UI origin returned
 * `200 text/html` (`<!doctype html…`) while the panel answered
 * `{"status":"degraded","uptimeMs":…}`. `usePanelHealth` parses that as JSON, so the stock UI's
 * own **Panel uptime** tile rendered `—` on every dev machine — it showed exactly that in
 * Chromium during this review — and a UI author following the contract got a page where JSON was
 * promised. `/openapi/spec.json` through the same origin was also `text/html`.
 *
 * This reads the two files rather than booting a server, because the failure is a *missing
 * proxy key*: it is visible in the config, and a live check would need a panel, a port and a
 * build on every run.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

/** Root-relative paths a UI fetches directly, outside `/api`. */
function sameOriginPaths(source: string): string[] {
  const found = new Set<string>()
  // `fetch('/x')`, `fetch(\`/x\`)` and a bare `href="/x"`.
  for (const m of source.matchAll(/fetch\(\s*[`'"](\/[^`'"$]*)|href="(\/[^"$]*)/g)) {
    const value = (m[1] ?? m[2])!
    if (!value.startsWith('/api'))
      found.add(`/${value.split('/')[1] ?? ''}`)
  }
  return [...found].filter(Boolean).sort()
}

function uiSources(): string[] {
  const found: string[] = []
  const uisDir = path.join(root, 'uis')
  for (const ui of fs.readdirSync(uisDir, { withFileTypes: true })) {
    if (!ui.isDirectory())
      continue
    const srcDir = path.join(uisDir, ui.name, 'src')
    if (!fs.existsSync(srcDir))
      continue
    for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(?:ts|vue)$/.test(entry.name))
        found.push(path.join(entry.parentPath, entry.name))
    }
  }
  return found.sort()
}

describe('the dev proxy forwards every non-API path a UI reads', () => {
  it('finds the UI sources, so a broken glob cannot pass for free', () => {
    expect(uiSources().length).toBeGreaterThan(40)
  })

  it('names a proxy entry for each one', () => {
    const shared = fs.readFileSync(path.join(root, 'uis/vite.shared.ts'), 'utf8')
    const proxied = new Set(
      [...shared.matchAll(/^\s*'([^']+)':\s*\{\s*target:/gm)].map(m => m[1]!),
    )
    // Anti-vacuity: `/api` is the entry that always exists.
    expect(proxied.has('/api')).toBe(true)

    const missing = new Set<string>()
    for (const file of uiSources()) {
      for (const prefix of sameOriginPaths(fs.readFileSync(file, 'utf8'))) {
        if (!proxied.has(prefix))
          missing.add(`${prefix} (from ${path.relative(root, file)})`)
      }
    }
    expect([...missing]).toEqual([])
  })

  it('keeps the two paths the UI contract promises outside /api', () => {
    const shared = fs.readFileSync(path.join(root, 'uis/vite.shared.ts'), 'utf8')
    // Named explicitly, because these are the ones the contract documents and the ones whose
    // absence is invisible: a UI that reads them silently gets the SPA shell instead.
    expect(shared).toContain('\'/healthz\'')
    expect(shared).toContain('\'/openapi\'')
  })
})
