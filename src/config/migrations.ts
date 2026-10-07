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
 */
export const CONFIG_SCHEMA = 1

/**
 * The schema of a file that carries no `meta` stamp at all.
 *
 * A literal, **not** `CONFIG_SCHEMA`: an unstamped file predates the stamp, so it is the *oldest* shape,
 * and reading it as the current one would skip every migration the moment `CONFIG_SCHEMA` is bumped —
 * the file would then be stamped as the new schema without ever being lifted to it. Measured with a
 * hypothetical `to: 2` step: `from=1` plans 1 step, `from=2` plans none.
 *
 * Schema 1 is the shape in use up to and including 0.6.x, which is what an unstamped file is.
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
 * Every published migration, oldest first. Keep this list small and permanent:
 * a config may arrive from any earlier release, so a step is never removed.
 */
export const configMigrations: ConfigMigration[] = []

export interface MigrationPlan {
  from: number
  to: number
  steps: ConfigMigration[]
  /** The file was written by a release newer than this one. */
  tooNew: boolean
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
  return { from, to, steps, tooNew: from > to }
}

/** Applies the plan in order; the caller owns writing the result. */
export function applyConfigMigrations(config: RawConfig, from: number, options: MigrationOptions = {}): { config: RawConfig, applied: ConfigMigration[] } {
  const { steps } = planConfigMigrations(from, options)
  let current = config
  for (const step of steps)
    current = step.apply(current)
  return { config: current, applied: steps }
}
