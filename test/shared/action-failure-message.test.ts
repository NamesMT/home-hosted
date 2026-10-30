/* eslint-disable no-template-curly-in-string -- the plants are source text, not templates: the
   `${…}` in them is the shape under test. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../helpers/strip-comments'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * A failed lifecycle call must show the panel's own sentence, never a status code.
 *
 * This API answers two error envelopes and both are real: a thrown `DetailedError` carries
 * `{ message, code, detail }`, while a **refusal** from start/stop/restart/free-port carries
 * `{ ok: false, error }`. The UIs' call sites read only `message`, so the second became
 * `request failed with 409` — on the one button a person presses when a server will not start.
 *
 * `failureMessage` is the single reader, and this is the scan that keeps the next call site from
 * skipping it. A unit test cannot see a *new* file that hand-rolls the ternary; a source rule can.
 *
 * **The first version of this scan read one spelling of the defect, not the defect.** It matched
 * `.message ?? \`request failed with` literally, so the rule it named — "a failed response is
 * answered from the panel's own sentence" — was enforced only for that wording. Measured: a
 * hand-rolled branch rewriting the sentence as `` `request failed (${response.status})` `` walked
 * straight past it, and so did a helper that destructured the payload first
 * (`const { message } = payload ?? {}`) and only then fell back. Those are the same defect spelled
 * differently, and a matcher for one English phrase can never see them.
 *
 * So this reads the **construct**, not the sentence: a Response is a value some `await fetch(...)`/
 * `await rpc.…$post(...)` bound to a name, a failure is a branch testing that binding's `ok`, and a
 * branch that refuses (throws, or builds an `Error`) must answer through `failureMessage`. A status
 * number interpolated into an error's own text is the same rule from the other side, so it is
 * refused wherever it appears.
 *
 * The boundary is deliberate and on record: a helper that takes the status as its own *parameter*
 * (`failureText(payload, status)`) names no response binding here, so only the planted cases below
 * — one of which is exactly that shape — say what this scan does and does not reach.
 */
