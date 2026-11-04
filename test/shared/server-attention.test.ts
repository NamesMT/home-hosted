import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { needsAttention } from '#src/shared/server-attention'
import { stripComments } from '../helpers/strip-comments'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * "Is anything broken" is one question, and it had seven hand-picked answers.
 *
 * The panel's `/healthz` and the UIs' counts and filters each spelled the rule out as their own
 * disjunction. They had disagreed in both directions, and each surface looked right on its own:
 *
 *  - `/healthz` answered `ok` with a `conflict` entry — measured on a panel whose only entry was
 *    blocked on its port: `200 {"status":"ok"}` beside `web conflict` in `usage` and on the card,
 *    so a monitor watching the one endpoint built for it reported a healthy home with a server down;
 *  - the UIs never counted `stoppedByPanel`, so an entry the panel gave up on after its health
 *    budget was spent read as an ordinary `stopped` — the one status the rule deliberately treats
 *    as fine — while `/healthz` answered 503 about that same entry.
 */
describe('needsAttention', () => {
  it('counts every status that means the entry is down for a reason nobody chose', () => {
    // `crashed` is the obvious one; `conflict` is the one `/healthz` left out — the entry cannot
    // start because something else holds its port.
    expect(needsAttention({ status: 'crashed' })).toBe(true)
    expect(needsAttention({ status: 'conflict' })).toBe(true)
  })

  it('counts an entry the panel gave up on, which is `stopped` with a reason', () => {
    // The status alone cannot tell an operator's stop from the panel's own; this field is the one
    // thing that does, and the UIs did not read it.
    expect(needsAttention({ status: 'stopped', stoppedByPanel: true })).toBe(true)
  })

  it('counts a running entry failing its own health check', () => {
    expect(needsAttention({ status: 'running', health: 'unhealthy' })).toBe(true)
  })

  it('does not count an operator’s stop, however unhealthy it last was', () => {
    // `health` keeps its last value through a stop, so a stopped entry must not hold the panel
    // degraded for ever. This is the case the old `/healthz` filter got right and the next reader
    // is most likely to break.
    expect(needsAttention({ status: 'stopped', health: 'unhealthy' })).toBe(false)
    expect(needsAttention({ status: 'stopped', health: 'healthy' })).toBe(false)
  })

  it('does not count the ordinary states', () => {
    for (const status of ['stopped', 'starting', 'running', 'stopping', 'backoff'] as const)
      expect(needsAttention({ status, health: 'healthy' }), status).toBe(false)
    // `backoff` is a retry in flight, not a verdict; a `running` entry with no verdict yet is fine.
    expect(needsAttention({ status: 'running', health: 'unknown' })).toBe(false)
    expect(needsAttention({ status: 'running', health: 'disabled' })).toBe(false)
  })

  it('treats an absent stoppedByPanel as false', () => {
    // Optional on the wire: a newer UI reads an older panel's frame.
    expect(needsAttention({ status: 'stopped' })).toBe(false)
  })
})

/**
 * And no surface re-derives it.
 *
 * A unit test cannot see a *new* call site that spells the disjunction out again, which is exactly
 * how the seven came to differ. So this reads the sources for the construct rather than for a
 * sentence: **a `filter` whose predicate both tests a down status and tests `unhealthy`** is
 * somebody re-answering the question.
 *
 * The boundary is deliberate. Counts that ask one thing at a time are not this defect —
 * `/healthz`'s authenticated detail block counts `crashed` and `unhealthy` in two separate
 * `filter`s, and neither is a verdict about what is broken. The `if (…)` form is covered instead by
 * the next test, which names the four surfaces that own this question and the one shared answer
 * they must call.
 */
describe('the attention rule lives in one place', () => {
  function sources(dir: string, found: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist')
          continue
        sources(full, found)
      }
      else if (/\.(?:ts|vue)$/.test(entry.name)) {
        found.push(full)
      }
    }
    return found
  }

  /** Every `filter(…)` argument in `source`, parenthesis-balanced, whitespace kept. */
  function filterPredicates(source: string): string[] {
    const found: string[] = []
    for (const match of source.matchAll(/\bfilter\s*\(/g)) {
      const from = match.index + match[0].length
      let depth = 1
      let index = from
      for (; index < source.length && depth > 0; index += 1) {
        const char = source[index]!
        if (char === '(' || char === '[' || char === '{')
          depth += 1
        else if (char === ')' || char === ']' || char === '}')
          depth -= 1
      }
      found.push(source.slice(from, index - 1))
    }
    return found
  }

  it('is not spelled out again by a caller', () => {
    const files = [
      ...sources(path.join(root, 'src')),
      ...sources(path.join(root, 'uis', 'stock', 'src')),
      ...sources(path.join(root, 'uis', 'noc-console', 'src')),
    ]
    const offenders: string[] = []
    for (const file of files) {
      const rel = path.relative(root, file).replaceAll('\\', '/')
      if (rel === 'src/shared/server-attention.ts')
        continue
      const body = stripComments(fs.readFileSync(file, 'utf8'), path.basename(file))
      for (const predicate of filterPredicates(body)) {
        const namesDown = /\bstatus\s*===\s*'(?:crashed|conflict)'/.test(predicate)
        const namesUnhealthy = /\bhealth\s*===\s*'unhealthy'/.test(predicate)
        if (namesDown && namesUnhealthy) {
          offenders.push(`${rel}: filter(…) decides both a down status and health`)
          break
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('is what `/healthz` and both UIs actually call', () => {
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
    // The endpoint a monitor polls.
    expect(read('src/api/health.ts')).toContain('needsAttention')
    // Every surface that counts or filters "needs attention", in both UIs.
    for (const rel of [
      'uis/stock/src/views/OverviewView.vue',
      'uis/stock/src/views/GlobalOverviewView.vue',
      'uis/stock/src/views/ServersView.vue',
      'uis/noc-console/src/views/GlobalOverviewView.vue',
    ])
      expect(read(rel), rel).toContain('needsAttention')
  })

  /**
   * Anti-vacuity: the walk really sees these files, the extractor reads a real predicate, and the
   * stripper leaves a live comparison alone while removing one a comment merely mentions.
   */
  it('reads the sources it claims to', () => {
    expect(fs.existsSync(path.join(root, 'src', 'api', 'health.ts'))).toBe(true)
    const planted = `servers.filter(server =>\n  server.status === 'crashed' || server.health === 'unhealthy')`
    const [predicate] = filterPredicates(stripComments(planted))
    expect(predicate).toBeDefined()
    expect(predicate).toContain('\'crashed\'')
    expect(predicate).toContain('\'unhealthy\'')
    const commented = stripComments('// a filter deciding status === \'crashed\' and health === \'unhealthy\' is the bug')
    expect(commented).not.toContain('\'crashed\'')
    expect(commented).not.toContain('\'unhealthy\'')
  })
})
