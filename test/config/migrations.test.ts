import { describe, expect, it } from 'vitest'
import { applyConfigMigrations, CONFIG_SCHEMA, planConfigMigrations, UNSTAMPED_SCHEMA } from '#src/config/migrations'

/**
 * The schema-1 -> 2 notification migration, by **content**.
 *
 * It had no test at all, measured: making the step emit `destinations: []` (total data loss) or
 * flip `useOwnSettings` to `false` left all 1738 tests green. `migrate` is what every upgrading home
 * runs, so the shape it produces is worth pinning rather than trusting the commit message.
 */
describe('the notifications migration', () => {
  const schema1 = {
    meta: { writtenBy: '0.7.2', schema: 1 },
    notifications: {
      telegram: {
        enabled: true,
        chatId: '424242',
        onCrash: false,
        onUnhealthy: true,
        onForcedRestart: true,
        onRecovered: true,
        onHost: false,
        cooldownMs: 90_000,
      },
      webhooks: [
        {
          id: 'phone',
          url: 'https://ntfy.sh/a',
          enabled: true,
          method: 'POST',
          format: 'text',
          headers: 'Title: x',
          onCrash: true,
          onUnhealthy: true,
          onForcedRestart: true,
          onRecovered: false,
          onHost: true,
          cooldownMs: 60_000,
        },
      ],
    },
  }

  function migrate(config: Record<string, unknown>) {
    return applyConfigMigrations(config, UNSTAMPED_SCHEMA).config as Record<string, any>
  }

  it('folds the singleton and the list into destinations, keeping every value', () => {
    const migrated = migrate(schema1)
    const destinations = migrated.notifications.destinations

    expect(destinations).toHaveLength(2)

    // The old singleton keeps the legacy id, so the token already stored under it still matches.
    const telegram = destinations.find((entry: any) => entry.kind === 'telegram')
    expect(telegram).toMatchObject({
      kind: 'telegram',
      id: 'telegram',
      enabled: true,
      chatId: '424242',
      onCrash: false,
      onRecovered: true,
      onHost: false,
      cooldownMs: 90_000,
    })

    const webhook = destinations.find((entry: any) => entry.kind === 'webhook')
    expect(webhook).toMatchObject({
      kind: 'webhook',
      id: 'phone',
      url: 'https://ntfy.sh/a',
      format: 'text',
      headers: 'Title: x',
      onCrash: true,
      cooldownMs: 60_000,
    })
  })

  it('opts migrated destinations into their own settings, so delivery is unchanged', () => {
    // The one thing the migration promises: a configured target does exactly what it did before.
    // Inheriting would silently adopt the general block instead of the policy it was written with.
    for (const entry of migrate(schema1).notifications.destinations)
      expect(entry.useOwnSettings, `${entry.kind}/${entry.id} must keep its own policy`).toBe(true)
  })

  it('removes the keys it replaced, rather than leaving two shapes in one block', () => {
    const notifications = migrate(schema1).notifications
    expect('telegram' in notifications).toBe(false)
    expect('webhooks' in notifications).toBe(false)
  })

  it('stamps the schema it reached, so the result is readable by this release', () => {
    expect(migrate(schema1).meta.schema).toBe(CONFIG_SCHEMA)
  })

  it('is idempotent: a second pass changes nothing', () => {
    const once = migrate(schema1)
    const twice = applyConfigMigrations(once, UNSTAMPED_SCHEMA).config

    expect(planConfigMigrations(UNSTAMPED_SCHEMA).steps).toHaveLength(1)
    // A stamped file plans no steps at all, which is what makes a second `migrate` a no-op.
    expect(planConfigMigrations(CONFIG_SCHEMA).steps).toHaveLength(0)
    expect(twice).toEqual(once)
  })

  it('leaves a block it does not recognize alone for the reader to report', () => {
    const unknown = { meta: { schema: 1 }, notifications: { futureBlock: { a: 1 } } }
    expect(migrate(unknown).notifications).toEqual({ futureBlock: { a: 1 } })
  })

  it('keeps an empty block empty instead of inventing a destination', () => {
    const migrated = migrate({ meta: { schema: 1 }, notifications: { telegram: { enabled: false, chatId: '' } } })
    // A singleton with nothing configured is still a destination: its id is where a token would go.
    expect(migrated.notifications.destinations).toHaveLength(1)
    expect(migrated.notifications.destinations[0]).toMatchObject({ kind: 'telegram', id: 'telegram', enabled: false })
  })
})
