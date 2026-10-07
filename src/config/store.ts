import type { ConfigMigration } from '#src/config/migrations'
import type { ResolvedServersFile, ResolvedWorkspaceConfig, ResolvedWorkspaceSettings } from '#src/config/schema'
import type {
  DdnsConfig,
  DdnsPatch,
  LogsConfig,
  NotificationsConfig,
  ServerConfig,
  ServerDefaults,
  ServerPatch,
  WorkspaceSettingsPatch,
} from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { type } from 'arktype'
import { planConfigMigrations, UNSTAMPED_SCHEMA } from '#src/config/migrations'
import { parseServersFile, parseTolerant, parseWorkspaceSettings, stampConfig } from '#src/config/parse'
import { applyPatch, DDNS_MERGE_KEYS, EMPTY_MERGE_KEYS, NOTIFICATION_MERGE_KEYS, SERVER_MERGE_KEYS } from '#src/config/patch'
import {
  ddnsConfigSchema,
  defaultsSchema,
  logsSchema,
  mergeDefaults,
  notificationsSchema,
  serverSchema,
  serversFileSchema,
  workspaceSettingsSchema,
} from '#src/config/schema'
import { SEED_SERVERS_FILE, SEED_WORKSPACE_SETTINGS } from '#src/config/seed'
import { ConfigError } from '#src/config/settings'
import { writeFileAtomic } from '#src/helpers/atomic'
import { validateDdnsConfig } from '#src/providers/ddns'

export { ConfigError }
export type { ResolvedServersFile, ResolvedWorkspaceSettings }

interface ReadResult {
  text: string | null
  parsed: unknown
  missing: boolean
  /** Set when the file is there but not JSON; `parsed` is null then. */
  parseError: string | null
}

function readFile(file: string): ReadResult {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { text: null, parsed: null, missing: true, parseError: null }
    return { text: null, parsed: null, missing: false, parseError: (error as Error).message }
  }
  try {
    return { text, parsed: JSON.parse(text), missing: false, parseError: null }
  }
  catch (error) {
    return { text, parsed: null, missing: false, parseError: (error as Error).message }
  }
}

/**
 * One workspace's state: its settings file (`defaults`, `logs`, `notifications`,
 * `ddns`) and its servers file, kept apart because they are written by different
 * pages and read by different parts of the panel.
 *
 * Reads stay tolerant in both: an unknown key is reported and skipped, never
 * fatal, so a file written by a newer release still opens the page that edits it.
 * A file this release cannot even parse never replaces what is already running —
 * neither the resolved config nor the `raw` every write patches.
 */
