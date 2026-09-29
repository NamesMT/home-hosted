import fs from 'node:fs'
import path from 'node:path'
import { logger } from '#src/helpers/logger'
import { hasLegacyLayout, hhDir, legacy, workspacesPath } from '#src/helpers/paths'

/**
 * One-time relocation of a pre-workspace `$HHOSTED_HOME` into the current layout:
 * everything moves under `.hh`, the old all-in-one `servers.config.json` is split
 * into global settings, the `default` workspace's settings, and its servers, and
 * the old secrets file is split global (password, API token) vs. workspace
 * (Telegram token, DDNS credentials).
 *
 * It only ever runs when the old layout is actually present, moves rather than
 * copies, and is idempotent: a second call — or a `workspaces.json` already on
 * disk — does nothing.
 */

export interface LayoutMigrationResult {
  migrated: boolean
  /** What was relocated, for `migrate` and the console. */
  moved: string[]
  warnings: string[]
}

const EMPTY: LayoutMigrationResult = { migrated: false, moved: [], warnings: [] }

const KNOWN_TOP_LEVEL = new Set(['$schema', 'meta', 'control', 'defaults', 'logs', 'notifications', 'host', 'backups', 'ddns', 'servers'])

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

function writeJson(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? {} : { mode })
}

/** `renameSync` across devices fails with EXDEV; fall back to a copy. */
function move(source: string, destination: string, warnings: string[]): boolean {
  if (!fs.existsSync(source))
    return false
  if (fs.existsSync(destination)) {
    warnings.push(`${destination} already exists — left ${source} alone`)
    return false
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  try {
    fs.renameSync(source, destination)
  }
  catch {
    fs.cpSync(source, destination, { recursive: true, force: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
  return true
}

function metaOf(raw: Record<string, unknown> | null): { writtenBy?: string, schema?: number } | undefined {
  const meta = raw?.meta
  if (typeof meta !== 'object' || meta === null)
    return undefined
  return meta as { writtenBy?: string, schema?: number }
}

/** The old config split three ways: global settings, workspace settings, servers. */
function splitConfig(raw: Record<string, unknown>): {
  global: Record<string, unknown>
  settings: Record<string, unknown>
  servers: Record<string, unknown>
} {
  const meta = metaOf(raw)
  const unknown: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key))
      unknown[key] = value
  }

  return {
    global: {
      $schema: './settings.schema.json',
      ...(meta === undefined ? {} : { meta }),
      control: raw.control ?? {},
      host: raw.host ?? {},
      backups: raw.backups ?? {},
      ...unknown,
    },
    settings: {
      $schema: './settings.schema.json',
      ...(meta === undefined ? {} : { meta }),
      defaults: raw.defaults ?? {},
      logs: raw.logs ?? {},
      notifications: raw.notifications ?? {},
      ddns: raw.ddns ?? {},
    },
    servers: {
      $schema: './servers.config.schema.json',
      ...(meta === undefined ? {} : { meta }),
      servers: Array.isArray(raw.servers) ? raw.servers : [],
    },
  }
}

/** The old secrets file split global (password, token) vs. workspace (Telegram, DDNS). */
function splitSecrets(raw: Record<string, unknown> | null): { global: Record<string, unknown>, workspace: Record<string, unknown> } {
  return {
    global: { version: 3, password: raw?.password ?? null, apiToken: raw?.apiToken ?? null },
    workspace: {
      version: 3,
      telegram: raw?.telegram ?? null,
      ddns: raw?.ddns ?? {},
      ddnsKdf: raw?.ddnsKdf ?? null,
    },
  }
}

/**
 * Moves the panel's console log apart from the per-server logs: both used to
 * live in `<root>/.logs`, and only the console log is global now.
 */
function splitLogsDir(warnings: string[]): void {
  if (!fs.existsSync(legacy.logsDir))
    return
  const workspaceLogs = path.join(hhDir, 'default', '.logs')
  for (const name of fs.readdirSync(legacy.logsDir)) {
    const isDaemonLog = name === 'home-hosted.log' || name.startsWith('home-hosted.log.')
    const destination = isDaemonLog
      ? path.join(hhDir, '.logs', name)
      : path.join(workspaceLogs, name)
    move(path.join(legacy.logsDir, name), destination, warnings)
  }
  // Only a directory whose entries all moved is removed: `move()` refuses to
  // overwrite a destination, and deleting the source then would destroy the file
  // the warning just promised to leave alone.
  try {
    if (fs.readdirSync(legacy.logsDir).length === 0)
      fs.rmdirSync(legacy.logsDir)
    else
      warnings.push(`${legacy.logsDir} still holds files that could not be moved — left it in place`)
  }
  catch {
    // Already gone, or unreadable; nothing else to do.
  }
}

export function migrateLayout(): LayoutMigrationResult {
  if (!hasLegacyLayout())
    return EMPTY

  const moved: string[] = []
  const warnings: string[] = []
  fs.mkdirSync(hhDir, { recursive: true })

  const legacyConfig = readJson(legacy.configPath)
  let configSplit = false
  if (legacyConfig !== null) {
    const split = splitConfig(legacyConfig)
    const destinations = [
      path.join(hhDir, 'settings.json'),
      path.join(hhDir, 'default', 'settings.json'),
      path.join(hhDir, 'default', 'servers.config.json'),
    ]
    // A half-migrated or hand-made tree keeps its files: overwriting a newer one
    // with a legacy split is worse than leaving the legacy file where it is.
    const taken = destinations.filter(file => fs.existsSync(file))
    if (taken.length > 0) {
      warnings.push(`${legacy.configPath} could not be split — ${taken.map(file => path.relative(hhDir, file)).join(', ')} already exist(s); left it in place`)
    }
    else {
      writeJson(destinations[0]!, split.global)
      fs.mkdirSync(path.join(hhDir, 'default'), { recursive: true })
      writeJson(destinations[1]!, split.settings)
      writeJson(destinations[2]!, split.servers)
      moved.push('servers.config.json → settings.json + default/settings.json + default/servers.config.json')
      configSplit = true
    }
  }

  const legacySecrets = readJson(legacy.secretsPath)
  let secretsSplit = false
  if (legacySecrets !== null) {
    const split = splitSecrets(legacySecrets)
    const destinations = [path.join(hhDir, '.control-secrets.json'), path.join(hhDir, 'default', '.secrets.json')]
    const taken = destinations.filter(file => fs.existsSync(file))
    if (taken.length > 0) {
      warnings.push(`${legacy.secretsPath} could not be split — ${taken.map(file => path.relative(hhDir, file)).join(', ')} already exist(s); left it in place`)
    }
    else {
      writeJson(destinations[0]!, split.global, 0o600)
      fs.mkdirSync(path.join(hhDir, 'default'), { recursive: true })
      writeJson(destinations[1]!, split.workspace, 0o600)
      moved.push('.control-secrets.json → .hh/.control-secrets.json + .hh/default/.secrets.json')
      secretsSplit = true
    }
  }

  if (move(legacy.tlsDir, path.join(hhDir, '.tls'), warnings))
    moved.push('.tls/ → .hh/.tls/')
  if (move(legacy.uiDir, path.join(hhDir, '.ui'), warnings))
    moved.push('.ui/ → .hh/.ui/')
  if (move(legacy.backupsDir, path.join(hhDir, '.backups'), warnings))
    moved.push('.backups/ → .hh/.backups/')
  if (move(legacy.runtimePath, path.join(hhDir, 'run.json'), warnings))
    moved.push('run.json → .hh/run.json')
  if (move(legacy.stateDir, path.join(hhDir, 'default', '.state'), warnings))
    moved.push('.state/ → .hh/default/.state/')
  splitLogsDir(warnings)

  // The originals go only after both halves are on disk.
  if (configSplit)
    fs.rmSync(legacy.configPath, { force: true })
  if (secretsSplit)
    fs.rmSync(legacy.secretsPath, { force: true })
  fs.rmSync(legacy.configSchemaPath, { force: true })

  if (!fs.existsSync(workspacesPath)) {
    writeJson(workspacesPath, {
      $schema: './workspaces.schema.json',
      workspaces: [{ id: 'default', label: 'Default' }],
    })
    moved.push('workspaces.json created with the `default` workspace')
  }
  else {
    warnings.push(`${workspacesPath} already exists — left the workspace registry alone`)
  }

  writeJson(path.join(hhDir, '.layout-migration.json'), {
    version: 1,
    at: Date.now(),
    moved,
  })

  return { migrated: true, moved, warnings }
}

/**
 * Runs the relocation and reports it through the logger. Every CLI entry point
 * calls this before it resolves a state path, so an existing instance keeps
 * working after the upgrade without anyone having to run a command first.
 */
export function ensureLayout(): LayoutMigrationResult {
  const result = migrateLayout()
  if (result.migrated) {
    logger.info(`state layout migrated into ${hhDir} (${result.moved.length} step(s))`)
    for (const warning of result.warnings) logger.warn(`layout migration: ${warning}`)
  }
  return result
}
