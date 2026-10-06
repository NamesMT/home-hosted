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

  /**
   * The panel must not re-declare a shared member either.
   *
   * The check above only looked at the UIs, and that blind spot was real: `services/proxy.ts` kept
   * its own `isPublicHost` and `LOCAL_TLDS` beside the shared pair, and the bodies had already
   * diverged — the shared copy trims the host, the panel's did not. They agreed on every input I
   * tried, so nothing broke; the next divergence would not have been so polite.
   *
   * `src/**` is the other consumer of `src/shared/`, so it needs the same rule.
   */
  it('keeps the panel from re-declaring a shared member', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'services', 'proxy.ts'), 'utf8')
    expect(source, 'the panel must not re-declare isPublicHost').not.toMatch(/^export function isPublicHost/m)
    expect(source, 'the panel must not re-declare LOCAL_TLDS').not.toMatch(/^const LOCAL_TLDS/m)
    expect(source, 'the panel should read the shared form').toContain('from \'#src/shared/proxy-form\'')
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

/**
 * One plain-object predicate for every untyped boundary.
 *
 * It had **eight** private copies — five in `src/` and three in the UIs — and two of them accepted
 * an array, which `typeof` calls an object. Searching by name found only some of them: the rest were
 * called `isRecordValue` or `isPlainObject`, or were an inline expression. So this guard matches the
 * **body**, not the identifier, which is the only way the next copy gets caught however it is named.
 */
describe('the plain-object predicate has one definition', () => {
  /**
   * Matches the *definition* shape, not a passing narrow check.
   *
   * `isRecord`'s body is the whole pattern; an inline narrowing like `typeof x === 'object' && x
   * !== null && 'key' in x` is a different thing (it needs the `in` test, which the predicate cannot
   * express) and is left alone. The two forms this catches are the ones that were copied:
   * `return typeof v === 'object' && v !== null && !Array.isArray(v)` and the same as a ternary.
   */
  const PREDICATE = /typeof \w+ === 'object' && \w+ !== null && !Array\.isArray\(\w+\)/g

  const sources = (): Array<{ rel: string, body: string }> => {
    const found: Array<{ rel: string, body: string }> = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist')
            continue
          walk(full)
        }
        else if (/\.tsx?$/.test(entry.name)) {
          // POSIX form, so the comparison below is the same on Windows: `path.relative` returns
          // backslashes there, and a literal expectation would pass on Linux and fail on Windows.
          const rel = path.relative(root, full).replaceAll('\\', '/')
          found.push({ rel, body: fs.readFileSync(full, 'utf8') })
        }
      }
    }
    walk(path.join(root, 'src'))
    walk(path.join(root, 'uis'))
    return found
  }

  it('lives only in the shared module', () => {
    const files = sources()
    // Anti-vacuity: the walk is meant to see the whole tree, not an empty list.
    expect(files.length).toBeGreaterThan(100)

    const holders = files
      .filter(file => PREDICATE.test(file.body))
      .map(file => file.rel)
      .sort()

    expect(holders).toEqual(['src/shared/shape.ts'])
  })

  it('is reached through `@shared` from a UI and `#src` from the core', () => {
    const shape = fs.readFileSync(path.join(root, 'src', 'shared', 'shape.ts'), 'utf8')
    expect(shape).toContain('export function isRecord')
    // The array half is the reason this exists; a variant without it is the bug, not a style choice.
    expect(shape).toContain('!Array.isArray(value)')

    expect(fs.readFileSync(path.join(root, 'uis', 'stock', 'src', 'lib', 'api.ts'), 'utf8')).toContain('from \'@shared/shape\'')
    expect(fs.readFileSync(path.join(root, 'uis', 'noc-console', 'src', 'lib', 'api.ts'), 'utf8')).toContain('from \'@shared/shape\'')
  })
})
