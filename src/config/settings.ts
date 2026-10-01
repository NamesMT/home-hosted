import type { ResolvedGlobalConfig } from '#src/config/schema'
import type { BackupsConfig, ControlConfig, HostConfig, ProxyConfig, ProxyPatch, SettingsPatch } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { type } from 'arktype'
import { CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import { parseGlobalSettings, parseTolerant, stampConfig } from '#src/config/parse'
import { applyPatch, CONTROL_MERGE_KEYS, EMPTY_MERGE_KEYS, PROXY_MERGE_KEYS } from '#src/config/patch'
import { backupsSchema, controlSchema, globalSettingsSchema, hostSchema, proxyConfigSchema } from '#src/config/schema'
import { SEED_GLOBAL_SETTINGS } from '#src/config/seed'
import { writeFileAtomic } from '#src/helpers/atomic'
import { globalSettingsPath } from '#src/helpers/paths'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/**
 * The panel-wide settings file (`$HHOSTED_HOME/.hh/settings.json`): the listener,
 * authentication, TLS policy, host vitals and backups. Nothing here belongs to a
 * workspace, which is why it sits above them.
 */
export class GlobalSettingsStore {
  private raw: Record<string, unknown> = {}
  /** The bytes behind the live settings, so a watcher can tell a real edit from our own write. */
  private lastText: string | null = null
  private resolvedConfig!: ResolvedGlobalConfig
  private error: string | null = null
  private warnings: string[] = []
  private schemaVersion = CONFIG_SCHEMA
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string = globalSettingsPath, private readonly seed: Record<string, unknown> = SEED_GLOBAL_SETTINGS) {}

  get path(): string {
    return this.file
  }

  get config(): ResolvedGlobalConfig {
    return this.resolvedConfig
  }

  get control(): ControlConfig {
    return this.resolvedConfig.control
  }

  get host(): HostConfig {
    return this.resolvedConfig.host
  }

  get backups(): BackupsConfig {
    return this.resolvedConfig.backups
  }

  get proxy(): ProxyConfig {
    return this.resolvedConfig.proxy
  }

  get configError(): string | null {
    return this.error
  }

  /** Keys a newer release wrote that this one ignores; nothing to refuse over. */
  get configWarnings(): string[] {
    return [...this.warnings]
  }

  get configSchemaVersion(): number {
    return this.schemaVersion
  }

  /** Steps that would have to run before this release could use the file. */
  get pendingMigrations() {
    return planConfigMigrations(this.schemaVersion).steps
  }

  get rawConfig(): Record<string, unknown> {
    return structuredClone(this.raw)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(): void {
    this.read()
    this.notify()
  }

  reloadFromDisk(): { changed: boolean, applied: boolean, error: string | null } {
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    }
    catch {
      this.error = `${path.basename(this.file)} is gone`
      return { changed: false, applied: false, error: this.error }
    }

    if (text === this.lastText) {
      if (this.error !== null) {
        this.error = null
        this.load()
      }
      return { changed: false, applied: false, error: null }
    }

    const before = this.resolvedConfig
    this.load()
    return { changed: true, applied: this.resolvedConfig !== before, error: this.error }
  }

  private read(): void {
    if (!fs.existsSync(this.file)) {
      const seed = stampConfig(structuredClone(this.seed))
      const text = `${JSON.stringify(seed, null, 2)}\n`
      writeFileAtomic(this.file, text)
      this.lastText = text
      this.raw = seed
      this.apply(seed)
      return
    }

    let text: string
    let parsed: unknown
    try {
      text = fs.readFileSync(this.file, 'utf8')
      parsed = JSON.parse(text)
    }
    catch (error) {
      this.error = `cannot parse ${path.basename(this.file)}: ${(error as Error).message}`
      if (this.resolvedConfig === undefined) {
        this.raw = {}
        this.resolvedConfig = this.resolveFallback()
      }
      return
    }

    this.lastText = text
    this.apply(parsed)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  updateControl(patch: NonNullable<SettingsPatch['control']>): ControlConfig {
    const draft = structuredClone(this.raw)
    draft.control = { ...(draft.control as Record<string, unknown> ?? {}) }
    applyPatch(draft.control as Record<string, unknown>, patch as Record<string, unknown>, CONTROL_MERGE_KEYS)

    const control = this.parseGroup<ControlConfig>(controlSchema as unknown as (input: unknown) => unknown, draft.control as Record<string, unknown>, 'control')

    this.commit(draft)
    return control
  }

  updateHost(patch: NonNullable<SettingsPatch['host']>): HostConfig {
    const draft = structuredClone(this.raw)
    draft.host = { ...(draft.host as Record<string, unknown> ?? {}) }
    applyPatch(draft.host as Record<string, unknown>, patch as Record<string, unknown>, EMPTY_MERGE_KEYS)

    const host = this.parseGroup<HostConfig>(hostSchema as unknown as (input: unknown) => unknown, draft.host as Record<string, unknown>, 'host')

    this.commit(draft)
    return host
  }

  updateBackups(patch: NonNullable<SettingsPatch['backups']>): BackupsConfig {
    const draft = structuredClone(this.raw)
    draft.backups = { ...(draft.backups as Record<string, unknown> ?? {}) }
    applyPatch(draft.backups as Record<string, unknown>, patch as Record<string, unknown>, EMPTY_MERGE_KEYS)

    const backups = this.parseGroup<BackupsConfig>(backupsSchema as unknown as (input: unknown) => unknown, draft.backups as Record<string, unknown>, 'backups')

    this.commit(draft)
    return backups
  }

  /** The reverse proxy. `routes` is a list a patch replaces; `dns01` merges key by key. */
  updateProxy(patch: ProxyPatch): ProxyConfig {
    const draft = structuredClone(this.raw)
    draft.proxy = { ...(draft.proxy as Record<string, unknown> ?? {}) }
    applyPatch(draft.proxy as Record<string, unknown>, patch as Record<string, unknown>, PROXY_MERGE_KEYS)

    const proxy = this.parseGroup<ProxyConfig>(proxyConfigSchema as unknown as (input: unknown) => unknown, draft.proxy as Record<string, unknown>, 'proxy')

    this.commit(draft)
    return proxy
  }

  /** Regenerates `settings.schema.json` for editor autocomplete, beside the file it describes. */
  writeJsonSchema(): void {
    const target = path.join(path.dirname(this.file), 'settings.schema.json')
    const schema = JSON.stringify(globalSettingsSchema.toJsonSchema(), null, 2)
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
    if (current !== schema)
      writeFileAtomic(target, schema)
  }

  private parseGroup<T>(schema: (input: unknown) => unknown, value: Record<string, unknown>, label: string): T {
    const parsed = parseTolerant(value, schema, label, [])
    if (parsed.error !== null)
      throw new ConfigError(`${label}: ${parsed.error}`)
    return parsed.value as T
  }

  private commit(draft: Record<string, unknown>): void {
    const stamped = stampConfig(draft)
    const text = `${JSON.stringify(stamped, null, 2)}\n`
    writeFileAtomic(this.file, text)
    this.lastText = text
    this.raw = stamped
    this.apply(stamped)
    this.notify()
  }

  private resolveFallback(): ResolvedGlobalConfig {
    const control = controlSchema({})
    const host = hostSchema({})
    const backups = backupsSchema({})
    const proxy = proxyConfigSchema({})
    if (control instanceof type.errors || host instanceof type.errors || backups instanceof type.errors || proxy instanceof type.errors)
      throw new ConfigError('internal: default settings failed validation')
    return { control, host, backups, proxy }
  }

  private apply(raw: unknown): void {
    const parsed = parseGlobalSettings(raw)
    this.raw = structuredClone(raw as Record<string, unknown>)
    this.error = parsed.errors.length > 0 ? parsed.errors.join('; ') : null
    this.schemaVersion = parsed.schemaVersion
    this.warnings = [
      ...parsed.warnings,
      ...(parsed.unknownKeys.length === 0
        ? []
        : [`${path.basename(this.file)} carries ${parsed.unknownKeys.length} unrecognized key(s) this release ignores: ${parsed.unknownKeys.join(', ')}`]),
    ]
    if (parsed.config !== null)
      this.resolvedConfig = parsed.config
    else if (this.resolvedConfig === undefined)
      this.resolvedConfig = this.resolveFallback()
  }
}