export class WorkspaceStore {
  private rawSettings: Record<string, unknown> = {}
  private rawServers: Record<string, unknown> = {}
  private liveSettings: unknown = null
  private liveServers: unknown = null
  private lastSettingsText: string | null = null
  private lastServersText: string | null = null
  private resolvedConfig!: ResolvedWorkspaceConfig
  /** A JSON parse failure, kept apart from a schema problem so `apply()` cannot clear it. */
  private settingsParseError: string | null = null
  private serversParseError: string | null = null
  private settingsError: string | null = null
  private serversError: string | null = null
  private warnings: string[] = []
  private settingsSchemaVersion = UNSTAMPED_SCHEMA
  private serversSchemaVersion = UNSTAMPED_SCHEMA
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly workspaceId: string,
    private readonly settingsFile: string,
    private readonly serversFile: string,
    private readonly seedSettings: Record<string, unknown> = SEED_WORKSPACE_SETTINGS,
    private readonly seedServers: Record<string, unknown> = SEED_SERVERS_FILE,
  ) {}

  get id(): string {
    return this.workspaceId
  }

  /** The servers config; the runtime, the watcher and the docs call it that. */
  get path(): string {
    return this.serversFile
  }

  get settingsPath(): string {
    return this.settingsFile
  }

  get config(): ResolvedWorkspaceConfig {
    return this.resolvedConfig
  }

  get servers(): ServerConfig[] {
    return this.resolvedConfig.servers
  }

  get defaults(): ServerDefaults {
    return this.resolvedConfig.defaults
  }

  get logs(): LogsConfig {
    return this.resolvedConfig.logs
  }

  get notifications(): NotificationsConfig {
    return this.resolvedConfig.notifications
  }

  get ddns(): DdnsConfig {
    return this.resolvedConfig.ddns
  }

  get configError(): string | null {
    return [
      this.settingsParseError ?? this.settingsError,
      this.serversParseError ?? this.serversError,
    ].filter(error => error !== null).join('; ') || null
  }

  get configWarnings(): string[] {
    return [...this.warnings]
  }

  get configSchemaVersion(): number {
    return Math.max(this.settingsSchemaVersion, this.serversSchemaVersion)
  }

  get pendingMigrations(): ConfigMigration[] {
    return planConfigMigrations(this.configSchemaVersion).steps
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** How many listeners are attached; a disposed owner must not add to it. */
  get listenerCount(): number {
    return this.listeners.size
  }

  getServer(id: string): ServerConfig | undefined {
    return this.servers.find(server => server.id === id)
  }

  load(): void {
    this.read()
    this.apply()
    this.notify()
  }

  /**
   * The watcher's entry point: re-reads the files only when their bytes changed.
   *
   * `changed` means the bytes on disk differ from the last trusted read, `applied`
   * means that difference produced a usable config. A revision this release cannot
   * parse is reported in the state frame while the running config is kept, which is
   * what stops an editor's typo from stopping every server — or from bricking the
   * next Save, which patches the raw object this method must therefore leave alone.
   */
  reloadFromDisk(): { changed: boolean, applied: boolean, error: string | null } {
    const settings = readFile(this.settingsFile)
    const servers = readFile(this.serversFile)
    if (settings.missing || servers.missing) {
      this.markGone(settings.missing ? this.settingsFile : this.serversFile)
      return { changed: false, applied: false, error: this.configError }
    }

    let changed = false
    let applied = false

    for (const side of ['settings', 'servers'] as const) {
      const read = side === 'settings' ? settings : servers
      const lastText = side === 'settings' ? this.lastSettingsText : this.lastServersText
      const file = side === 'settings' ? this.settingsFile : this.serversFile

      if (read.text !== lastText) {
        changed = true
        if (side === 'settings')
          this.lastSettingsText = read.text
        else
          this.lastServersText = read.text
      }

      if (read.parseError !== null) {
        const message = `cannot parse ${path.basename(file)}: ${read.parseError}`
        if (side === 'settings')
          this.settingsParseError = message
        else
          this.serversParseError = message
        // The live/raw values stay on the last trusted read.
        continue
      }

      if (read.text !== lastText) {
        if (side === 'settings') {
          this.settingsParseError = null
          this.liveSettings = read.parsed
        }
        else {
          this.serversParseError = null
          this.liveServers = read.parsed
        }
        applied = true
      }
    }

    if (!changed && !applied && this.configError === null)
      return { changed: false, applied: false, error: null }

    this.apply()
    this.notify()
    return { changed, applied, error: this.configError }
  }

  private markGone(file: string): void {
    const message = `${path.basename(file)} is gone`
    if (file === this.settingsFile)
      this.settingsError = message
    else
      this.serversError = message
  }

  private read(): void {
    let settings = readFile(this.settingsFile)
    if (settings.missing) {
      const seed = stampConfig(structuredClone(this.seedSettings))
      const text = `${JSON.stringify(seed, null, 2)}\n`
      writeFileAtomic(this.settingsFile, text)
      settings = { text, parsed: seed, missing: false, parseError: null }
    }
    let servers = readFile(this.serversFile)
    if (servers.missing) {
      const seed = stampConfig(structuredClone(this.seedServers))
      const text = `${JSON.stringify(seed, null, 2)}\n`
      writeFileAtomic(this.serversFile, text)
      servers = { text, parsed: seed, missing: false, parseError: null }
    }

    this.lastSettingsText = settings.text
    this.lastServersText = servers.text
    this.liveSettings = settings.parsed
    this.liveServers = servers.parsed
    this.settingsParseError = settings.parseError === null ? null : `cannot parse ${path.basename(this.settingsFile)}: ${settings.parseError}`
    this.serversParseError = servers.parseError === null ? null : `cannot parse ${path.basename(this.serversFile)}: ${servers.parseError}`
    if (settings.parseError === null)
      this.liveSettings = settings.parsed
    if (servers.parseError === null)
      this.liveServers = servers.parsed
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  updateServer(id: string, patch: ServerPatch): ServerConfig {
    const list = (this.rawServers.servers as Record<string, unknown>[] | undefined) ?? []
    const index = list.findIndex(entry => entry.id === id)
    if (index < 0)
      throw new ConfigError(`unknown server "${id}"`, 'UNKNOWN_SERVER')

    const draft = structuredClone(this.rawServers)
    const entry = (draft.servers as Record<string, unknown>[])[index]!
    applyPatch(entry, patch as Record<string, unknown>, SERVER_MERGE_KEYS)

    const validated = this.validateServer(entry, `servers[${index}]`)
    this.commitServers(draft)
    return validated
  }

  updateDefaults(patch: NonNullable<WorkspaceSettingsPatch['defaults']>): ServerDefaults {
    const draft = structuredClone(this.rawSettings)
    draft.defaults = { ...(draft.defaults as Record<string, unknown> ?? {}) }
    applyPatch(draft.defaults as Record<string, unknown>, patch as Record<string, unknown>, SERVER_MERGE_KEYS)

    const defaults = this.parseGroup<ServerDefaults>(defaultsSchema as unknown as (input: unknown) => unknown, draft.defaults as Record<string, unknown>, 'defaults')

    this.commitSettings(draft)
    return defaults
  }

  updateLogs(patch: NonNullable<WorkspaceSettingsPatch['logs']>): LogsConfig {
    const draft = structuredClone(this.rawSettings)
    draft.logs = { ...(draft.logs as Record<string, unknown> ?? {}) }
    applyPatch(draft.logs as Record<string, unknown>, patch as Record<string, unknown>, EMPTY_MERGE_KEYS)

    const logs = this.parseGroup<LogsConfig>(logsSchema as unknown as (input: unknown) => unknown, draft.logs as Record<string, unknown>, 'logs')

    this.commitSettings(draft)
    return logs
  }

  updateNotifications(patch: NonNullable<WorkspaceSettingsPatch['notifications']>): NotificationsConfig {
    const draft = structuredClone(this.rawSettings)
    draft.notifications = { ...(draft.notifications as Record<string, unknown> ?? {}) }
    applyPatch(draft.notifications as Record<string, unknown>, patch as Record<string, unknown>, NOTIFICATION_MERGE_KEYS)

    const notifications = this.parseGroup<NotificationsConfig>(notificationsSchema as unknown as (input: unknown) => unknown, draft.notifications as Record<string, unknown>, 'notifications')

    this.commitSettings(draft)
    return notifications
  }

  /**
   * The DDNS block merges its two nested groups and **replaces** `accounts` and
   * `domains`: those are lists, and a key-by-key merge cannot express removing a
   * hostname. A whole-block patch (the `PUT /api/ddns` route) lands the same way.
   */
  updateDdns(patch: DdnsPatch): DdnsConfig {
    const draft = structuredClone(this.rawSettings)
    draft.ddns = { ...(draft.ddns as Record<string, unknown> ?? {}) }
    applyPatch(draft.ddns as Record<string, unknown>, patch as Record<string, unknown>, DDNS_MERGE_KEYS)

    const parsed = this.parseGroup<DdnsConfig>(ddnsConfigSchema as unknown as (input: unknown) => unknown, draft.ddns as Record<string, unknown>, 'ddns')

    const problems = validateDdnsConfig(parsed)
    if (problems.length > 0)
      throw new ConfigError(`ddns: ${problems.join('; ')}`)

    this.commitSettings(draft)
    return parsed
  }

  addServer(input: Record<string, unknown>): ServerConfig {
    const draft = structuredClone(this.rawServers)
    const list = (draft.servers as Record<string, unknown>[] | undefined) ?? (draft.servers = [])
    if (list.some(entry => entry.id === input.id))
      throw new ConfigError(`server "${String(input.id)}" already exists`)

    const index = list.length
    list.push(structuredClone(input))
    const validated = this.validateServer(list[index]!, `servers[${index}]`)
    this.commitServers(draft)
    return validated
  }

  removeServer(id: string): void {
    const draft = structuredClone(this.rawServers)
    const list = (draft.servers as Record<string, unknown>[] | undefined) ?? []
    const before = list.length
    draft.servers = list.filter(entry => entry.id !== id)
    if ((draft.servers as unknown[]).length === before)
      throw new ConfigError(`unknown server "${id}"`, 'UNKNOWN_SERVER')
    this.commitServers(draft)
  }

  /**
   * Regenerates both JSON schemas for editor autocomplete, beside the files they
   * describe — derived from this store's own paths, never from a module-level
   * default, so a store over a custom root cannot write into `$HHOSTED_HOME`.
   */
  writeJsonSchema(): void {
    this.writeSchema(path.join(path.dirname(this.settingsFile), 'settings.schema.json'), workspaceSettingsSchema)
    this.writeSchema(path.join(path.dirname(this.serversFile), `${path.basename(this.serversFile, '.json')}.schema.json`), serversFileSchema)
  }

  private writeSchema(file: string, schema: { toJsonSchema: () => unknown }): void {
    const text = JSON.stringify(schema.toJsonSchema(), null, 2)
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    if (current !== text)
      writeFileAtomic(file, text)
  }

  private parseGroup<T>(schema: (input: unknown) => unknown, value: Record<string, unknown>, label: string): T {
    const parsed = parseTolerant(value, schema, label, [])
    if (parsed.error !== null)
      throw new ConfigError(`${label}: ${parsed.error}`)
    return parsed.value as T
  }

  private validateServer(entry: Record<string, unknown>, label: string): ServerConfig {
    const parsed = serverSchema(mergeDefaults(this.defaults as unknown as Record<string, unknown>, entry))
    if (parsed instanceof type.errors)
      throw new ConfigError(`${label}: ${parsed.summary}`)
    return { ...parsed, port: parsed.port ?? null }
  }

  private commitSettings(draft: Record<string, unknown>): void {
    const stamped = stampConfig(draft)
    const text = `${JSON.stringify(stamped, null, 2)}\n`
    writeFileAtomic(this.settingsFile, text)
    this.lastSettingsText = text
    this.liveSettings = stamped
    this.settingsParseError = null
    this.apply()
    this.notify()
  }

  private commitServers(draft: Record<string, unknown>): void {
    const stamped = stampConfig(draft)
    const text = `${JSON.stringify(stamped, null, 2)}\n`
    writeFileAtomic(this.serversFile, text)
    this.lastServersText = text
    this.liveServers = stamped
    this.serversParseError = null
    this.apply()
    this.notify()
  }

  private apply(): void {
    const settings = parseWorkspaceSettings(this.liveSettings)
    const servers = parseServersFile(this.liveServers, settings.config?.defaults as unknown as Record<string, unknown> ?? {})
    const haveResolved = this.resolvedConfig !== undefined

    this.settingsError = this.settingsParseError ?? (settings.errors.length > 0 ? settings.errors.join('; ') : null)
    this.serversError = this.serversParseError ?? (servers.errors.length > 0 ? servers.errors.join('; ') : null)
    this.settingsSchemaVersion = settings.schemaVersion
    this.serversSchemaVersion = servers.schemaVersion
    this.warnings = [
      ...settings.warnings,
      ...servers.warnings,
      ...(settings.unknownKeys.length === 0 && servers.unknownKeys.length === 0
        ? []
        : [`this workspace carries ${settings.unknownKeys.length + servers.unknownKeys.length} unrecognized key(s) this release ignores: ${[...settings.unknownKeys, ...servers.unknownKeys].join(', ')}`]),
    ]

    // A side this release cannot read keeps the values already running; only a
    // first load falls back to the schema defaults.
    const settingsConfig: ResolvedWorkspaceSettings = settings.config ?? (haveResolved
      ? {
          defaults: this.resolvedConfig.defaults,
          logs: this.resolvedConfig.logs,
          notifications: this.resolvedConfig.notifications,
          ddns: this.resolvedConfig.ddns,
        }
      : this.resolveSettingsFallback())
    const nextServers = servers.errors.length === 0
      ? servers.servers
      : haveResolved ? this.resolvedConfig.servers : []
    this.resolvedConfig = { ...settingsConfig, servers: nextServers }

    // The raw objects every write patches follow the last trusted read only.
    if (settings.config !== null)
      this.rawSettings = structuredClone(this.liveSettings) as Record<string, unknown>
    if (servers.errors.length === 0)
      this.rawServers = structuredClone(this.liveServers) as Record<string, unknown>
  }

  private resolveSettingsFallback(): ResolvedWorkspaceSettings {
    const defaults = defaultsSchema({})
    const logs = logsSchema({})
    const notifications = notificationsSchema({})
    const ddns = ddnsConfigSchema({})
    if (defaults instanceof type.errors || logs instanceof type.errors || notifications instanceof type.errors || ddns instanceof type.errors)
      throw new ConfigError('internal: default workspace settings failed validation')
    return { defaults, logs, notifications, ddns }
  }
}
