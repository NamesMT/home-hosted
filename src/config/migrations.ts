/**
 * The config shape this release understands. It is shared by every file that
 * carries a `meta` stamp (the global settings, each workspace's settings and its
 * servers config), because a migration has to be able to lift any of them.
 *
 * Bump it only for a change that an older release cannot simply ignore, and add
 * the step that lifts the previous shape to it in `configMigrations` — then a
 * config that needs it refuses to start until `home-hosted migrate` has run.
 *
 * 1 — the shape that has been in use up to and including 0.6.x, plus the `meta`
 *     block this constant was introduced with. Unstamped files are schema 1.
 * 2 — notifications: one Telegram singleton plus a webhook list became one `destinations`
 *     list of typed entries, and the shared policy moved to `notifications.defaults`.
 */
import { LEGACY_TELEGRAM_ID } from '#src/config/secrets'

export const CONFIG_SCHEMA = 2

/**
 * The schema of a file that carries no `meta` stamp at all.
 *
 * A literal, **not** `CONFIG_SCHEMA`: an unstamped file predates the stamp, so it is the *oldest* shape,
 * and reading it as the current one would skip every migration the moment `CONFIG_SCHEMA` is bumped —
 * the file would then be stamped as the new schema without ever being lifted to it.
 *
 * **Schema 1 is the oldest stamped shape**, but an unstamped file is not necessarily that one: the
 * seeds this release writes carry no `meta` at all, and they are written in the *current* shape. So
 * an unstamped file cannot be told apart from a pre-stamp one, and both are read as the shape that
 * predates the stamp — schema 1. That is what makes the distinction safe in the direction that
 * matters: a released file is lifted, and a seed is written in a shape schema 1 can describe,
 * because every field added since is optional with a default.
 *
 * (This was `1` with the note "a hypothetical `to: 2` step" — and then 2 arrived, which is how the
 * seeds started refusing to load. They now carry a stamp of their own; see `config/seed.ts`.)
 */
export const UNSTAMPED_SCHEMA = 1

/** A settings or servers file, as read: whatever keys it carries. */
export type RawConfig = Record<string, unknown>

export interface ConfigMigration {
  /** The schema this step produces; steps run in ascending order. */
  to: number
  /** One line, printed by `migrate` before anything is written. */
  describe: string
  apply: (config: RawConfig) => RawConfig
}

/**
 * The id the pre-list Telegram destination takes.
 *
 * **The one definition**, imported from the secrets reader, because that is where the bot token for
 * it already sits: the two have to agree on the id or the upgrade loses a working Telegram. They
 * were two literals with a comment claiming they were shared, and drifting one was undetected.
 */

/**
 * Schema 1 → 2: `notifications.{telegram, webhooks}` → `notifications.{defaults, destinations}`.
 *
 * The old singleton becomes one `telegram` destination, and each webhook keeps its id, so a
 * destination's cooldown, last-result record and Telegram token all still point at the same thing.
 * `useOwnSettings` is set **true** on every migrated destination: before this schema each one
 * carried its own toggles, and reading one as "inherit" would silently change what it delivers.
 * The old webhook `enabled` default (true) and the Telegram one (false) are preserved as they were.
 */
function notificationsToDestinations(config: RawConfig): RawConfig {
  const notifications = config.notifications
  if (notifications === null || typeof notifications !== 'object' || Array.isArray(notifications))
    return config

  const group = notifications as Record<string, unknown>
  // Already migrated, or a shape this step does not know: leave it to the reader.
  if (group.destinations !== undefined || (group.telegram === undefined && group.webhooks === undefined))
    return config

  const destinations: Array<Record<string, unknown>> = []
  const telegram = group.telegram
  if (telegram !== null && typeof telegram === 'object') {
    const { enabled, chatId, ...policy } = telegram as Record<string, unknown>
    destinations.push({ kind: 'telegram', id: LEGACY_TELEGRAM_ID, enabled: enabled ?? false, chatId: chatId ?? '', useOwnSettings: true, ...policy })
  }
  if (Array.isArray(group.webhooks)) {
    for (const entry of group.webhooks) {
      if (entry === null || typeof entry !== 'object')
        continue
      destinations.push({ kind: 'webhook', useOwnSettings: true, ...(entry as Record<string, unknown>) })
    }
  }

  const next: Record<string, unknown> = { ...group, destinations }
  delete next.telegram
  delete next.webhooks
  return { ...config, notifications: next }
}

/**
 * Every published migration, oldest first. Keep this list small and permanent:
 * a config may arrive from any earlier release, so a step is never removed.
 */
export const configMigrations: ConfigMigration[] = [
  {
    to: 2,
    describe: 'notifications: fold the Telegram singleton and the webhook list into one `destinations` list, with a shared `defaults` block',
    apply: notificationsToDestinations,
  },
]

export interface MigrationPlan {
  from: number
  to: number
  steps: ConfigMigration[]
  /** The file was written by a release newer than this one. */
  tooNew: boolean
  /**
   * The schema the steps actually reach, which is `to` only when the chain is unbroken.
   *
   * A **gap** in `configMigrations` — a step lifting 1→2 published without one lifting 2→3 — leaves the
   * file part-way while `migrate` stamps it as the current schema anyway: it writes
   * `schema: CONFIG_SCHEMA` unconditionally. The file then claims a shape it does not have, which is the
   * same silent corruption the unstamped default caused. This makes the gap detectable.
   */
  reached: number
}

export interface MigrationOptions {
  /** Defaults to every migration this release ships. */
  migrations?: ConfigMigration[]
  /** The schema to reach; defaults to what this release understands. */
  to?: number
}

/** What would have to run to bring `from` up to `to`. */
export function planConfigMigrations(from: number, options: MigrationOptions = {}): MigrationPlan {
  const to = options.to ?? CONFIG_SCHEMA
  const migrations = options.migrations ?? configMigrations
  const steps = migrations
    .filter(migration => migration.to > from && migration.to <= to)
    .sort((a, b) => a.to - b.to)
  return { from, to, steps, tooNew: from > to, reached: steps.at(-1)?.to ?? from }
}

/**
 * Applies the plan in order; the caller owns writing the result.
 *
 * The result carries `meta.schema` set to the schema the steps reached, so it is readable by this
 * release's own parser — which refuses a file whose stamp still says an older schema. Without that,
 * `migrate` validated its own output as "needs 1 migration" and refused every config it exists to
 * lift.
 */
export function applyConfigMigrations(config: RawConfig, from: number, options: MigrationOptions = {}): { config: RawConfig, applied: ConfigMigration[] } {
  const plan = planConfigMigrations(from, options)
  let current = config
  for (const step of plan.steps)
    current = step.apply(current)
  if (plan.steps.length === 0)
    return { config: current, applied: plan.steps }

  const meta = current.meta !== null && typeof current.meta === 'object' && !Array.isArray(current.meta)
    ? current.meta as Record<string, unknown>
    : {}
  return { config: { ...current, meta: { ...meta, schema: plan.reached } }, applied: plan.steps }
}
