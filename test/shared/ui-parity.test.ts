import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../helpers/strip-comments'

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

  /**
   * The route drafts' two helpers moved in with the rest.
   *
   * They stayed per-UI as long as they called Vue's `toRaw` for the detach. `clonePlain` needs no
   * Vue, which left the exception pointing at a reason that no longer existed: both UIs were then
   * carrying a byte-identical `cloneRoutes` and `applyRouteDraft` beside a shared module that could
   * hold them. A stale rationale is how the duplication survives its own fix, so this pins both.
   */
  it('keeps the route draft helpers in the shared module', () => {
    const shared = fs.readFileSync(path.join(root, 'src', 'shared', 'proxy-form.ts'), 'utf8')
    expect(shared, 'src/shared must not import Vue').not.toMatch(/from 'vue'/)
    expect(shared, 'the detach must go through clonePlain').toContain('clonePlain(')
    expect(shared).toContain('export function cloneRoutes')
    expect(shared).toContain('export function applyRouteDraft')

    for (const ui of ['stock', 'noc-console']) {
      const source = uiProxy(ui)
      expect(source, `${ui} must not re-declare cloneRoutes`).not.toMatch(/^export function cloneRoutes/m)
      expect(source, `${ui} must not re-declare applyRouteDraft`).not.toMatch(/^export function applyRouteDraft/m)
      // And each still resolves them locally, so no call site had to learn a new import path.
      expect(source, `${ui} should re-export the shared cloneRoutes`).toContain('cloneRoutes')
    }
  })
})

/**
 * The DDNS form is one implementation, and its clone is not `structuredClone(toRaw(...))`.
 *
 * Both UIs carried their own `lib/ddns.ts`, and they had already diverged: `noc-console` ran
 * `repairNumbers` where `stock` fell back to the schema default. The clone bug had to be fixed in
 * both, which is the duplication cost this pins against coming back.
 */
describe('the UIs share one DDNS form', () => {
  it('keeps the form logic in the shared module', () => {
    const shared = fs.readFileSync(path.join(root, 'src', 'shared', 'ddns-form.ts'), 'utf8')
    expect(shared).toContain('export function cloneDdnsConfig')
    expect(shared).toContain('export function ddnsConfigPatch')
    expect(shared, 'src/shared must not import Vue').not.toMatch(/from 'vue'/)

    for (const ui of ['stock', 'noc-console']) {
      const dir = path.join(root, 'uis', ui, 'src', 'lib')
      expect(fs.existsSync(path.join(dir, 'ddns.ts')), `${ui} must not keep its own lib/ddns.ts`).toBe(false)
    }
  })

  /**
   * Both pages must count the **diff**, never the block they hand to `/api/ddns`.
   *
   * The block is replaced on the wire, so it carries every key — counting its leaves reported 9
   * fields for one IPv6 toggle, untouched ones included. Only one page had a mounted test, and the
   * other is the one that would drift.
   */
  it('counts the DDNS diff on both pages, not the whole block', () => {
    for (const page of ['SettingsView.vue']) {
      for (const ui of ['stock', 'noc-console']) {
        const source = fs.readFileSync(path.join(root, 'uis', ui, 'src', 'views', page), 'utf8')
        expect(source, `${ui} must reach the shared DDNS form`).toContain('from \'@shared/ddns-form\'')
        expect(source, `${ui} must diff the DDNS block for its count`).toContain('ddnsConfigPatch(')
        // The count line itself, not a comment about it.
        expect(source, `${ui} counts the raw block`).not.toMatch(/countLeaves\(ddnsPatch\.value/)
      }
    }
  })

  /**
   * The bug itself, scanned where it can still appear: any `structuredClone` the UIs hand a value
   * that came out of a reactive form. The DDNS section's rows are the reported case, but the same
   * mistake was in the route dialogs and `cloneRoutes`.
   *
   * The scan used to strip comments with two regexes and justify it as "no string here contains
   * `//`" — an assumption about the corpus, not a property of the scanner. The corpus already broke
   * it: `uis/stock/src/i18n/index.ts` holds `'../../i18n/generated/**\/*.json'`, so the block pattern
   * opened at that `/*` and closed at the end of the *next* comment — deleting the `createI18n(...)`
   * call between them. A `structuredClone` planted on the line after that glob stayed green. The
   * stripper now tracks what it is inside of (`test/helpers/strip-comments.ts`).
   */
  it('never clones a form value with `structuredClone`', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist')
            continue
          walk(full)
        }
        else if (/\.(?:ts|vue)$/.test(entry.name) && /structuredClone/.test(stripComments(fs.readFileSync(full, 'utf8'), entry.name))) {
          offenders.push(path.relative(root, full).replaceAll('\\', '/'))
        }
      }
    }
    for (const ui of ['stock', 'noc-console'])
      walk(path.join(root, 'uis', ui, 'src'))

    // Anti-vacuity: the walk sees the UI sources, and the stripper keeps a call a comment merely
    // mentions while removing the comment itself.
    expect(fs.existsSync(path.join(root, 'uis', 'stock', 'src', 'lib', 'proxy.ts'))).toBe(true)
    expect(stripComments('// structuredClone(toRaw(x)) is the bug'), 'a comment is stripped').not.toContain('structuredClone')
    expect(stripComments('const g = import.meta.glob(\'../**/*.json\')\nconst c = structuredClone(x)'), 'a glob star is not a comment').toContain('structuredClone')
    expect(stripComments('const url = \'http://h:6181\'\nstructuredClone(x)'), 'a // in a URL is not a comment').toContain('structuredClone')
    expect(offenders).toEqual([])
  })
})

