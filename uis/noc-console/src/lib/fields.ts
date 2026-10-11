/**
 * The textarea round-trips the server editor and the add dialog both need: a list is
 * one entry per line, an env map is `KEY=value` per line.
 *
 * `AddServerDialog.vue` and `ServerConfigView.vue` each inlined `linesToArray` and
 * `textToEnv` verbatim, so a change to how a line is parsed had to be made twice.
 * `uis/stock` keeps its own copy on purpose — the two products differ — so this is
 * noc-console's one implementation, reached through `@/lib/fields`.
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
 * `KEY=value` lines into the map the config stores. A line with no `=` (or one that
 * starts with it, which names nothing) is skipped rather than stored under an empty
 * key; both sides of a pair are trimmed.
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
