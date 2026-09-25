/**
 * The textarea round-trips the server editor and the add dialog share: a list is
 * one entry per line, an env map is `KEY=value` per line.
 */

export function linesToArray(value: string): string[] {
  return value.split('\n').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

export function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')
}

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

/** Comma-separated ids into the list the config stores. */
export function commaList(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}