/**
 * The restore-from-a-file helper is one implementation, not one per UI.
 *
 * `restoreUploadedBackup` and `RestoreOptions` were byte-identical copies in both `lib/api.ts`
 * files, so the day `exclude` was added to a create the restore side kept only `include` — and a
 * restore from a file could tick items but never say "everything except the credentials". The
 * copies are gone; this keeps the next one from being written.
 */
describe('the UIs share one restore-from-file helper', () => {
  it('keeps the upload helper and its options in the shared client', () => {
    const shared = fs.readFileSync(path.join(root, 'src', 'shared', 'api-client.ts'), 'utf8')
    expect(shared).toContain('export async function restoreUploadedBackup')
    expect(shared).toContain('export interface RestoreOptions')

    for (const ui of ['stock', 'noc-console']) {
      const source = fs.readFileSync(path.join(root, 'uis', ui, 'src', 'lib', 'api.ts'), 'utf8')
      expect(source, `${ui} must not re-declare restoreUploadedBackup`).not.toMatch(/^export async function restoreUploadedBackup/m)
      expect(source, `${ui} must not re-declare RestoreOptions`).not.toMatch(/^export interface RestoreOptions/m)
      expect(source, `${ui} should re-export the shared upload helper`).toContain('restoreUploadedBackup')
    }
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
  /**
   * Whether a source body holds the predicate's shape.
   *
   * The pattern is built **inside the call**, not held in a module-level `const … /g` used with
   * `.test()`. That is not style: a `/g` regex is stateful, because `.test()` advances `lastIndex`
   * and the next call starts from there rather than from 0. Measured on this scan — it matched
   * `src/shared/shape.ts` at offset 1037, then walked over a copy planted at the top of the very
   * next file in its order (`src/shared/ui-format.ts`), so a duplicate sitting beside the original
   * was invisible. A fresh regex per call cannot carry that state.
   */
  function holdsPredicate(body: string): boolean {
    return /typeof \w+ === 'object' && \w+ !== null && !Array\.isArray\(\w+\)/.test(body)
  }

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
        // `.vue` too: a component's `<script setup>` is where a copy was actually planted, and
        // accepting only `.ts`/`.tsx` meant the guard never looked inside it. The template half of
        // the file cannot match this shape, so widening the corpus costs nothing.
        else if (/\.(?:tsx?|vue)$/.test(entry.name)) {
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

  /** Every `@shared/*` import specifier one UI makes, across all of its source files. */
  function uiImports(ui: string): string[] {
    const base = path.join(root, 'uis', ui, 'src')
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        }
        else if (/\.(?:ts|vue)$/.test(entry.name)) {
          // Split rather than regex: `from '@shared/x'` is a plain substring, and a pattern here
          // tripped `regexp/no-unused-capturing-group` whichever way the group was written.
          for (const part of fs.readFileSync(full, 'utf8').split(`from '`).slice(1)) {
            const spec = part.slice(0, part.indexOf(`'`))
            if (spec.startsWith('@shared/'))
              out.push(spec)
          }
        }
      }
    }
    walk(base)
    return out
  }

  it('lives only in the shared module', () => {
    const files = sources()
    // Anti-vacuity: the walk is meant to see the whole tree, not an empty list.
    expect(files.length).toBeGreaterThan(100)

    const holders = files
      .filter(file => holdsPredicate(file.body))
      .map(file => file.rel)
      .sort()

    expect(holders).toEqual(['src/shared/shape.ts'])
  })

  /**
   * The scan must see a copy wherever it is written, which is a property of the *scanner*.
   *
   * Asserting only `holders === ['src/shared/shape.ts']` cannot distinguish "there is one
   * definition" from "the walk never looked". Two measured holes hid behind that single
   * assertion, and both were reproduced by planting a real duplicate and watching this file stay
   * green:
   *
   *  - the pattern was a module-level `const … /g` passed to `.test()`, and `.test()` on a `/g`
   *    regex advances `lastIndex`. After matching `src/shared/shape.ts` it left `lastIndex` at
   *    1037, so a copy placed at the top of the *next* file in walk order starts before that
   *    offset and is skipped;
   *  - the walk accepted only `.ts`/`.tsx`, so a copy inside a component's `<script setup>` was
   *    never read at all.
   *
   * So this plants a copy into a real file of each shape and requires the scanner to find it.
   * The copy is built from the same body, under a name the scan cannot recognise by name.
   */
  it('finds a planted copy in any scanned file, not just the one it already knows', () => {
    const files = sources()
    // A copy of the shape, deliberately not named `isRecord`: the guard matches the body.
    const PLANT = [
      'export function looksLikeRecord(value: unknown): boolean {',
      `  return typeof value === 'object' && value !== null && !Array.isArray(value)`,
      '}',
      '',
      '',
    ].join('\n')

    // The two shapes that were invisible: the file immediately after the real definition in walk
    // order (where a stale `lastIndex` lands), and any `.vue` component.
    const holderIndex = files.findIndex(file => file.rel === 'src/shared/shape.ts')
    expect(holderIndex, 'the real definition must be in the corpus for this to mean anything').toBeGreaterThan(-1)
    const neighbour = files[holderIndex + 1]
    expect(neighbour, 'a file must follow the definition, or the lastIndex case cannot be tested').toBeTruthy()

    const vue = files.find(file => file.rel.endsWith('.vue'))
    expect(vue, 'the corpus must contain a .vue file, and the walk must not skip it').toBeTruthy()

    const missed = [neighbour!, vue!]
      .filter(target => !files.some(file => file.rel === target.rel && holdsPredicate(PLANT + file.body)))
      .map(target => target.rel)
    expect(missed, 'the scan must find a copy planted in every file it claims to read').toEqual([])

    // The statelessness itself, independent of walk order: matching a body must not change what the
    // *next* call sees. A `/g` matcher returns `false` for the second call whenever the second match
    // would start before the first call left `lastIndex`.
    const realShape = files.find(file => file.rel === 'src/shared/shape.ts')!.body
    expect(holdsPredicate(realShape), 'the real definition matches').toBe(true)
    expect(holdsPredicate(PLANT), 'and a copy still matches after it').toBe(true)
  })

  it('is reached through `@shared` from a UI and `#src` from the core', () => {
    const shape = fs.readFileSync(path.join(root, 'src', 'shared', 'shape.ts'), 'utf8')
    expect(shape).toContain('export function isRecord')
    // The array half is the reason this exists; a variant without it is the bug, not a style choice.
    expect(shape).toContain('!Array.isArray(value)')

    // Asserted on a module that *needs* it in both UIs rather than one particular file: the previous
    // version named `lib/api.ts`, which stopped importing `isRecord` once its `request` helper moved
    // to `@shared/api-client`. A named file is a fixture that rots; the property is that each UI
    // reaches shared code by the alias.
    // Counted, not merely matched: a single surviving import in one file satisfied a `toMatch` on the
    // joined text, so removing every shared import from a UI still passed.
    for (const ui of ['stock', 'noc-console'])
      expect(uiImports(ui).length, `${ui} must reach shared code through the alias`).toBeGreaterThan(0)
    // The alias is used for more than contracts, so the check is not satisfied by one type-only import.
    expect(uiImports('noc-console').some(spec => spec !== '@shared/contracts')).toBe(true)
  })
})
