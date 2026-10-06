/** No suggestion further than this, however long the word — see the bound in `nearestWord`. */
const ABSOLUTE_BOUND = 2

/**
 * The nearest word to a typo, or null when nothing is close.
 *
 * Two callers need it — a mistyped command and a mistyped option — so it takes its candidate list as
 * a parameter rather than reaching for one. One implementation, so both suggest by the same rule.
 *
 * Levenshtein distance, capped: only a genuinely near miss is worth naming, because suggesting an
 * unrelated word is worse than suggesting none.
 */
export function nearestWord(input: string, candidates: readonly string[]): string | null {
  if (candidates.length === 0)
    return null

  const distance = (a: string, b: string): number => {
    // Iterative single-row DP, so a long word costs no matrix.
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i]
      for (let j = 1; j <= b.length; j += 1) {
        const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
        current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution)
      }
      previous = current
    }
    return previous[b.length]!
  }

  const best = candidates
    .map(name => ({ name, d: distance(input.toLowerCase(), name.toLowerCase()) }))
    .sort((left, right) => left.d - right.d || left.name.localeCompare(right.name))[0]

  if (best === undefined)
    return null
  // Two bounds, because one is not enough for option names.
  //
  // The proportional bound alone ("half the shorter word") is what a long command needs:
  // `stats`→`status` is 1 apart and should be suggested. But short option names share prefixes —
  // `no-open` and `no-yes` are three apart while their meaningful halves are unrelated, so half of
  // six let it through and the hint named the wrong flag (`--no-open` where `--no-autostart` was
  // meant). Requiring the distance to also be small in absolute terms rejects a match carried by a
  // shared `no-` or a one-letter alias.
  const proportional = Math.floor(Math.min(input.length, best.name.length) / 2)
  const allowed = Math.min(proportional, ABSOLUTE_BOUND)
  return best.d <= allowed ? best.name : null
}
