import type { ServerConfig } from '#src/shared/contracts'
import { type } from 'arktype'
import {
  backupsSchema,
  controlSchema,
  defaultsSchema,
  hostSchema,
  logsSchema,
  notificationsSchema,
  serverSchema,
} from '#src/shared/contracts'

export { backupsSchema, controlSchema, defaultsSchema, hostSchema, logsSchema, notificationsSchema, serverSchema }
export type { ServerConfig } from '#src/shared/contracts'

/**
 * Which release wrote the file, and the config shape it wrote. Optional so a
 * config from before the stamp still reads, and so an archive made by an older
 * release still restores.
 */
export const metaSchema = type({
  writtenBy: 'string = ""',
  schema: 'number.integer >= 1 = 1',
}).onUndeclaredKey('reject')

/** The shape of `servers.config.json`: control panel settings, defaults, servers. */
export const configSchema = type({
  $schema: 'string?',
  meta: metaSchema.optional(),
  control: controlSchema.default(() => ({})),
  defaults: defaultsSchema.default(() => ({})),
  logs: logsSchema.default(() => ({})),
  notifications: notificationsSchema.default(() => ({})),
  host: hostSchema.default(() => ({})),
  backups: backupsSchema.default(() => ({})),
  servers: serverSchema.array().default(() => []),
}).onUndeclaredKey('reject')

/** Same shape as the schema output, with each server `port` normalized to `null` when unset. */
export type ResolvedConfig = Omit<typeof configSchema.infer, 'servers'> & { servers: ServerConfig[] }

/** Every key `configSchema` knows, for reporting blocks a newer release added. */
export const CONFIG_KEYS = ['$schema', 'meta', 'control', 'defaults', 'logs', 'notifications', 'host', 'backups', 'servers'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolves one entry against the panel's server defaults. A group (`restart`,
 * `health`, `health.http`, `stop`) merges key by key, so an entry that decides one
 * member does not silently fall back to the *schema* default for the others — which
 * is the whole point of the panel having defaults at all.
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

/** The on-disk shape: everything optional except `servers`, defaults applied per entry. */
export interface RawConfig {
  $schema?: string
  meta?: { writtenBy?: string, schema?: number }
  control?: Record<string, unknown>
  defaults?: Record<string, unknown>
  logs?: Record<string, unknown>
  notifications?: Record<string, unknown>
  host?: Record<string, unknown>
  backups?: Record<string, unknown>
  servers?: Record<string, unknown>[]
}
