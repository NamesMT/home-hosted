import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA, planConfigMigrations, UNSTAMPED_SCHEMA } from '#src/config/migrations'
import { parseServersFile } from '#src/config/parse'

/**
 * An unstamped file is the **oldest** schema, never the current one.
 *
 * `migrations.ts` documents "unstamped files are schema 1" as a literal, but three readers defaulted to
 * `CONFIG_SCHEMA` instead. Today both are 1, so they agreed — and the moment `CONFIG_SCHEMA` is bumped the
 * default would silently skip every migration: an unstamped file would be read as the new schema,
 * `planConfigMigrations` would find nothing to do, and it would be **stamped as the new shape without ever
 * being lifted to it**. Measured with a hypothetical step: `from=1` plans 1 step, `from=2` plans none.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('an unstamped config file', () => {
  it('reports the pre-stamp schema, and that schema is a literal', () => {
    expect(UNSTAMPED_SCHEMA).toBe(1)
    expect(parseServersFile({ servers: [] }, {}).schemaVersion).toBe(UNSTAMPED_SCHEMA)
  })

  it('would still be migrated after a schema bump', () => {
    // The property that matters: reading a file as the OLDEST schema leaves work to do.
    const lift = { to: CONFIG_SCHEMA + 1, describe: 'a future step', apply: (config: Record<string, unknown>) => config }
    const plan = planConfigMigrations(UNSTAMPED_SCHEMA, { to: CONFIG_SCHEMA + 1, migrations: [lift] })
    expect(plan.steps, 'an unstamped file must not look already-current').toHaveLength(1)
    expect(plan.tooNew).toBe(false)
  })

  it('keeps the readers using the constant rather than the current schema', () => {
    // A source-level check, because the failure needs a future bump to become visible: a reader that
    // defaults to `CONFIG_SCHEMA` is correct today and wrong the day that number changes.
    // Every reader of a `meta.schema`, not the two that happened to be found first: the CLI's migrate
    // and the global settings store had the same fallback.
    for (const file of ['src/config/parse.ts', 'src/config/store.ts', 'src/config/settings.ts', 'src/cli/migrate.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8')
      expect(source, `${file} must import UNSTAMPED_SCHEMA`).toContain('UNSTAMPED_SCHEMA')
      // Any fallback for a *missing* stamp must be the constant, not the current schema. Three
      // spellings exist: the two `meta.schema ?: …` fallbacks and the two result defaults.
      expect(source, `${file} must not fall back to CONFIG_SCHEMA for a missing stamp`)
        .not
        .toMatch(/meta\.schema : CONFIG_SCHEMA/)
      expect(source, `${file} must not default a result's schemaVersion to CONFIG_SCHEMA`)
        .not
        .toMatch(/schemaVersion: CONFIG_SCHEMA/)
      // Case-insensitive: the field is `schemaVersion`, so an uppercase `S` in the pattern silently
      // matched nothing — which is how the first version of this guard passed a mutation.
      expect(source, `${file} must not initialise a version field to CONFIG_SCHEMA`)
        .not
        .toMatch(/schemaVersion = CONFIG_SCHEMA/i)
    }
  })
})

/**
 * A gap in the migration chain must be visible, not silently stamped over.
 *
 * `migrate` writes `schema: CONFIG_SCHEMA` unconditionally after applying a plan. With one step published
 * and `CONFIG_SCHEMA` two versions ahead, the file is lifted part-way and then claims the newest shape —
 * the same silent corruption the unstamped default caused, arrived at from the other side.
 */
describe('a migration chain with a gap', () => {
  it('reports where it actually reached, so the stamp cannot lie', () => {
    const only12 = [{ to: 2, describe: 'lifts 1 to 2', apply: (config: Record<string, unknown>) => config }]

    const broken = planConfigMigrations(1, { to: 3, migrations: only12 })
    expect(broken.to).toBe(3)
    expect(broken.reached, 'the chain stops at 2, not 3').toBe(2)

    // An unbroken chain reports the target, which is what `migrate` checks before writing.
    const whole = planConfigMigrations(1, {
      to: 3,
      migrations: [...only12, { to: 3, describe: 'lifts 2 to 3', apply: (config: Record<string, unknown>) => config }],
    })
    expect(whole.reached).toBe(3)
  })

  it('and migrate refuses rather than stamping a shape it did not reach', () => {
    const source = fs.readFileSync(path.join(root, 'src/cli/migrate.ts'), 'utf8')
    expect(source, 'migrate must compare reached against to').toContain('plan.reached !== plan.to')
  })
})
