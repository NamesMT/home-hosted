import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The two UIs' reverse-proxy form logic must not be re-forked.
 *
 * `uis/stock` and `uis/noc-console` each carried their own `lib/proxy.ts` with **40 identical
 * declarations**, and eight commits had touched both files — one of them literally "carry the fix
 * into the other UI". The shared half now lives in `src/shared/proxy-form.ts`.
 *
 * The failure this guards is quiet: someone adds a helper to one UI's `lib/proxy.ts`, the other
 * keeps its own, and the two forms drift until a saved config is wrong. So the assertion is about
 * shape* — the duplicated declarations are gone and both UIs read the shared module — rather than
 * about any single function.
 */
describe('the UIs share one proxy form', () => {
  const uiProxy = (ui: string): string => fs.readFileSync(path.join(root, 'uis', ui, 'src', 'lib', 'proxy.ts'), 'utf8')

  it('keeps the form logic in one module', () => {
    const shared = fs.readFileSync(path.join(root, 'src', 'shared', 'proxy-form.ts'), 'utf8')
    // The shared module is the one place these live.
    expect(shared).toContain('export function validateRouteDraft')
    expect(shared).toContain('export function parseUpstream')
    expect(shared).toContain('ROUTE_ID_PATTERN')

    // Neither UI re-declares them: a second copy is how the drift starts.
    for (const ui of ['stock', 'noc-console']) {
      const source = uiProxy(ui)
      expect(source, `${ui} must not re-declare validateRouteDraft`).not.toMatch(/^export function validateRouteDraft/m)
      expect(source, `${ui} must not re-declare parseUpstream`).not.toMatch(/^export function parseUpstream/m)
      expect(source, `${ui} must not re-declare ROUTE_ID_PATTERN`).not.toMatch(/^export const ROUTE_ID_PATTERN/m)
      // And each reads the shared module, value and type side separately.
      expect(source, `${ui} should import the shared form`).toContain('from \'@shared/proxy-form\'')
    }
  })

  it('keeps `cloneRoutes` in each UI, because it needs Vue', () => {
    // The one deliberate exception: it calls `toRaw`, and the shared module must not depend on Vue
    // (the UIs bundle it as a devDependency; the published package does not ship it).
    const shared = fs.readFileSync(path.join(root, 'src', 'shared', 'proxy-form.ts'), 'utf8')
    expect(shared, 'src/shared must not import Vue').not.toMatch(/from 'vue'/)
    for (const ui of ['stock', 'noc-console'])
      expect(uiProxy(ui), `${ui} keeps cloneRoutes`).toContain('export function cloneRoutes')
  })
})
