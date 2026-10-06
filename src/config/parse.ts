import type { MigrationOptions } from '#src/config/migrations'
import type { ResolvedGlobalConfig, ResolvedWorkspaceSettings } from '#src/config/schema'
import type { ServerConfig } from '#src/shared/contracts'
import { type } from 'arktype'
import { CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import {
  backupsSchema,
  controlSchema,
  ddnsConfigSchema,
  defaultsSchema,
  GLOBAL_SETTINGS_KEYS,
  hostSchema,
  logsSchema,
  mergeDefaults,
  notificationsSchema,
  proxyConfigSchema,
  SERVERS_FILE_KEYS,
  serverSchema,
  WORKSPACE_SETTINGS_KEYS,
} from '#src/config/schema'
import { appVersion } from '#src/helpers/version'
import { isRecord } from '#src/shared/shape'

export interface ConfigParse<T> {
  /** Null when something made the file unusable; `errors` says why. */
  config: T | null
  /** Blocking problems: what the panel must not start on. */
  errors: string[]
  /** Keys a newer release wrote that this one does not know, by path. */
  unknownKeys: string[]
  /** Real but non-blocking problems: supervision still runs, the file is still used. */
  warnings: string[]
  /** The shape the file declares; an unstamped file reads as the current one. */
  schemaVersion: number
  /** What wrote it, when the file says. */
  writtenBy: string | null
}

type Validator = (input: unknown) => unknown

/** ArkType reports an unrecognized key with this problem, carrying its path. */
const UNDECLARED = 'must be removed'

function deleteAtPath(root: Record<string, unknown>, path: readonly (string | number)[]): void {
  let node: unknown = root
  for (const key of path.slice(0, -1)) {
    node = Array.isArray(node) ? node[Number(key)] : isRecord(node) ? node[key] : undefined
    if (node === undefined)
      return
  }
  const last = path[path.length - 1]
  if (last === undefined)
    return
  if (isRecord(node))
    delete node[String(last)]
  else if (Array.isArray(node) && typeof last === 'number')
    node.splice(last, 1)
}

/**
 * Validates one object against one schema, tolerating keys the schema does not
 * know: a config written by a newer release has to keep working here, and losing
 * the *whole group* to schema defaults would silently reset the listener port,
 * the bind and the auth policy over a single unrecognized key.
 *
 * Only unrecognized keys are dropped, and each one is reported. Anything else is
 * a real problem, returned for the caller to refuse on.
 */
export function parseTolerant(
  value: unknown,
  schema: Validator,
  prefix: string,
  unknownKeys: string[],
): { value: unknown, error: string | null } {
  const candidate = structuredClone(value)

  for (let pass = 0; pass < 25; pass++) {
    const parsed = schema(candidate)
    if (!(parsed instanceof type.errors))
      return { value: parsed, error: null }

    const problems = parsed as unknown as Array<{ path: (string | number)[], problem: string }>
    const removable = problems.filter(problem => problem.problem === UNDECLARED)
    if (removable.length === 0)
      return { value: null, error: parsed.summary }

    if (!isRecord(candidate))
      return { value: null, error: parsed.summary }

    for (const problem of removable) {
      const at = `${prefix}.${problem.path.join('.')}`
      if (!unknownKeys.includes(at))
        unknownKeys.push(at)
      deleteAtPath(candidate, problem.path)
    }
  }

  return { value: null, error: 'too many unrecognized keys to ignore' }
}

interface GroupedParse<T> {
  keys: readonly string[]
  groups: ReadonlyArray<readonly [string, Validator]>
  build: (meta: { writtenBy: string, schema: number }, groups: Record<string, unknown>) => T
}

/**
 * Reads one settings file from any release: schema guard, unrecognized keys
 * reported and left on disk, blocking problems returned for the caller to refuse on.
 */
function parseGrouped<T>(raw: unknown, label: string, definition: GroupedParse<T>, options: MigrationOptions): ConfigParse<T> {
  const unknownKeys: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const result: ConfigParse<T> = { config: null, errors, unknownKeys, warnings, schemaVersion: CONFIG_SCHEMA, writtenBy: null }

  if (!isRecord(raw)) {
    errors.push(`the ${label} must contain a JSON object`)
    return result
  }

  const meta = isRecord(raw.meta) ? raw.meta : null
  const schemaVersion = typeof meta?.schema === 'number' ? meta.schema : CONFIG_SCHEMA
  const writtenBy = typeof meta?.writtenBy === 'string' && meta.writtenBy.length > 0 ? meta.writtenBy : null
  result.schemaVersion = schemaVersion
  result.writtenBy = writtenBy

  if (schemaVersion > CONFIG_SCHEMA) {
    errors.push(`written by home-hosted ${writtenBy ?? 'a newer release'} (config schema ${schemaVersion}); this release understands schema ${CONFIG_SCHEMA}`)
    return result
  }

  const { steps } = planConfigMigrations(schemaVersion, options)
  if (steps.length > 0) {
    errors.push(`config schema ${schemaVersion} needs ${steps.length} migration${steps.length === 1 ? '' : 's'} before this release can use it`)
    return result
  }

  for (const key of Object.keys(raw)) {
    if (!definition.keys.includes(key))
      unknownKeys.push(key)
  }

  const groups: Record<string, unknown> = {}
  for (const [name, schema] of definition.groups) {
    const parsed = parseTolerant(raw[name] ?? {}, schema, name, unknownKeys)
    if (parsed.error !== null)
      errors.push(`${name}: ${parsed.error}`)
    groups[name] = parsed.value ?? schema({})
  }

  if (errors.length > 0)
    return result

  result.config = definition.build({ writtenBy: writtenBy ?? '', schema: schemaVersion }, groups)
  return result
}

/** `$HHOSTED_HOME/.hh/settings.json`. */
export function parseGlobalSettings(raw: unknown, options: MigrationOptions = {}): ConfigParse<ResolvedGlobalConfig> {
  return parseGrouped(raw, 'settings file', {
    keys: GLOBAL_SETTINGS_KEYS,
    groups: [
      ['control', controlSchema as unknown as Validator],
      ['host', hostSchema as unknown as Validator],
      ['backups', backupsSchema as unknown as Validator],
      ['proxy', proxyConfigSchema as unknown as Validator],
    ],
    build: (meta, groups) => ({
      meta,
      control: groups.control as ResolvedGlobalConfig['control'],
      host: groups.host as ResolvedGlobalConfig['host'],
      backups: groups.backups as ResolvedGlobalConfig['backups'],
      proxy: groups.proxy as ResolvedGlobalConfig['proxy'],
    }),
  }, options)
}

/** `$HHOSTED_HOME/.hh/<id>/settings.json`. */
export function parseWorkspaceSettings(raw: unknown, options: MigrationOptions = {}): ConfigParse<ResolvedWorkspaceSettings> {
  return parseGrouped(raw, 'workspace settings file', {
    keys: WORKSPACE_SETTINGS_KEYS,
    groups: [
      ['defaults', defaultsSchema as unknown as Validator],
      ['logs', logsSchema as unknown as Validator],
      ['notifications', notificationsSchema as unknown as Validator],
      ['ddns', ddnsConfigSchema as unknown as Validator],
    ],
    build: (meta, groups) => ({
      meta,
      defaults: groups.defaults as ResolvedWorkspaceSettings['defaults'],
      logs: groups.logs as ResolvedWorkspaceSettings['logs'],
      notifications: groups.notifications as ResolvedWorkspaceSettings['notifications'],
      ddns: groups.ddns as ResolvedWorkspaceSettings['ddns'],
    }),
  }, options)
}

export interface ServersParse {
  servers: ServerConfig[]
  errors: string[]
  unknownKeys: string[]
  warnings: string[]
  schemaVersion: number
  writtenBy: string | null
}

/**
 * `$HHOSTED_HOME/.hh/<id>/servers.config.json`: just the entries, each resolved
 * against the workspace's defaults.
 */
export function parseServersFile(raw: unknown, defaults: Record<string, unknown>, options: MigrationOptions = {}): ServersParse {
  const unknownKeys: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const result: ServersParse = { servers: [], errors, unknownKeys, warnings, schemaVersion: CONFIG_SCHEMA, writtenBy: null }

  if (!isRecord(raw)) {
    errors.push('the servers config must contain a JSON object')
    return result
  }

  const meta = isRecord(raw.meta) ? raw.meta : null
  const schemaVersion = typeof meta?.schema === 'number' ? meta.schema : CONFIG_SCHEMA
  const writtenBy = typeof meta?.writtenBy === 'string' && meta.writtenBy.length > 0 ? meta.writtenBy : null
  result.schemaVersion = schemaVersion
  result.writtenBy = writtenBy

  if (schemaVersion > CONFIG_SCHEMA) {
    errors.push(`written by home-hosted ${writtenBy ?? 'a newer release'} (config schema ${schemaVersion}); this release understands schema ${CONFIG_SCHEMA}`)
    return result
  }

  const { steps } = planConfigMigrations(schemaVersion, options)
  if (steps.length > 0) {
    errors.push(`config schema ${schemaVersion} needs ${steps.length} migration${steps.length === 1 ? '' : 's'} before this release can use it`)
    return result
  }

  for (const key of Object.keys(raw)) {
    if (!(SERVERS_FILE_KEYS as readonly string[]).includes(key))
      unknownKeys.push(key)
  }

  const seen = new Set<string>()
  const rawServers = Array.isArray(raw.servers) ? raw.servers : []

  rawServers.forEach((entry, index) => {
    const label = `servers[${index}]`
    const merged = isRecord(entry) ? mergeDefaults(defaults, entry) : entry
    const parsed = parseTolerant(merged, serverSchema as unknown as Validator, label, unknownKeys)
    if (parsed.error !== null) {
      const id = isRecord(entry) ? entry.id : undefined
      errors.push(`${label}${typeof id === 'string' ? ` ("${id}")` : ''}: ${parsed.error}`)
      return
    }
    const server = parsed.value as ServerConfig
    if (seen.has(server.id)) {
      errors.push(`${label}: duplicate id "${server.id}"`)
      return
    }
    seen.add(server.id)
    result.servers.push({ ...server, port: server.port ?? null })
  })

  // Cross-field problems are reported, never fatal: supervision still runs.
  warnings.push(...validateCrossField(result.servers))

  return result
}

/**
 * Config that validates field-by-field but is wrong as a whole.
 *
 * Warned rather than refused, because supervision still runs and a hard failure would take a working
 * panel down over a setting one field away from correct.
 */
function validateCrossField(servers: ServerConfig[]): string[] {
  const ids = new Set(servers.map(server => server.id))
  const errors: string[] = []

  for (const server of servers) {
    const { health } = server
    // A `HEAD` response carries no body, so the probe skips the assertion — and a health check that
    // silently stops checking is worse than one that fails, because nothing says it did. Measured with
    // the real probe: `method: HEAD` plus a body requirement reported a server healthy whose body did
    // not match. Left as a warning: the entry still runs, and the person is told what to change.
    if (health.mode === 'http' && health.http.method === 'HEAD' && health.http.expectBody.length > 0)
      errors.push(`"${server.id}" requires a response body with method HEAD, which has none — the body check is ignored`)

    for (const dependency of server.dependsOn) {
      if (dependency === server.id)
        errors.push(`"${server.id}" depends on itself`)
      else if (!ids.has(dependency))
        errors.push(`"${server.id}" depends on unknown server "${dependency}"`)
    }
  }

  const visiting = new Set<string>()
  const settled = new Set<string>()
  const byId = new Map(servers.map(server => [server.id, server]))
  const walk = (id: string): void => {
    if (settled.has(id))
      return
    if (visiting.has(id)) {
      errors.push(`dependency cycle through "${id}"`)
      return
    }
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) walk(dependency)
    visiting.delete(id)
    settled.add(id)
  }
  for (const server of servers) walk(server.id)

  return [...new Set(errors)]
}

/** Adds the stamp every write carries, so the next release can tell what wrote the file. */
export function stampConfig<T extends { $schema?: string, meta?: unknown }>(draft: T): T {
  const { $schema, meta: _meta, ...rest } = draft
  return {
    ...($schema === undefined ? {} : { $schema }),
    meta: { writtenBy: appVersion(), schema: CONFIG_SCHEMA },
    ...rest,
  } as T
}
