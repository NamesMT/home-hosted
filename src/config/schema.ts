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

/** The shape of `servers.config.json`: control panel settings, defaults, servers. */
export const configSchema = type({
  $schema: 'string?',
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

/** The on-disk shape: everything optional except `servers`, defaults applied per entry. */
export interface RawConfig {
  $schema?: string
  control?: Record<string, unknown>
  defaults?: Record<string, unknown>
  logs?: Record<string, unknown>
  notifications?: Record<string, unknown>
  host?: Record<string, unknown>
  backups?: Record<string, unknown>
  servers?: Record<string, unknown>[]
}
