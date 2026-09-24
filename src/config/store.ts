import type { RawConfig, ResolvedConfig, ServerConfig } from '#src/config/schema'
import type {
  BackupsConfig,
  ControlConfig,
  HostConfig,
  LogsConfig,
  NotificationsConfig,
  ServerDefaults,
  ServerPatch,
  SettingsPatch,
} from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { type } from 'arktype'
import {
  backupsSchema,
  configSchema,
  controlSchema,
  defaultsSchema,
  hostSchema,
  logsSchema,
  notificationsSchema,
  serverSchema,
} from '#src/config/schema'
import { SEED_CONFIG } from '#src/config/seed'
import { writeFileAtomic } from '#src/helpers/atomic'
import { configSchemaPath } from '#src/helpers/paths'

/** Nested groups a patch merges into instead of replacing. */
const SERVER_MERGE_KEYS = new Set(['restart', 'health', 'stop'])
const CONTROL_MERGE_KEYS = new Set(['auth', 'tls'])
const NOTIFICATION_MERGE_KEYS = new Set(['telegram'])
const EMPTY_MERGE_KEYS = new Set<string>()

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function formatErrors(errors: type.errors): string {
  return errors.summary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const done = new Set<string>()
  const byId = new Map(servers.map(server => [server.id, server]))

  const walk = (id: string, trail: string[]): void => {
    if (done.has(id))
      return
    if (visiting.has(id)) {
      errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`)
      return
    }
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (ids.has(dependency) && dependency !== id)
        walk(dependency, [...trail, id])
    }
    visiting.delete(id)
    done.add(id)
  }

  for (const server of servers) walk(server.id, [])
  return errors
}

/** Nested groups merge so a partial edit never drops a sibling field. */
function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>, mergeKeys: Set<string>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined)
      continue
    if (mergeKeys.has(key) && isRecord(value) && isRecord(target[key])) {
      target[key] = mergeGroup(target[key], value)
      continue
    }
    target[key] = value
  }
}

/**
 * Merges one nested group recursively — `health.http` is a group of its own, and
 * replacing it wholesale would silently reset the siblings a partial patch never
 * mentioned. An explicit `null` removes a key, which is how a schema-optional
 * field is cleared.
 */
function mergeGroup(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined)
      continue
    if (value === null) {
      delete merged[key]
      continue
    }
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeGroup(merged[key] as Record<string, unknown>, value)
      continue
    }
    merged[key] = value
  }
  return merged
}

export class ConfigStore {
  private raw: RawConfig = {}
  private resolvedConfig!: ResolvedConfig
  private error: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string, private readonly seed: RawConfig = SEED_CONFIG) {}

  get path(): string {
    return this.file
  }

  get config(): ResolvedConfig {
    return this.resolvedConfig
  }

  get configError(): string | null {
    return this.error
  }

  get servers(): ServerConfig[] {
    return this.resolvedConfig.servers
  }

  get defaults(): ResolvedConfig['defaults'] {
    return this.resolvedConfig.defaults
  }

  get rawConfig(): RawConfig {
    return structuredClone(this.raw)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getServer(id: string): ServerConfig | undefined {
    return this.servers.find(server => server.id === id)
  }

  /**
   * Reads the file and tells the listeners, so whatever wrote it — the settings
   * page, or a restored backup landing on disk — becomes the live config.
   */
  load(): void {
    this.read()
    this.notify()
  }

  private read(): void {
    if (!fs.existsSync(this.file)) {
      // A missing file gets the seed, written out for the user to edit.
      const seed = structuredClone(this.seed)
      writeFileAtomic(this.file, `${JSON.stringify(seed, null, 2)}\n`)
      this.raw = seed
      this.apply(seed)
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    }
    catch (error) {
      this.error = `cannot parse ${path.basename(this.file)}: ${(error as Error).message}`
      this.raw = {}
      this.resolvedConfig = this.resolveFallback()
      return
    }

    if (!isRecord(parsed)) {
      this.error = `${path.basename(this.file)} must contain a JSON object`
      this.raw = {}
      this.resolvedConfig = this.resolveFallback()
      return
    }

    this.apply(parsed as RawConfig)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  updateServer(id: string, patch: ServerPatch): ServerConfig {
    const index = this.raw.servers?.findIndex(entry => entry.id === id) ?? -1
    if (index < 0)
      throw new ConfigError(`unknown server "${id}"`)

    const draft = structuredClone(this.raw)
    const entry = draft.servers![index]!

    applyPatch(entry, patch as Record<string, unknown>, SERVER_MERGE_KEYS)

    const validated = this.validateServer(entry, `servers[${index}]`)
    this.commit(draft)
    return validated
  }

  updateControl(patch: NonNullable<SettingsPatch['control']>): ControlConfig {
    const draft = structuredClone(this.raw)
    draft.control = { ...(draft.control ?? {}) }
    applyPatch(draft.control, patch as Record<string, unknown>, CONTROL_MERGE_KEYS)

    const control = controlSchema(draft.control)
    if (control instanceof type.errors)
      throw new ConfigError(`control: ${formatErrors(control)}`)

    this.commit(draft)
    return control
  }

  updateLogs(patch: NonNullable<SettingsPatch['logs']>): LogsConfig {
    const draft = structuredClone(this.raw)
    draft.logs = { ...(draft.logs ?? {}) }
    applyPatch(draft.logs, patch as Record<string, unknown>, EMPTY_MERGE_KEYS)

    const logs = logsSchema(draft.logs)
    if (logs instanceof type.errors)
      throw new ConfigError(`logs: ${formatErrors(logs)}`)

    this.commit(draft)
    return logs
  }

  updateNotifications(patch: NonNullable<SettingsPatch['notifications']>): NotificationsConfig {
    const draft = structuredClone(this.raw)
    draft.notifications = { ...(draft.notifications ?? {}) }
    applyPatch(draft.notifications, patch as Record<string, unknown>, NOTIFICATION_MERGE_KEYS)

    const notifications = notificationsSchema(draft.notifications)
    if (notifications instanceof type.errors)
      throw new ConfigError(`notifications: ${formatErrors(notifications)}`)

    this.commit(draft)
    return notifications
  }

  updateHost(patch: NonNullable<SettingsPatch['host']>): HostConfig {
    const draft = structuredClone(this.raw)
    draft.host = { ...(draft.host ?? {}) }
    applyPatch(draft.host, patch as Record<string, unknown>, EMPTY_MERGE_KEYS)

    const host = hostSchema(draft.host)
    if (host instanceof type.errors)
      throw new ConfigError(`host: ${formatErrors(host)}`)

    this.commit(draft)
    return host
  }

  updateBackups(patch: NonNullable<SettingsPatch['backups']>): BackupsConfig {
    const draft = structuredClone(this.raw)
    draft.backups = { ...(draft.backups ?? {}) }
    applyPatch(draft.backups, patch as Record<string, unknown>, EMPTY_MERGE_KEYS)

    const backups = backupsSchema(draft.backups)
    if (backups instanceof type.errors)
      throw new ConfigError(`backups: ${formatErrors(backups)}`)

    this.commit(draft)
    return backups
  }

  updateDefaults(patch: NonNullable<SettingsPatch['defaults']>): ServerDefaults {
    const draft = structuredClone(this.raw)
    draft.defaults = { ...(draft.defaults ?? {}) }
    applyPatch(draft.defaults, patch as Record<string, unknown>, SERVER_MERGE_KEYS)

    const defaults = defaultsSchema(draft.defaults)
    if (defaults instanceof type.errors)
      throw new ConfigError(`defaults: ${formatErrors(defaults)}`)

    this.commit(draft)
    return defaults
  }

  addServer(input: Record<string, unknown>): ServerConfig {
    const draft = structuredClone(this.raw)
    draft.servers ??= []
    if (draft.servers.some(entry => entry.id === input.id)) {
      throw new ConfigError(`server "${String(input.id)}" already exists`)
    }

    const index = draft.servers.length
    draft.servers.push(structuredClone(input))
    const validated = this.validateServer(draft.servers[index]!, `servers[${index}]`)
    this.commit(draft)
    return validated
  }

  removeServer(id: string): void {
    const draft = structuredClone(this.raw)
    const before = draft.servers?.length ?? 0
    draft.servers = (draft.servers ?? []).filter(entry => entry.id !== id)
    if (draft.servers.length === before)
      throw new ConfigError(`unknown server "${id}"`)
    this.commit(draft)
  }

  /** Regenerates `servers.config.schema.json` for editor autocomplete. */
  writeJsonSchema(): void {
    const schema = JSON.stringify(configSchema.toJsonSchema(), null, 2)
    const current = fs.existsSync(configSchemaPath) ? fs.readFileSync(configSchemaPath, 'utf8') : null
    if (current !== schema)
      writeFileAtomic(configSchemaPath, schema)
  }

  private validateServer(entry: Record<string, unknown>, label: string): ServerConfig {
    const parsed = serverSchema({ ...this.defaults, ...entry })
    if (parsed instanceof type.errors)
      throw new ConfigError(`${label}: ${formatErrors(parsed)}`)
    return { ...parsed, port: parsed.port ?? null }
  }

  private commit(draft: RawConfig): void {
    writeFileAtomic(this.file, `${JSON.stringify(draft, null, 2)}\n`)
    this.raw = draft
    this.apply(draft)
    this.notify()
  }

  private resolveFallback(): ResolvedConfig {
    const control = controlSchema({})
    const defaults = defaultsSchema({})
    if (control instanceof type.errors || defaults instanceof type.errors) {
      throw new ConfigError('internal: default config failed validation')
    }
    const logs = logsSchema({})
    const notifications = notificationsSchema({})
    const host = hostSchema({})
    const backups = backupsSchema({})
    if (logs instanceof type.errors || notifications instanceof type.errors || host instanceof type.errors || backups instanceof type.errors) {
      throw new ConfigError('internal: default settings failed validation')
    }
    return { control, defaults, logs, notifications, host, backups, servers: [] }
  }

  private apply(raw: RawConfig): void {
    this.raw = raw
    const errors: string[] = []

    const control = controlSchema(raw.control ?? {})
    const defaults = defaultsSchema(raw.defaults ?? {})
    const logs = logsSchema(raw.logs ?? {})
    const notifications = notificationsSchema(raw.notifications ?? {})
    const host = hostSchema(raw.host ?? {})
    const backups = backupsSchema(raw.backups ?? {})
    if (control instanceof type.errors)
      errors.push(`control: ${formatErrors(control)}`)
    if (defaults instanceof type.errors)
      errors.push(`defaults: ${formatErrors(defaults)}`)
    if (logs instanceof type.errors)
      errors.push(`logs: ${formatErrors(logs)}`)
    if (notifications instanceof type.errors)
      errors.push(`notifications: ${formatErrors(notifications)}`)
    if (host instanceof type.errors)
      errors.push(`host: ${formatErrors(host)}`)
    if (backups instanceof type.errors)
      errors.push(`backups: ${formatErrors(backups)}`)

    const resolvedDefaults = defaults instanceof type.errors ? defaultsSchema({}) as ResolvedConfig['defaults'] : defaults
    const servers: ServerConfig[] = []
    const seen = new Set<string>()
    const rawServers = Array.isArray(raw.servers) ? raw.servers : []

    rawServers.forEach((entry, index) => {
      const parsed = serverSchema({ ...resolvedDefaults, ...entry })
      if (parsed instanceof type.errors) {
        errors.push(`servers[${index}] (${(entry as { id?: string })?.id ?? 'no id'}): ${formatErrors(parsed)}`)
        return
      }
      if (seen.has(parsed.id)) {
        errors.push(`servers[${index}]: duplicate id "${parsed.id}"`)
        return
      }
      seen.add(parsed.id)
      servers.push({ ...parsed, port: parsed.port ?? null })
    })

    errors.push(...validateDependencies(servers))

    this.error = errors.length > 0 ? errors.join('; ') : null
    this.resolvedConfig = {
      $schema: raw.$schema,
      control: control instanceof type.errors ? controlSchema({}) as ResolvedConfig['control'] : control,
      defaults: resolvedDefaults,
      logs: logs instanceof type.errors ? logsSchema({}) as ResolvedConfig['logs'] : logs,
      notifications: notifications instanceof type.errors
        ? notificationsSchema({}) as ResolvedConfig['notifications']
        : notifications,
      host: host instanceof type.errors ? hostSchema({}) as ResolvedConfig['host'] : host,
      backups: backups instanceof type.errors ? backupsSchema({}) as ResolvedConfig['backups'] : backups,
      servers,
    }
  }
}
