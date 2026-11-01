import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * `AGENTS.md` states the rule it is held to: *"Move depth behind a pointer once a section outgrows a
 * screen or two; keep the rule inline"*, and *"a rule gets a line, not a section"*. Both are about a
 * reader: every session reads this file, so a rule that grew into a paragraph is paid for on every
 * read, and the reasoning belongs in `.agentDocs/` where it is opened on demand.
 *
 * Eight rounds of fixes regrew it — one entry reached 73 lines, the whole file 567 — so the limit is
 * a scan rather than a habit. A long entry means one of two things, and both have an answer: move the
 * reasoning to `.agentDocs/` and link it, or say it in fewer words.
 */

/** Longer than this and the rule is a section. */
const MAX_ENTRY_LINES = 14

/**
 * Each top-level `- **…**` rule and the indented lines that continue it.
 *
 * A list item's body is its *indented* continuation: a table or a heading after it belongs to the
 * section, not the rule. Splitting on `- **` alone made the first entry swallow the whole doc table
 * (56 lines), which is how this scan's own first version mis-measured.
 */
function entries(): Array<{ title: string, lines: number }> {
  const lines = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').split('\n')
  const found: Array<{ title: string, lines: number }> = []
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.startsWith('- **'))
      continue
    let end = index
    while (end + 1 < lines.length) {
      const next = lines[end + 1]!
      if (next.trim().length === 0 || /^\s+\S/.test(next))
        end += 1
      else
        break
    }
    const body = lines.slice(index, end + 1)
    const title = titleOf(lines[index]!)
    found.push({ title, lines: body.filter(line => line.trim().length > 0).length })
    index = end
  }
  return found
}

/**
 * The title of one rule line.
 *
 * Two forms in this file — `- **Title.** body` and `- **Title**: body` — and a title may itself hold
 * emphasis (`*this form*`). A bold run ends at `**` followed by a non-word character, which is the
 * only rule that reads all three without special-casing them.
 */
function titleOf(line: string): string {
  const close = /\*\*(?=[^\w*]|$)/g
  close.lastIndex = 4
  const match = close.exec(line)
  return match === null ? line.replace(/^- \*\*/, '').slice(0, 40) : line.slice(4, match.index)
}

describe('aGENTS.md stays guardrails, not prose', () => {
  it('finds the rules to measure, so a broken split cannot pass for free', () => {
    const found = entries()
    expect(found.length, 'the file must hold many rule entries').toBeGreaterThan(40)
    // Every entry must yield the text between its own `**…**` — some titles are a code span
    // (`` `src/shared` … ``) or two words (`Paths.`), so the marker is "not the raw line".
    const extracted = found.filter(entry => entry.title.length > 0 && !entry.title.startsWith('- **'))
    expect(extracted.length, 'every entry must yield its own title').toBe(found.length)
    expect(found.some(entry => entry.title.startsWith('A metric with no reading'))).toBe(true)
  })

  it('keeps every rule to one paragraph', () => {
    const long = entries()
      .filter(entry => entry.lines > MAX_ENTRY_LINES)
      .map(entry => `${entry.title} (${entry.lines} lines)`)
    expect(long, `a rule past ${MAX_ENTRY_LINES} lines is a section — move the reasoning to .agentDocs/ and link it`).toEqual([])
  })
})
