import type { RawConfig } from '#src/config/schema'

/**
 * The config shape this release understands. Bump it only for a change that an
 * older release cannot simply ignore, and add the step that lifts the previous
 * shape to it in `configMigrations` — then a config that needs it refuses to
 * start until `home-hosted migrate` has run.
 *
 * 1 — the shape that has been in use up to and including 0.3.0, plus the `meta`
 *     block this constant was introduced with. Unstamped files are schema 1.
 */
export const CONFIG_SCHEMA = 1

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
