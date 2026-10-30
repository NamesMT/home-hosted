import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cpuBand, cpuCapacity } from '#src/shared/cpu-scale'
import { stripComments } from '../helpers/strip-comments'

/**
 * A server's `cpuPercent` is a share of **this machine**, and one rule decides it.
 *
 * The process tree is summed across cores, so four busy cores on a 24-core box read `400` — a real
 * reading, not an error. So the chart's ceiling, the sparkline's colour and the number's colour are
 * all `cpus × 100`, never `100`.
 *
 * The rule was correct in three places and stale in a fourth: `ServerDetail`'s **chart** scaled with
 * `cpus × 100` while the **number beside it** still used the fixed `40`/`80` per-core bands. On a
 * 24-core host it painted `1000%` red while the sparkline in the same tile stayed on `--accent`, and
 * the list row one click away agreed with the sparkline. That is the drift a fourth copy of
 * `Math.max(100, (cpus ?? 1) * 100)` produces, so there is now one function and this pins it.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('the cpu scale', () => {
  it('is the whole machine, so four busy cores are not the top of the chart', () => {
    expect(cpuCapacity(24)).toBe(2400)
    expect(cpuCapacity(1)).toBe(100)
  })

  it('never shrinks below one core, however the core count reads', () => {
    // A missing host frame must not divide by zero, and a nonsense zero must not clamp every value.
    expect(cpuCapacity(0)).toBe(100)
    expect(cpuCapacity(null)).toBe(100)
    expect(cpuCapacity(undefined)).toBe(100)
  })

  it('bands a value as a share of that capacity', () => {
    // A sixth of a 24-core box is normal work, not an emergency.
    expect(cpuBand(400, 24)).toBe('ok')
    expect(cpuBand(1000, 24)).toBe('warn')
    expect(cpuBand(2000, 24)).toBe('danger')
    // On a single core the same thresholds are the per-core bands the number always used.
    expect(cpuBand(40, 1)).toBe('warn')
    expect(cpuBand(80, 1)).toBe('danger')
    expect(cpuBand(39, 1)).toBe('ok')
    expect(cpuBand(2400, 24)).toBe('danger')
  })

  it('reports an absent reading as unknown, never as a healthy zero', () => {
    expect(cpuBand(null, 24)).toBe('unknown')
    expect(cpuBand(Number.NaN, 24)).toBe('unknown')
  })
})

/**
 * The scan for the class: a UI may not restate the rule.
 *
 * A test of the helper cannot see a fourth copy written beside it — that is exactly how the number's
 * band went stale — so this reads every UI source for the capacity expression and for a cpu value
 * compared against a literal band. The module is the one home; a call site imports it.
 */
describe('the UIs read the cpu scale from one module', () => {
  const sources = (): Array<{ rel: string, text: string }> => {
    const found: Array<{ rel: string, text: string }> = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist')
            continue
          walk(full)
        }
        else if (/\.(?:ts|vue)$/.test(entry.name)) {
          found.push({
            rel: path.relative(root, full).replaceAll('\\', '/'),
            // Only code is read: comments discuss the expression by name. The reader tracks strings,
            // because `'../../i18n/generated/**/*.json'` is a glob, not the start of a comment.
            text: stripComments(fs.readFileSync(full, 'utf8'), entry.name),
          })
        }
      }
    }
    for (const ui of ['stock', 'noc-console'])
      walk(path.join(root, 'uis', ui, 'src'))
    return found
  }

  it('finds the UI sources, so a broken walk cannot pass for free', () => {
    const rels = sources().map(source => source.rel)
    expect(rels).toContain('uis/stock/src/components/server/ServerCard.vue')
    expect(rels).toContain('uis/noc-console/src/components/ServerDetail.vue')
  })

  it('declares no second copy of the capacity', () => {
    const offenders = sources()
      .filter(source => /Math\.max\(\s*100\s*,/.test(source.text))
      .map(source => source.rel)
    expect(offenders, 'a UI recalculating the machine capacity instead of importing cpuCapacity').toEqual([])
  })

  /**
   * The capacity a band or a ceiling is measured against is a **core count from the frame**, never a
   * number written at the call site.
   *
   * The first version of this scan required *two* bare literals — `toneClass(cpuPercent, 40, 80)` —
   * so a capacity restated as one number walked past it: `cpuBand(cpuPercent.value, 100)` and
   * `cpuCapacity(100)` were green, and so was the whole class where the rule is copied as a single
   * ceiling. That is the same drift this module exists to end, one spelling over, so the matcher
   * reads the **call** instead: the callee, or its first argument, says the reading is a cpu one,
   * and then no argument may be a bare numeric literal. A core count arrives as
   * `control.host.value?.cpus`; a literal is always a restatement.
   */
  const RETIRED_TWO_LITERAL = /\w*cpu\w*\.?\(?\s*,\s*\d{1,3}\s*,\s*\d{1,4}\b/i

  it('still reaches the shape it forbids, and names the hole the old one had', () => {
    const planted = [
      'toneClass(cpuPercent, 40, 80)',
      'band(cpu, 40, 80)',
      'cpuColor(cpuPercent, 80, 95)',
      // One number: the shape the two-literal matcher could not see.
      'cpuBand(cpuPercent.value, 100)',
      'CPU_STROKE[cpuBand(liveReadings(server).cpuPercent, 100)]',
      'cpuCapacity(100)',
      'ceiling = cpuCapacity(2400)',
    ]
    for (const line of planted)
      expect(restatedScaleCalls(line).length, `the scan must see ${line}`).toBe(1)
    // The retired matcher is kept as evidence of the hole, not as a guard: it must stay blind to
    // the one-number shape, or this test would be proving the wrong matcher.
    expect(RETIRED_TWO_LITERAL.test('cpuBand(cpuPercent.value, 100)')).toBe(false)
    expect(RETIRED_TWO_LITERAL.test('cpuCapacity(100)')).toBe(false)
    // And it leaves calls that are not about a cpu scale alone.
    expect(restatedScaleCalls('toneClass(responseMs, 300, 1000)')).toHaveLength(0)
    expect(restatedScaleCalls('cpuCapacity(control.host.value?.cpus)')).toHaveLength(0)
    expect(restatedScaleCalls('briefBytes(rssBytes, 2)')).toHaveLength(0)
  })

  it('does not measure a cpu band or ceiling against a number written here', () => {
    const offenders: string[] = []
    for (const source of sources()) {
      for (const call of restatedScaleCalls(source.text))
        offenders.push(`${source.rel}: ${call}`)
    }
    expect(offenders, 'a cpu band measured against a fixed number, not the machine').toEqual([])
  })
})

