import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shownInSeconds } from '#src/shared/ui-format'

/**
 * A millisecond setting whose floor is a second is edited in seconds, in **both** UIs, and the
 * label says so.
 *
 * `sessionTtlMs` was a box showing `604800000` for a week. The rule is decided by the schema, not
 * by taste: a field whose floor is 1000 ms or more has no meaningful sub-second value, so seconds
 * is the only honest unit; below that (`health.timeoutMs` starts at 100, `health.intervalMs` at
 * 500) seconds would round away the values the field accepts, and ms stays.
 *
 * The conversion was applied to `stock`, and the commit announced it for both — "They now show
 * seconds in both UIs". It was not: `noc-console`'s notification cooldown and its DDNS check
 * interval still read a raw millisecond count under a `(ms)` label, so the same setting read `120`
 * on one page and `120000` on the other. The scan could not see it. It read
 * `uis/stock/i18n/sheets` — the only UI with a catalog — and its third assertion only asked whether
 * the shared module *exports* the helpers, which no call site can fail. A guard that reads one
 * twin cannot notice the other one disagreeing.
 *
 * So every label block in **every** UI is read here, and the unit a box states must agree with the
 * unit its binding is in. `intervalMs` names three different fields (`health`, `host`, DDNS), so
 * the binding is matched by the object it reads through, not by the bare field name.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const UIS = ['stock', 'noc-console'] as const

/** The catalog strings a duration box is labelled with, and whether their floor is >= 1000 ms. */
const IN_SECONDS = [
  'settings.auth.sessionLifetime',
  'settings.auth.lockout',
  'settings.host.interval',
  'settings.telegram.cooldown',
  'settings.ddns.interval',
]

/** Stays in ms: the schema floor is below a second. */
const IN_MS = ['settings.host.tempCommandTimeout', 'lifecycle.timeout', 'lifecycle.interval']

/**
 * Every millisecond field a settings page binds, the unit the schema decides for it, and why.
 *
 * `cooldownMs` is the one with a floor of `0`, because zero is its "off" sentinel and every value a
 * person means is whole seconds — which is why `stock` has shown it in seconds since the field
 * existed. The three `intervalMs` fields are spelled the same and land on both sides of the rule,
 * so each is named by the object it is read through.
 */
const FIELDS: Array<{ pattern: RegExp, unit: 's' | 'ms', why: string }> = [
  { pattern: /\bsessionTtlMs\b/, unit: 's', why: 'floor 60 s' },
  { pattern: /\blockoutMs\b/, unit: 's', why: 'floor 1 s' },
  { pattern: /\bcooldownMs\b/, unit: 's', why: 'the off sentinel is 0; every other value is whole seconds' },
  { pattern: /\bdraft\.intervalMs\b/, unit: 's', why: 'DDNS, floor 60 s' },
  { pattern: /\bhost\.intervalMs\b/, unit: 's', why: 'vitals, floor 5 s' },
  { pattern: /\b(?:form|health)\.intervalMs\b/, unit: 'ms', why: 'health probe, floor 500 ms' },
  { pattern: /\b(?:form|health)\.timeoutMs\b/, unit: 'ms', why: 'probe timeout, floor 100 ms' },
  { pattern: /\b(?:form\.)?(?:baseDelayMs|maxDelayMs|resetAfterMs)\b/, unit: 'ms', why: 'backoff, floor 0' },
  { pattern: /\b(?:form\.)?(?:forceRestartAfterMs|startTimeoutMs|graceMs)\b/, unit: 'ms', why: 'floor 0' },
]

/** The five fields both UIs are expected to edit, by the expression each binds it through. */
const BOTH_UIS: Array<{ key: string, seen: RegExp }> = [
  { key: 'sessionTtlMs', seen: /\bsessionTtlMs\b|\bsessionTtl\b/ },
  { key: 'lockoutMs', seen: /\blockoutMs\b|\blockout\b/ },
  { key: 'cooldownMs', seen: /\bcooldownMs\b/ },
  { key: 'draft.intervalMs', seen: /\bdraft\.intervalMs\b/ },
  { key: 'host.intervalMs', seen: /\bhost\.intervalMs\b|\bintervalSeconds\b/ },
]

