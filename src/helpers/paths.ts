import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Where home-hosted keeps everything it owns. `HHOSTED_HOME` overrides it —
 * which is how a project repo keeps its own state directory while the package
 * itself ships no configuration at all.
 *
 * Everything below `dataRoot/.hh`: the global panel state at its top level, and
 * one directory per workspace. A workspace owns its settings, servers, secrets,
 * logs and nanny state; only what is genuinely panel-wide (listener, auth,
 * host vitals, backups, TLS, UI, run.json) stays global.
 */
export function resolveDataRoot(): string {
  const override = process.env.HHOSTED_HOME
  if (override !== undefined && override.length > 0)
    return path.resolve(override)
  return path.join(os.homedir(), '.home-hosted')
}

export const dataRoot = resolveDataRoot()

/**
 * The directory home-hosted was started from. Relative entry paths (`cwd`,
 * declared data directories) resolve against it, so the project's own launcher
 * decides the base instead of wherever the package happens to be installed.
 * `HHOSTED_PROJECT` pins it explicitly.
 */
export function resolveProjectDir(): string {
  const override = process.env.HHOSTED_PROJECT
  if (override !== undefined && override.length > 0)
    return path.resolve(override)
  return process.cwd()
}

export const projectDir = resolveProjectDir()

/** The internal state root: global files here, one directory per workspace. */
export const hhDir = path.join(dataRoot, '.hh')

export const DEFAULT_WORKSPACE_ID = 'default'

// ---------------------------------------------------------------- global state

/** Panel-wide settings: listener, auth, TLS policy, host vitals, backups. */
export const globalSettingsPath = path.join(hhDir, 'settings.json')
/** Regenerated for editor autocomplete; kept beside the file it describes. */
export const globalSettingsSchemaPath = path.join(hhDir, 'settings.schema.json')
/** Password hash + API token hash; written with mode 0600. */
export const globalSecretsPath = path.join(hhDir, '.control-secrets.json')
/** The workspace registry: ids and labels. */
export const workspacesPath = path.join(hhDir, 'workspaces.json')
export const workspacesSchemaPath = path.join(hhDir, 'workspaces.schema.json')
/** Uploaded TLS PEM pair (the key is written 0600). */
export const tlsDir = path.join(hhDir, '.tls')
/** Default archive directory; `backups.dir` resolves against `hhDir`. */
export const defaultBackupsDirName = '.backups'
/** The panel's own console log. */
export const daemonLogPath = path.join(hhDir, '.logs', 'home-hosted.log')
/** `run.json` records the live control plane. */
export const runtimePath = path.join(hhDir, 'run.json')
/** The installed UI; `UiService` owns everything under it. */
export const uiDir = path.join(hhDir, '.ui')

// ----------------------------------------------------------------- reverse proxy

/** Everything the reverse proxy owns: engine binary, its data, its state and logs. */
export const proxyDir = path.join(hhDir, '.proxy')
/** The engine binary the panel installed, plus the record of what it installed. */
export const proxyBinDir = path.join(proxyDir, 'bin')
/** The engine's own data and configuration directories, pinned away from `$HOME`. */
export const proxyEngineDir = path.join(proxyDir, 'engine')
/** The generated engine configuration, rewritten on every change. */
export const proxyConfigPath = path.join(proxyEngineDir, 'current.json')
/** The last configuration that applied, kept so a rejected change can be reverted. */
export const proxyPreviousConfigPath = path.join(proxyEngineDir, 'previous.json')
/** The nanny's spec and state for the engine process, so it outlives the panel. */
export const proxyStateDir = path.join(proxyDir, 'state')
/** How the panel reaches a running engine's admin endpoint. */
export const proxyAdminPath = path.join(proxyStateDir, 'admin.json')
/** The PEM pair a route with `tls: "manual"` serves. */
export const proxyTlsDir = path.join(proxyDir, 'tls')
/** The credentials the engine presents to the panel's DNS-01 endpoint, 0600. */
export const proxyChallengeAuthPath = path.join(proxyStateDir, 'challenge.json')

// ------------------------------------------------------------- workspace state

export function workspaceDir(id: string): string {
  return path.join(hhDir, id)
}

/** Workspace-scoped settings: server defaults, logs, notifications, DDNS. */
export function workspaceSettingsPath(id: string): string {
  return path.join(workspaceDir(id), 'settings.json')
}

export function workspaceSettingsSchemaPath(id: string): string {
  return path.join(workspaceDir(id), 'settings.schema.json')
}

/** The servers a workspace supervises. */
export function workspaceServersPath(id: string): string {
  return path.join(workspaceDir(id), 'servers.config.json')
}

export function workspaceServersSchemaPath(id: string): string {
  return path.join(workspaceDir(id), 'servers.config.schema.json')
}

/** Workspace secrets: Telegram bot token and DDNS credentials. Mode 0600. */
export function workspaceSecretsPath(id: string): string {
  return path.join(workspaceDir(id), '.secrets.json')
}

/** Rotated per-server JSONL logs. */
export function workspaceLogsDir(id: string): string {
  return path.join(workspaceDir(id), '.logs')
}

/** Persisted restart/crash history for one workspace. */
export function workspaceHistoryPath(id: string): string {
  return path.join(workspaceLogsDir(id), 'history.json')
}

/** Per-entry nanny state and spawn specs — how a persistent server survives a restart. */
export function workspaceStateDir(id: string): string {
  return path.join(workspaceDir(id), '.state')
}

/** The last public address each DDNS target was confirmed to serve. */
export function workspaceDdnsStatePath(id: string): string {
  return path.join(workspaceStateDir(id), 'ddns.json')
}

/** Every directory a nanny state file may sit in, across all workspaces. */
export function workspaceIdsOnDisk(): string[] {
  try {
    return fs.readdirSync(hhDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .filter(id => /^[a-z0-9][a-z0-9_-]*$/.test(id))
  }
  catch {
    return []
  }
}

// -------------------------------------------------------------------- legacy

/**
 * Where state lived before workspaces: directly under `HHOSTED_HOME`. Kept only
 * so the one-time layout migration can find it; nothing reads these at runtime.
 */
export const legacy = {
  configPath: path.join(dataRoot, 'servers.config.json'),
  configSchemaPath: path.join(dataRoot, 'servers.config.schema.json'),
  secretsPath: path.join(dataRoot, '.control-secrets.json'),
  tlsDir: path.join(dataRoot, '.tls'),
  logsDir: path.join(dataRoot, '.logs'),
  historyPath: path.join(dataRoot, '.logs', 'history.json'),
  stateDir: path.join(dataRoot, '.state'),
  backupsDir: path.join(dataRoot, '.backups'),
  uiDir: path.join(dataRoot, '.ui'),
  runtimePath: path.join(dataRoot, 'run.json'),
} as const

/** True when a pre-workspace instance left state at the old paths. */
export function hasLegacyLayout(): boolean {
  if (fs.existsSync(workspacesPath))
    return false
  return fs.existsSync(legacy.configPath) || fs.existsSync(legacy.secretsPath)
}

/** Expands `~` and resolves relative paths against `base`, for config-declared paths. */
export function resolveUserPath(target: string, base = projectDir): string {
  let value = target
  if (value === '~')
    value = os.homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\'))
    value = path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(base, value)
}
