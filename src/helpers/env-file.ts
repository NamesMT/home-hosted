import path from 'node:path'
import { readStateFile } from '#src/helpers/config-text'
import { errorMessage } from '#src/shared/error-message'

/** `KEY=value` files, with optional `export `, `#` comments and quoted values. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#'))
      continue

    const assignment = line.startsWith('export ') ? line.slice(7) : line
    const separator = assignment.indexOf('=')
    if (separator <= 0)
      continue

    const key = assignment.slice(0, separator).trim()
    let value = assignment.slice(separator + 1).trim()
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }

  return env
}

/**
 * Missing files are not an error: an env file is an optional override layer.
 *
 * Read through `readStateFile`: an entry's `envFile` is written by a person, not by this panel, so a
 * Windows editor's byte-order mark or UTF-16 save is the normal state of it. A `'utf8'` read made
 * every key carry a NUL — dropped by `resolveSpawn` as "an environment key containing a null byte" —
 * so the process started without the secret the file exists to keep out of the config.
 */
export function loadEnvFile(file: string): { env: Record<string, string>, path: string, error: string | null } {
  try {
    return { env: parseEnvFile(readStateFile(file)), path: file, error: null }
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT')
      return { env: {}, path: file, error: null }
    return { env: {}, path: file, error: errorMessage(error) }
  }
}

const VARIABLE = /\$\{([A-Z_]\w*)\}/gi

/** Expands `${VAR}` from the given vars; unknown references are left visible. */
export function expandEnv(value: string, vars: Record<string, string | undefined>): string {
  return value.replace(VARIABLE, (match, name: string) => vars[name] ?? match)
}

export function expandEnvRecord(record: Record<string, string>, vars: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandEnv(value, vars)]))
}

export function expandEnvList(values: string[], vars: Record<string, string | undefined>): string[] {
  return values.map(value => expandEnv(value, vars))
}

export function resolveEnvFilePath(file: string, cwd: string): string {
  if (path.isAbsolute(file))
    return file
  return path.resolve(cwd, file)
}
