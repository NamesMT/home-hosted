/**
 * The textarea round-trips a server form needs: a list is one entry per line, an env
 * map is `KEY=value` per line.
 *
 * These were written out in `uis/stock` and `uis/noc-console` and had already been
 * copy-pasted twice inside one of them. The two products differ elsewhere, but not
 * here — and a change to how a line is parsed has to be made once, not in four places.
 * Imports nothing, so it is safe in a UI bundle.
 */

/** One entry per line, blank lines dropped, each entry trimmed. */
export function linesToArray(value: string): string[] {
  return value.split('\n').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/** An env map as `KEY=value` lines, in the map's own order. */
export function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')
}

/**
 * `KEY=value` lines into the map the config stores. A line with no `=`, or one that
 * starts with it (which names nothing), is skipped rather than stored under an empty
 * key; both halves of a pair are trimmed.
 */
export function textToEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of linesToArray(value)) {
    const separator = line.indexOf('=')
    if (separator <= 0)
      continue
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return env
}

/** Comma-separated ids into the list the config stores (`dependsOn`). */
export function commaList(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}