describe('every UI reads a failed action through failureMessage', () => {
  /** Every `.ts`/`.vue` file under a UI's `src`, in POSIX form and with comments blanked. */
  function uiFiles(ui: string): Array<{ rel: string, body: string }> {
    const found: Array<{ rel: string, body: string }> = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist')
            continue
          walk(full)
        }
        else if (/\.(?:ts|vue)$/.test(entry.name)) {
          const rel = path.relative(root, full).replaceAll('\\', '/')
          // Comments name the defect by its old wording; only code is a call site.
          found.push({ rel, body: stripComments(fs.readFileSync(full, 'utf8'), entry.name) })
        }
      }
    }
    walk(path.join(root, 'uis', ui, 'src'))
    return found.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  /** The index just past the `)`/`}` that closes the group opened at `from`. */
  function closeOf(source: string, from: number, open: string, close: string): number {
    let depth = 1
    for (let index = from; index < source.length; index += 1) {
      const char = source[index]!
      if (char === '\'' || char === '"' || char === '`') {
        for (index += 1; index < source.length && source[index] !== char; index += 1) {
          if (source[index] === '\\')
            index += 1
        }
        continue
      }
      if (char === open)
        depth += 1
      else if (char === close && --depth === 0)
        return index + 1
    }
    return source.length
  }

  /**
   * The names a Response is held in: `await fetch(...)` and the typed RPC call (`…$post(...)`) both
   * answer one, and both are used in these UIs. Read from the awaited *call* — the head is whatever
   * stands before its `(` — never from a character class, because an RPC callee is written
   * `rpc.api.servers[':id']['free-port'].$post`, which no `[\w.$]` pattern reaches.
   */
  function responseBindings(source: string): string[] {
    const names = new Set<string>()
    for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+/g)) {
      const head = match.index + match[0].length
      let open = head
      while (open < source.length && !'(\n'.includes(source[open]!))
        open += 1
      if (source[open] !== '(')
        continue
      const callee = source.slice(head, open).trim()
      if (callee === 'fetch' || /\.\$[a-z][\w$]*$/.test(callee))
        names.add(match[1]!)
    }
    return [...names]
  }

  /** The text of a `if (…)` branch: its braced block, or the one statement it guards. */
  function branchBody(source: string, from: number): string {
    let start = from
    while (start < source.length && /\s/.test(source[start]!))
      start += 1
    if (source[start] === '{')
      return source.slice(start, closeOf(source, start + 1, '{', '}'))
    // Unbraced, the statement ends at the end of its own line (`throw new Error(…)` has no `;`
    // in this corpus). Reading to the next `)` instead ran into the *next* function, whose
    // `failureMessage` call then vouched for this branch — a guard green on a real plant.
    const end = source.indexOf('\n', start)
    return source.slice(start, end < 0 ? source.length : end)
  }

  /** Every `if` branch in `source` whose condition tests `name.ok` as a failure. */
  function failedBranches(source: string, name: string): string[] {
    const condition = new RegExp(`^\\s*(?:!\\s*${name}\\s*\\.\\s*ok\\b|${name}\\s*\\.\\s*ok\\s*===\\s*false\\b|false\\s*===\\s*${name}\\s*\\.\\s*ok\\b)`)
    const found: string[] = []
    for (const match of source.matchAll(/\bif\s*\(/g)) {
      const open = match.index + match[0].length - 1
      const end = closeOf(source, open + 1, '(', ')')
      if (!condition.test(source.slice(open + 1, end - 1)))
        continue
      found.push(branchBody(source, end))
    }
    return found
  }

  /** Whether a branch refuses: it throws, or it builds the error the caller will see. */
  function refuses(body: string): boolean {
    return /\bthrow\b|\bnew\s+(?:[A-Za-z_$][\w$]*\.)*Error\s*\(/.test(body)
  }

  /**
   * Every string a person could read: a whole template literal, and a whole `+` chain.
   *
   * A status number is never text — the reader takes it as a *parameter* and only falls back to it
   * when the payload carried no sentence — so this reads the text shapes rather than one call that
   * happens to assemble them, and an error built elsewhere is reached the same way.
   */
  function textShapes(source: string): string[] {
    const found: string[] = []
    for (const match of source.matchAll(/`(?:\\[\s\S]|[^\\`])*`/g))
      found.push(match[0])
    // `'failed: (' + response.status + ')'` — a chain is one text, so it is read whole. Stepped
    // over by hand rather than by a pattern: a quantifier that may exchange whitespace with a
    // greedy `[^;\n]+` is a backtracking trap on a source this size.
    for (let index = 0; index < source.length; index += 1) {
      const quote = source[index]!
      if (quote !== '\'' && quote !== '"')
        continue
      const close = source.indexOf(quote, index + 1)
      if (close < 0)
        break
      let at = close + 1
      while (at < source.length && (source[at] === ' ' || source[at] === '\t'))
        at += 1
      if (source[at] === '+') {
        let stop = at
        while (stop < source.length && source[stop] !== ';' && source[stop] !== '\n')
          stop += 1
        found.push(source.slice(index, stop))
      }
      index = close
    }
    return found
  }

  /**
   * The defect, read as a shape: a failed response refused without the shared reader. A status
   * number in text a person reads is the same thing said the other way.
   */
  function offendersIn(source: string): string[] {
    const found: string[] = []
    const texts = textShapes(source)
    for (const name of responseBindings(source)) {
      for (const body of failedBranches(source, name)) {
        if (refuses(body) && !/\bfailureMessage\s*\(/.test(body))
          found.push(`a \`!${name}.ok\` refusal not answered by failureMessage`)
      }
      const status = new RegExp(`\\$\\{\\s*${name}\\s*\\.\\s*status\\b|\\b${name}\\s*\\.\\s*status\\s*(?=\\+)`)
      for (const text of texts) {
        if (status.test(text))
          found.push(`\`${name}.status\` rendered as text`)
      }
    }
    return found
  }

  it('has no refusal that answers with a status code instead of the panel sentence', () => {
    const offenders = ['stock', 'noc-console'].flatMap(ui =>
      uiFiles(ui).flatMap(file => offendersIn(file.body).map(hit => `${file.rel}: ${hit}`)),
    )
    expect(offenders).toEqual([])
  })

  /**
   * The matcher is a claim about every spelling, so each is driven here. The first two are what the
   * old phrase-match could not see; the third is the shape both UIs actually write.
   */
  it('still reaches every way a failed response is refused', () => {
    const planted: Array<[string, string]> = [
      [
        'async function restart(id: string) {\n'
        + '  const response = await fetch(`/api/servers/${id}/restart`, { method: \'POST\' })\n'
        + '  const payload = await response.json().catch(() => null) as { message?: string } | null\n'
        + '  if (!response.ok)\n'
        + '    throw new Error(payload?.message ?? `request failed with ${response.status}`)\n'
        + '}',
        'the sentence the old matcher was written for',
      ],
      [
        'async function restart(id: string) {\n'
        + '  const response = await fetch(`/api/servers/${id}/restart`, { method: \'POST\' })\n'
        + '  if (!response.ok)\n'
        + '    throw new Error(`request failed (${response.status})`)\n'
        + '}',
        'the same defect with the sentence rewritten, which the phrase-match read as clean',
      ],
      [
        'async function restart(id: string) {\n'
        + '  const response = await fetch(`/api/servers/${id}/restart`, { method: \'POST\' })\n'
        + '  const payload = await response.json().catch(() => null) as { message?: string } | null\n'
        + '  const { message } = payload ?? {}\n'
        + '  if (!response.ok)\n'
        + '    throw new Error(message ?? \'the restart failed\')\n'
        + '}',
        'a payload destructured first, so no `.message ??` sits on the error',
      ],
      [
        'async function freePort(id: string) {\n'
        + '  const response = await rpc.api.servers[\':id\'][\'free-port\'].$post(id)\n'
        + '  if (response.ok === false)\n'
        + '    throw new Error(`request failed with ${response.status}`)\n'
        + '}',
        'the RPC call, and the failure spelled `ok === false`',
      ],
      [
        'async function stop(id: string) {\n'
        + '  const response = await fetch(`/api/servers/${id}/stop`, { method: \'POST\' })\n'
        + '  const report = (payload: unknown): string => \'failed: (\' + response.status + \')\'\n'
        + '  return report(payload)\n'
        + '}',
        'a status concatenated into text outside the branch',
      ],
    ]
    for (const [source, why] of planted)
      expect(offendersIn(source), `the scan must see ${why}`).not.toHaveLength(0)
  })

  it('leaves the shared reader alone, in either shape it is written', () => {
    for (const clean of [
      'async function stop(id: string) {\n'
      + '  const response = await fetch(`/api/servers/${id}/stop`, { method: \'POST\' })\n'
      + '  const payload = await response.json().catch(() => null)\n'
      + '  if (!response.ok)\n'
      + '    throw new Error(failureMessage(payload, response.status))\n'
      + '  return payload\n'
      + '}',
      // A branch that only records the failure is not a refusal: it hands the value to a reader.
      'async function stop(id: string) {\n'
      + '  const response = await fetch(`/api/servers/${id}/stop`, { method: \'POST\' })\n'
      + '  const payload = await response.json().catch(() => null)\n'
      + '  if (!response.ok)\n'
      + '    return { ok: false, error: failureMessage(payload, response.status) }\n'
      + '  return payload\n'
      + '}',
      // An `ok` that is a delivery result, not a Response: it has no status to leak.
      'async function test(id: string) {\n'
      + '  const result = await api.sendTelegramTest(id, {})\n'
      + '  if (!result.ok)\n'
      + '    throw new Error(result.error ?? \'the test message failed\')\n'
      + '}',
    ])
      expect(offendersIn(clean), clean).toEqual([])
  })

  it('is what both UIs actually use for a lifecycle action', () => {
    // Anti-vacuity: the scan above passes trivially if the call sites simply stopped existing, or if
    // the shared reader were deleted. Both UIs must still route their action through it.
    for (const ui of ['stock', 'noc-console']) {
      const api = fs.readFileSync(path.join(root, 'uis', ui, 'src', 'lib', 'api.ts'), 'utf8')
      expect(api, `${ui} must import the shared reader`).toContain('failureMessage')
      const action = /export async function serverAction[\s\S]*?\n\}/.exec(api)?.[0] ?? ''
      expect(action, `${ui}'s serverAction must use the shared reader`).toContain('failureMessage(')
      // And the helper itself is one definition, in the shared client.
      expect(action, `${ui} must not re-implement it`).not.toContain('function failureMessage')
    }
    // And the walk reaches the sources, or an empty list would pass both scans.
    for (const ui of ['stock', 'noc-console'])
      expect(uiFiles(ui).length, `${ui} sources`).toBeGreaterThan(20)
  })
})
