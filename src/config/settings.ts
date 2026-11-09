import type { ResolvedGlobalConfig } from '#src/config/schema'
import type { BackupsConfig, ControlConfig, HostConfig, ProxyConfig, ProxyPatch, SettingsPatch } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { type } from 'arktype'
import { planConfigMigrations, UNSTAMPED_SCHEMA } from '#src/config/migrations'
import { parseGlobalSettings, parseTolerant, stampConfig } from '#src/config/parse'
import { applyPatch, BACKUP_MERGE_KEYS, CONTROL_MERGE_KEYS, EMPTY_MERGE_KEYS, PROXY_MERGE_KEYS } from '#src/config/patch'
import { backupsSchema, controlSchema, globalSettingsSchema, hostSchema, proxyConfigSchema } from '#src/config/schema'
import { SEED_GLOBAL_SETTINGS } from '#src/config/seed'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { globalSettingsPath } from '#src/helpers/paths'

export type ConfigErrorCode = 'UNKNOWN_SERVER' | 'CONFIG_CHANGED_ON_DISK'

export class ConfigError extends Error {
  override name = 'ConfigError'
  /**
   * The *kind* of config problem, when a caller has to branch on it rather than just report it.
   * `UNKNOWN_SERVER` lets the servers route answer 404 for a missing id and 400 for an invalid
   * patch; `CONFIG_CHANGED_ON_DISK` is a save refused because the file moved under it (409).
   */
  readonly code: ConfigErrorCode | undefined

  constructor(message: string, code?: ConfigErrorCode) {
    super(message)
    this.code = code
  }
}

/**
 * A save that would overwrite an edit the panel has not read yet. The caller is told to retry; the
 * store's conflict listeners are what make the reload happen first.
 */
export function changedOnDisk(file: string): ConfigError {
  return new ConfigError(`${path.basename(file)} changed on disk since the panel last read it — the panel will reload it; retry the save`, 'CONFIG_CHANGED_ON_DISK')
}

/** The bytes on disk differ from the ones a store last read or wrote; a missing file is not an edit to keep. */
export function fileMovedSince(file: string, lastText: string | null): boolean {
  let text: string
  try {
    text = readStateFile(file)
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  return text !== lastText
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
  /** A schema problem in the file last applied. */
  private error: string | null = null
  /** A JSON parse failure, kept apart from a schema problem so `apply()` cannot clear it. */
  private parseError: string | null = null
  /** The file is gone or unreadable; cleared by the next read that finds it. */
  private diskError: string | null = null
  /** A hand edit the reload guard refused; the running settings are kept. */
  private refusedError: string | null = null
  private warnings: string[] = []
  private schemaVersion = UNSTAMPED_SCHEMA
  private readonly listeners = new Set<() => void>()
  private readonly conflictListeners = new Set<() => void>()

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
    return this.diskError ?? this.parseError ?? this.refusedError ?? this.error
  }

  /** Keys a newer release wrote that this one ignores; nothing to refuse over. */
  get configWarnings(): string[] {
    return [...this.warnings]
  }

  get configSchemaVersion(): number {
    return this.schemaVersion
  }

  /**
   * Steps that would have to run before this release could use the file.
   *
   * A file that cannot be **parsed** has no schema to plan from, and `migrate` refuses one it
   * cannot read rather than lifting it — so claiming a migration here sends the person to the one
   * command guaranteed not to help. Measured: a truncated `.hh/settings.json` made `up` say
   * "needs 1 migration(s)" and `migrate` answer "cannot read … Unexpected end of JSON input". The
   * workspace pair already excluded the parse failure (`WorkspaceStore.pendingMigrations`); this is
   * the same rule on the global file, which is the one the startup guard reads first.
   */
  get pendingMigrations() {
    if (this.parseError !== null)
      return []
    return planConfigMigrations(this.schemaVersion).steps
  }

  get rawConfig(): Record<string, unknown> {
    return structuredClone(this.raw)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Told when a save was refused because the file changed on disk, so its owner can reload it. */
  onConflict(listener: () => void): () => void {
    this.conflictListeners.add(listener)
    return () => this.conflictListeners.delete(listener)
  }

  /**
   * Reads the file, seeding it when missing. `{ write: false }` is the read-only form: a missing
   * file reads as the seed without creating one, so a command that only looks (`backup list`)
   * leaves a fresh home as it found it.
   */
  load(options: { write?: boolean } = {}): void {
    this.read(options.write !== false)
    this.notify()
  }

  /**
   * The watcher's entry point: re-reads the file only when its bytes changed, so the panel's own
   * writes never count as an edit.
   *
   * A revision that cannot be parsed, or that `guard` refuses (an edit that would expose the
   * panel, say), is reported through `configError` while the running settings — and the raw
   * object every write patches — stay on the last trusted read.
   */
  reloadFromDisk(guard?: (candidate: ResolvedGlobalConfig) => string | null): { changed: boolean, applied: boolean, error: string | null } {
    let text: string
    try {
      text = readStateFile(this.file)
    }
    catch (error) {
      this.diskError = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${path.basename(this.file)} is gone`
        : `cannot read ${path.basename(this.file)}: ${(error as Error).message}`
      return { changed: false, applied: false, error: this.configError }
    }
    this.diskError = null

    if (text === this.lastText)
      return { changed: false, applied: false, error: this.configError }
    this.lastText = text

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    }
    catch (error) {
      this.parseError = `cannot parse ${path.basename(this.file)}: ${(error as Error).message}`
      return { changed: true, applied: false, error: this.configError }
    }
    this.parseError = null
    this.refusedError = null

    const candidate = parseGlobalSettings(parsed).config
    const refusal = candidate === null || guard === undefined ? null : guard(candidate)
    if (refusal !== null) {
      this.refusedError = `${path.basename(this.file)} was not applied: ${refusal}`
      return { changed: true, applied: false, error: this.configError }
    }

    const before = this.resolvedConfig
    this.apply(parsed)
    this.notify()
    return { changed: true, applied: this.resolvedConfig !== before, error: this.configError }
  }

  private read(write = true): void {
    // Cleared up front so both branches answer the same question: a file that reads cleanly now is
    // not still "unparseable" from the read before it.
    this.parseError = null
    this.diskError = null
    this.refusedError = null
    if (!fs.existsSync(this.file)) {
      const seed = stampConfig(structuredClone(this.seed))
      const text = `${JSON.stringify(seed, null, 2)}\n`
      if (write)
        writeFileAtomic(this.file, text)
      this.lastText = write ? text : null
      this.raw = seed
      this.apply(seed)
      return
    }

    let text: string
    let parsed: unknown
    try {
      text = readStateFile(this.file)
      parsed = JSON.parse(text)
    }
    catch (error) {
      this.parseError = `cannot parse ${path.basename(this.file)}: ${(error as Error).message}`
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
    applyPatch(draft.backups as Record<string, unknown>, patch as Record<string, unknown>, BACKUP_MERGE_KEYS)

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
    // A save patches the last trusted read; a hand edit the watcher has not picked up yet would be
    // overwritten without a word.
    if (fileMovedSince(this.file, this.lastText)) {
      for (const listener of this.conflictListeners) listener()
      throw changedOnDisk(this.file)
    }
    const stamped = stampConfig(draft)
    const text = `${JSON.stringify(stamped, null, 2)}\n`
    writeFileAtomic(this.file, text)
    this.lastText = text
    // The file is now the panel's own write, so no earlier verdict on it still holds.
    this.parseError = null
    this.diskError = null
    this.refusedError = null
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