/** A call's callee and its arguments, read by balanced brackets rather than by a character class. */
interface SourceCall {
  callee: string
  args: string[]
}

const LITERAL_QUOTES = new Set(['"', '\'', '`'])

/** The index of the quote closing the literal that opens at `from`, escapes counted; -1 if none. */
function endOfLiteral(text: string, from: number): number {
  const quote = text[from]
  for (let index = from + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === quote)
      return index
  }
  return -1
}

/** The `)` matching the `(` at `open`, or -1 when the call is unbalanced. */
function closeOf(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!
    if (LITERAL_QUOTES.has(char)) {
      const close = endOfLiteral(text, index)
      if (close < 0)
        return -1
      index = close
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0)
        return index
    }
  }
  return -1
}

/** One argument list, split on the commas at its own depth. */
function splitArgs(inner: string): string[] {
  const args: string[] = []
  let depth = 0
  let from = 0
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!
    if (LITERAL_QUOTES.has(char)) {
      const close = endOfLiteral(inner, index)
      if (close < 0)
        break
      index = close
      continue
    }
    if ('([{'.includes(char)) {
      depth += 1
      continue
    }
    if (')]}'.includes(char)) {
      depth -= 1
      continue
    }
    if (char === ',' && depth === 0) {
      args.push(inner.slice(from, index))
      from = index + 1
    }
  }
  args.push(inner.slice(from))
  return args.map(arg => arg.trim()).filter(arg => arg.length > 0)
}

/** Every call in a source, so a rule can be asked of the call rather than of a spelling. */
function callsIn(text: string): SourceCall[] {
  const found: SourceCall[] = []
  for (const match of text.matchAll(/\b([A-Z_$][\w$]*)\s*\(/gi)) {
    const open = match.index + match[0].length - 1
    const close = closeOf(text, open)
    if (close < 0)
      continue
    found.push({ callee: match[1]!, args: splitArgs(text.slice(open + 1, close)) })
  }
  return found
}

/** A bare number an author typed: `100`, `2400`, `0.8` — a restated capacity or threshold. */
const BARE_NUMBER = /^[-+]?\d+(?:\.\d+)?$/

/**
 * A callee whose name decides a scale: a band, a ceiling, a tone or a colour for a reading.
 *
 * The word is matched anywhere in the name, not as a suffix and not in a fixed list — `toneClass`
 * painted the stale per-core band, so a predicate that needed a `cpu` in the callee would have read
 * the very defect this scan was built for as "not a cpu call". `clamp`/`numberModel` are
 * deliberately outside it: a host 0–100 share is a percentage of the whole machine, and
 * `loadPerCpu` is a threshold, so neither is a server reading banded against a capacity.
 */
const SCALE_CALLEE = /band|capacity|ceiling|scale|tone|colou?r/i

/** Whether a call's callee or its own arguments name a cpu reading. */
function isCpuScaleCall(call: SourceCall): boolean {
  return SCALE_CALLEE.test(call.callee) && (/(?:^|[_a-z])cpu/i.test(call.callee) || /cpu/i.test(call.args[0] ?? ''))
}

/**
 * The calls that restate the cpu scale, each rendered the way the source wrote it.
 *
 * A cpu value is summed over a process tree, so it counts cores: the capacity it is measured
 * against is a **core count from the frame**. A bare number in such a call is that capacity or a
 * band threshold written at the call site, and the machine's own count always arrives as a value.
 */
function restatedScaleCalls(text: string): string[] {
  return callsIn(text)
    .filter(isCpuScaleCall)
    .filter(call => call.args.some(arg => BARE_NUMBER.test(arg)))
    .map(call => `${call.callee}(${call.args.join(', ')})`)
}
