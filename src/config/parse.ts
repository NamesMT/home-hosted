import type { MigrationOptions } from '#src/config/migrations'
import type { RawConfig, ResolvedConfig } from '#src/config/schema'
import type { ServerConfig } from '#src/shared/contracts'
import { type } from 'arktype'
import { CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import {
  backupsSchema,
  CONFIG_KEYS,
  controlSchema,
  defaultsSchema,
  hostSchema,
  logsSchema,
  notificationsSchema,

  serverSchema,
} from '#src/config/schema'
import { appVersion } from '#src/helpers/version'

export interface ConfigParse {
  /** Null when something made the config unusable; `errors` says why. */
  config: ResolvedConfig | null
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Validator = (input: unknown) => unknown

const GROUPS: ReadonlyArray<readonly [string, Validator]> = [
  ['control', controlSchema as unknown as Validator],
  ['defaults', defaultsSchema as unknown as Validator],
  ['logs', logsSchema as unknown as Validator],
  ['notifications', notificationsSchema as unknown as Validator],
  ['host', hostSchema as unknown as Validator],
  ['backups', backupsSchema as unknown as Validator],
]

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
function parseTolerant(
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

/**
 * Reads a `servers.config.json` from any release. Unrecognized keys are reported
 * and left on disk; blocking problems — including a file this release cannot
 * understand — land in `errors` and leave `config` null.
 */
export function parseConfig(raw: unknown, options: MigrationOptions = {}): ConfigParse {
  const unknownKeys: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const result: ConfigParse = { config: null, errors, unknownKeys, warnings, schemaVersion: CONFIG_SCHEMA, writtenBy: null }

  if (!isRecord(raw)) {
    errors.push('the config must contain a JSON object')
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
    if (!(CONFIG_KEYS as readonly string[]).includes(key))
      unknownKeys.push(key)
  }

  const groups: Record<string, unknown> = {}
  for (const [name, schema] of GROUPS) {
    const parsed = parseTolerant(raw[name] ?? {}, schema, name, unknownKeys)
    if (parsed.error !== null)
      errors.push(`${name}: ${parsed.error}`)
    groups[name] = parsed.value ?? schema({})
  }

  const defaults = groups.defaults as ResolvedConfig['defaults']
  const servers: ServerConfig[] = []
  const seen = new Set<string>()
  const rawServers = Array.isArray(raw.servers) ? raw.servers : []

  rawServers.forEach((entry, index) => {
    const label = `servers[${index}]`
    const merged = isRecord(entry) ? { ...defaults, ...entry } : entry
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
    servers.push({ ...server, port: server.port ?? null })
  })

  // Dangling dependencies and cycles are reported, never fatal: supervision still runs.
  warnings.push(...validateDependencies(servers))

  if (errors.length > 0)
    return result

  result.config = {
    meta: { writtenBy: writtenBy ?? '', schema: schemaVersion },
    control: groups.control as ResolvedConfig['control'],
    defaults,
    logs: groups.logs as ResolvedConfig['logs'],
    notifications: groups.notifications as ResolvedConfig['notifications'],
    host: groups.host as ResolvedConfig['host'],
    backups: groups.backups as ResolvedConfig['backups'],
    servers,
  } as ResolvedConfig

  return result
}

/** Dangling dependencies and cycles are reported, not fatal: supervision still runs. */
function validateDependencies(servers: ServerConfig[]): string[] {
  const ids = new Set(servers.map(server => server.id))
  const errors: string[] = []

  for (const server of servers) {
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
export function stampConfig(draft: RawConfig): RawConfig {
  const { $schema, meta: _meta, ...rest } = draft
  return {
    ...($schema === undefined ? {} : { $schema }),
    meta: { writtenBy: appVersion(), schema: CONFIG_SCHEMA },
    ...rest,
  }
}
