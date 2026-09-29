import type { ServerConfig } from '#src/shared/contracts'
import { type } from 'arktype'
import {
  backupsSchema,
  controlSchema,
  ddnsConfigSchema,
  defaultsSchema,
  hostSchema,
  logsSchema,
  notificationsSchema,
  serverSchema,
} from '#src/shared/contracts'

export { backupsSchema, controlSchema, ddnsConfigSchema, defaultsSchema, hostSchema, logsSchema, notificationsSchema, serverSchema }

/**
 * Which release wrote the file, and the config shape it wrote. Optional so a
 * config from before the stamp still reads, and so an archive made by an older
 * release still restores.
 */
export const metaSchema = type({
  writtenBy: 'string = ""',
  schema: 'number.integer >= 1 = 1',
}).onUndeclaredKey('reject')

/**
 * `$HHOSTED_HOME/.hh/settings.json`: the settings that belong to the panel
 * itself — its listener, authentication, TLS policy, host vitals and backups.
 * Nothing here is per workspace.
 */
export const globalSettingsSchema = type({
  $schema: 'string?',
  meta: metaSchema.optional(),
  control: controlSchema.default(() => ({})),
  host: hostSchema.default(() => ({})),
  backups: backupsSchema.default(() => ({})),
}).onUndeclaredKey('reject')

/** `$HHOSTED_HOME/.hh/<id>/settings.json`: what one workspace owns on its own. */
export const workspaceSettingsSchema = type({
  $schema: 'string?',
  meta: metaSchema.optional(),
  defaults: defaultsSchema.default(() => ({})),
  logs: logsSchema.default(() => ({})),
  notifications: notificationsSchema.default(() => ({})),
  ddns: ddnsConfigSchema.default(() => ({})),
}).onUndeclaredKey('reject')

/** `$HHOSTED_HOME/.hh/<id>/servers.config.json`: the entries this workspace supervises. */
export const serversFileSchema = type({
  $schema: 'string?',
  meta: metaSchema.optional(),
  servers: serverSchema.array().default(() => []),
}).onUndeclaredKey('reject')

export type ResolvedGlobalConfig = typeof globalSettingsSchema.infer
export type ResolvedWorkspaceSettings = typeof workspaceSettingsSchema.infer
export type ResolvedServersFile = typeof serversFileSchema.infer

/** Same shape as the settings output, with each server `port` normalized to `null` when unset. */
export type ResolvedWorkspaceConfig = ResolvedWorkspaceSettings & { servers: ServerConfig[] }

/** Every key `globalSettingsSchema` knows, for reporting blocks a newer release added. */
export const GLOBAL_SETTINGS_KEYS = ['$schema', 'meta', 'control', 'host', 'backups'] as const
export const WORKSPACE_SETTINGS_KEYS = ['$schema', 'meta', 'defaults', 'logs', 'notifications', 'ddns'] as const
export const SERVERS_FILE_KEYS = ['$schema', 'meta', 'servers'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolves one entry against the workspace's server defaults. A group (`restart`,
 * `health`, `health.http`, `stop`) merges key by key, so an entry that decides one
 * member does not silently fall back to the *schema* default for the others — which
 * is the whole point of the workspace having defaults at all.
 */
export function mergeDefaults(
  defaults: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...entry }
  for (const [key, value] of Object.entries(defaults)) {
    const current = merged[key]
    if (current === undefined)
      merged[key] = value
    else if (isRecord(value) && isRecord(current))
      merged[key] = mergeDefaults(value, current)
  }
  return merged
}