/**
 * The floor of every `…Ms` key, as the schemas declare it, so the rule is quoted rather than
 * restated. Keyed by **declaring schema** and field: `intervalMs` is declared four times with four
 * floors (health 500, host 5000, DDNS 60000, backup schedule 0), so a map keyed by the bare name
 * collapses them and answers `0` — the mistake the `noc-console` pages made.
 */
function schemaFloors(): Map<string, number> {
  const contracts = readFileSync(path.join(root, 'src/shared/contracts.ts'), 'utf8')
  const found = new Map<string, number>()
  for (const declared of contracts.matchAll(/^export const (\w+)Schema = type\(\{/gm)) {
    const open = declared.index + declared[0].length - 1
    // Balanced braces, because a schema body nests (`health.http`, `ddns.ipv4`, …).
    let depth = 0
    let close = open
    for (; close < contracts.length; close++) {
      if (contracts[close] === '{')
        depth += 1
      else if (contracts[close] === '}' && --depth === 0)
        break
    }
    const body = contracts.slice(open, close)
    for (const field of body.matchAll(/^\s{2}(\w+Ms)\s*:\s*'number(?:\.integer)? >= (\d+)/gm)) {
      const key = `${declared[1]!}Schema.${field[1]!}`
      found.set(key, Math.min(found.get(key) ?? Number.POSITIVE_INFINITY, Number(field[2])))
    }
  }
  return found
}

/** Every `.vue` under a UI's `src`, in POSIX form so the labels match on Windows. */
function uiFiles(ui: string): Array<{ rel: string, body: string }> {
  const found: Array<{ rel: string, body: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist')
          continue
        walk(full)
      }
      else if (entry.name.endsWith('.vue')) {
        found.push({ rel: path.relative(root, full).replaceAll('\\', '/'), body: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(path.join(root, 'uis', ui, 'src'))
  return found
}

/**
 * The **sheets**, not the generated JSON: that directory is git-ignored build output, so a clean
 * checkout — which is what CI has — would fail this scan for a missing file rather than a wrong label.
 */
function english(): Record<string, string> {
  const dir = path.join(root, 'uis/stock/i18n/sheets')
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.csv'))) {
    const text = readFileSync(path.join(dir, name), 'utf8')
    for (const line of text.split('\n').slice(1)) {
      // A sheet is `KEY,en,vi,…`; the English cell is the second column, and may be quoted.
      const match = /^([^,]+),("(?:[^"]|"")*"|[^,]*)/.exec(line)
      if (match === null)
        continue
      const cell = match[2]!.startsWith('"') ? match[2]!.slice(1, -1).replaceAll('""', '"') : match[2]!
      out[match[1]!] = cell
    }
  }
  return out
}

/** One `<label>` (noc-console's shape) or one `<NumberField … />` (stock's), with its text. */
function fieldBlocks(source: string): string[] {
  const blocks = [...source.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map(match => match[1] ?? '')
  // A `NumberField` states its unit in the catalog, not here; it is scanned for its binding only.
  blocks.push(...[...source.matchAll(/<NumberField\b[\s\S]*?\/>/g)].map(match => match[0]))
  return blocks
}

/** The unit a block states, from its own `(ms)`/`(s)` text; null when it states none. */
function statedUnit(block: string): 's' | 'ms' | null {
  const match = /\(\s*(ms|s|sec)\s*\)/i.exec(block)
  if (match === null)
    return null
  return match[1]!.toLowerCase() === 'ms' ? 'ms' : 's'
}

describe('duration fields are labelled in the unit they are edited in', () => {
  it('names seconds for the fields converted', () => {
    const strings = english()
    for (const key of IN_SECONDS) {
      const value = strings[key]
      expect(value, `${key} must exist`).toBeTruthy()
      expect(value, `${key} is edited in seconds, so its label must say (s)`).toMatch(/\((?:s|sec)\)/i)
      expect(value, `${key} must not still claim ms`).not.toMatch(/\(ms\)/i)
    }
  })

  it('leaves the sub-second fields in ms', () => {
    const strings = english()
    for (const key of IN_MS) {
      const value = strings[key]
      if (value === undefined)
        continue
      expect(value, `${key} has a sub-second floor, so it stays in ms`).toMatch(/\(ms\)/i)
    }
  })
})

describe('the unit is decided by the schema floor, not by the page', () => {
  it('quotes that floor instead of restating the list', () => {
    const floors = schemaFloors()
    for (const [key, floor] of [
      ['authSchema.sessionTtlMs', 60_000],
      ['authSchema.lockoutMs', 1_000],
      ['hostSchema.intervalMs', 5_000],
      ['ddnsConfigSchema.intervalMs', 60_000],
      ['healthSchema.timeoutMs', 100],
      ['healthSchema.intervalMs', 500],
    ] as const) {
      expect(floors.get(key), `${key} must be declared in src/shared/contracts.ts`).toBe(floor)
    }
    // Three of those boxes edit seconds; the probe keeps ms, because 500 rounds to nothing there.
    expect(shownInSeconds(floors.get('authSchema.sessionTtlMs')!)).toBe(true)
    expect(shownInSeconds(floors.get('hostSchema.intervalMs')!)).toBe(true)
    expect(shownInSeconds(floors.get('ddnsConfigSchema.intervalMs')!)).toBe(true)
    expect(shownInSeconds(floors.get('healthSchema.intervalMs')!), 'the 500 ms probe floor rounds to nothing in seconds').toBe(false)
    expect(shownInSeconds(floors.get('healthSchema.timeoutMs')!), 'the 100 ms probe floor rounds to nothing in seconds').toBe(false)
    // A name is not a field: the four `intervalMs` floors differ, which is why the pages name the
    // object they read through and this map is keyed by the schema that declares it.
    expect(new Set([...floors].filter(([key]) => key.endsWith('.intervalMs')).map(([, floor]) => floor)).size)
      .toBeGreaterThan(1)
  })
})

describe('every UI states the unit its binding is in', () => {
  it('binds no seconds field as a raw millisecond count', () => {
    const offenders: string[] = []
    for (const ui of UIS) {
      for (const file of uiFiles(ui)) {
        for (const block of fieldBlocks(file.body)) {
          const stated = statedUnit(block)
          if (stated === null)
            continue
          for (const field of FIELDS) {
            if (!field.pattern.test(block))
              continue
            if (stated !== field.unit)
              offenders.push(`${file.rel}: a ${field.unit} field (${field.why}) is labelled (${stated})`)
          }
        }
      }
    }
    expect(offenders, 'the same setting read in two units on two pages').toEqual([])
  })

  /**
   * The binding half: a `v-model` hands the box the stored number itself, so a seconds field bound
   * that way shows a millisecond count however its label reads. The conversion helpers are the only
   * channel that makes a box seconds while the config stays milliseconds.
   */
  it('binds a seconds field only through the shared conversion', () => {
    const offenders: string[] = []
    for (const ui of UIS) {
      for (const file of uiFiles(ui)) {
        for (const match of file.body.matchAll(/v-model(?:\.number)?="([^"]*)"/g)) {
          const expression = match[1] ?? ''
          for (const field of FIELDS) {
            if (field.unit !== 's' || !field.pattern.test(expression))
              continue
            offenders.push(`${file.rel}: v-model on ${expression} — ${field.why}, so the box must convert`)
          }
        }
      }
    }
    expect(offenders, 'a v-model is a millisecond count in a box that is read as seconds').toEqual([])
  })

  it('still reaches the shape it forbids, so the matcher cannot silently rot', () => {
    // Both noc-console blocks exactly as they were: the cooldown and the DDNS check interval.
    const cooldown = 'cooldown (ms)</span><input v-model.number="form.notifications.policy.cooldownMs" inputmode="numeric">'
    const ddns = 'check every (ms)</span><input v-model.number="draft.intervalMs" inputmode="numeric" min="60000" step="60000">'
    expect(statedUnit(cooldown)).toBe('ms')
    expect(FIELDS.find(field => field.pattern.test(cooldown))?.unit).toBe('s')
    expect(statedUnit(ddns)).toBe('ms')
    expect(FIELDS.find(field => field.pattern.test(ddns))?.unit).toBe('s')
    // A correct block is left alone, and the health field of the same name is not this one.
    const converted = 'cooldown (s)</span><input :value="msToSeconds(policy.cooldownMs)" @input="policy.cooldownMs = secondsToMs(Number($event.target.value))">'
    expect(statedUnit(converted)).toBe('s')
    expect(FIELDS.find(field => field.pattern.test(converted))?.unit).toBe('s')
    expect(FIELDS.find(field => field.pattern.test('interval (ms)</span><input v-model="form.intervalMs">'))?.unit).toBe('ms')
  })

  it('finds every field in both UIs, so a broken walk cannot pass for free', () => {
    for (const { key, seen } of BOTH_UIS) {
      for (const ui of UIS) {
        const hit = uiFiles(ui).some(file => seen.test(file.body))
        expect(hit, `${key} must be editable in ${ui}`).toBe(true)
      }
    }
    // And the walk must reach the files, not an empty list.
    expect(uiFiles('stock').length).toBeGreaterThan(20)
    expect(uiFiles('noc-console').length).toBeGreaterThan(20)
  })
})

/**
 * The cleared half: a seconds box reports nothing, and `0` is not "nothing".
 *
 * `AGENTS.md` states the rule — *"An emptied seconds box is `NaN`, never `0`, which would store
 * 'every 0 seconds' or silently disable the throttle"* — and three boxes broke it. They read the
 * element with `Number(...)`, whose answer for `''` is `0`, so clearing `session lifetime` to retype
 * it stored `0` into a field whose floor is a minute: the client schema refused the **whole** page
 * save with `control.auth.sessionTtlMs must be at least 60000 (was 0)`. `repairNumbers` cannot help,
 * because `0` is a decided number.
 *
 * The scan above could not see it. It reads `v-model`, and these boxes are `:value`/`@input` — the
 * shape the conversion requires — so the one attribute that makes a seconds field possible is the one
 * that took it out of the guard's sight. Re-broken in place, a `:value="form.auth.lockoutMs"` went
 * green.
 *
 * So this reads the **read-back**, whichever attribute carries it, and matches the two coerce shapes
 * that turn a cleared box into a stored number rather than into "nothing decided".
 */
const COERCED_READ = /secondsToMs\(\s*Number\(/g

/** A guard against `null` only, while the control it reads reports `NaN` for a cleared box. */
const NULL_ONLY_READ = /===\s*null\s*\?\s*0\s*:\s*secondsToMs\(/g

describe('a cleared seconds box is never a stored zero', () => {
  it('reads no seconds field back through a coercion', () => {
    const offenders: string[] = []
    for (const ui of UIS) {
      for (const file of uiFiles(ui)) {
        for (const match of file.body.matchAll(COERCED_READ))
          offenders.push(`${file.rel}: ${match[0]}…) — \`Number('')\` is 0, not "nothing decided"`)
        for (const match of file.body.matchAll(NULL_ONLY_READ))
          offenders.push(`${file.rel}: ${match[0]}…) — the box reports NaN when cleared, so the null branch never runs`)
      }
    }
    expect(offenders, 'an emptied box stored a number, refusing the whole save').toEqual([])
  })

  /**
   * Anti-vacuity, both ways: the matcher must still reach the shape it forbids, and the files it
   * walks must contain the correct form — or a UI that dropped seconds boxes entirely would pass.
   */
  it('still reaches the shape it forbids, and leaves the guarded form alone', () => {
    expect([...'form.auth.sessionTtlMs = secondsToMs(Number(($event.target as HTMLInputElement).value))'.matchAll(COERCED_READ)]).toHaveLength(1)
    expect([...'policy.cooldownMs = $event === null ? 0 : secondsToMs($event)'.matchAll(NULL_ONLY_READ)]).toHaveLength(1)
    // The correct read: a helper that answers NaN, and a caller that keeps the live value.
    const guarded = 'form.auth.sessionTtlMs = secondsToMs(secondsOf($event))'
    expect([...guarded.matchAll(COERCED_READ)]).toHaveLength(0)
    expect([...guarded.matchAll(NULL_ONLY_READ)]).toHaveLength(0)

    // The walk reaches the sources, and the seconds conversion is still in use in both UIs.
    for (const ui of UIS)
      expect(uiFiles(ui).some(file => file.body.includes('msToSeconds(')), `${ui} must still edit a duration in seconds`).toBe(true)
  })
})
