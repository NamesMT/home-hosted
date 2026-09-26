import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Where home-hosted keeps everything it owns: the servers config, the secrets
 * file, logs, TLS material, backups and the runtime file. `HHOSTED_HOME`
 * overrides it — which is how a project repo keeps its own state directory
 * while the package itself ships no configuration at all.
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

export const defaultConfigPath = path.join(dataRoot, 'servers.config.json')
/** Regenerated for editor autocomplete; kept beside the config it describes. */
export const configSchemaPath = path.join(dataRoot, 'servers.config.schema.json')
/** Password hash + bot token; written with mode 0600. */
export const defaultSecretsPath = path.join(dataRoot, '.control-secrets.json')
/** Rotated per-server JSONL logs. */
export const defaultLogsDir = path.join(dataRoot, '.logs')
/** Persisted restart/crash history. */
export const defaultHistoryPath = path.join(dataRoot, '.logs', 'history.json')
/** Uploaded TLS PEM pair (the key is written 0600). */
export const defaultTlsDir = path.join(dataRoot, '.tls')
/** Per-entry nanny state and spawn specs — how a persistent server survives a restart. */
export const defaultNannyDir = path.join(dataRoot, '.state')
/** `run.json` records the live control plane; the log captures its console. */
export const runtimePath = path.join(dataRoot, 'run.json')
export const daemonLogPath = path.join(dataRoot, '.logs', 'home-hosted.log')

/** Expands `~` and resolves relative paths against `base`, for config-declared paths. */
export function resolveUserPath(target: string, base = projectDir): string {
  let value = target
  if (value === '~')
    value = os.homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\'))
    value = path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(base, value)
}
