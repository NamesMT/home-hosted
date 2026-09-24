import type { ConfigMigration } from '#src/config/migrations'
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
import { CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import { parseConfig, stampConfig } from '#src/config/parse'
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
  private warnings: string[] = []
  private schemaVersion = CONFIG_SCHEMA
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

  /** Keys a newer release wrote that this one ignores; nothing to refuse over. */
  get configWarnings(): string[] {
    return [...this.warnings]
  }

  /** The shape the file declares, as last read. */
  get configSchemaVersion(): number {
    return this.schemaVersion
  }

  /** Steps that would have to run before this release could use the file. */
  get pendingMigrations(): ConfigMigration[] {
    return planConfigMigrations(this.schemaVersion).steps
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
      // A missing file gets the seed, stamped and written out for the user to edit.
      const seed = stampConfig(structuredClone(this.seed))
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
    // Every write carries the stamp, so the next release can tell what wrote it.
    const stamped = stampConfig(draft)
    writeFileAtomic(this.file, `${JSON.stringify(stamped, null, 2)}\n`)
    this.raw = stamped
    this.apply(stamped)
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
    const parsed = parseConfig(raw)
    this.error = parsed.errors.length > 0 ? parsed.errors.join('; ') : null
    this.schemaVersion = parsed.schemaVersion
    this.warnings = [
      ...parsed.warnings,
      ...(parsed.unknownKeys.length === 0
        ? []
        : [`${path.basename(this.file)} carries ${parsed.unknownKeys.length} unrecognized key(s) this release ignores: ${parsed.unknownKeys.join(', ')}`]),
    ]
    // A file that cannot be trusted never replaces a config this process is already
    // running: a bad edit must not disturb supervision or blank the panel. It only
    // falls back to defaults when there is nothing good to keep (a first load).
    if (parsed.config !== null)
      this.resolvedConfig = parsed.config
    else if (this.resolvedConfig === undefined)
      this.resolvedConfig = this.resolveFallback()
  }
}
