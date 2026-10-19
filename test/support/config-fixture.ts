import { CONFIG_SCHEMA } from '#src/config/migrations'

/**
 * A config fixture file, stamped as the schema this release understands.
 *
 * **Every raw write of a `settings.json` or `servers.config.json` in the suite has to go through
 * this.** An unstamped file reads as `UNSTAMPED_SCHEMA` — the oldest shape — which since
 * `CONFIG_SCHEMA` reached 2 means "needs a migration", and the reader refuses it. That is correct
 * behaviour for a real home, and 40-odd tests failed on it at once when the step landed, because
 * each wrote bare JSON. Passing the fixtures through one helper is what stops the next schema bump
 * from doing that again.
 */
export function configJson(config: unknown): string {
  return JSON.stringify({ ...(config as Record<string, unknown>), meta: { writtenBy: 'test', schema: CONFIG_SCHEMA } }, null, 2)
}

/** The parsed form, for a fixture that wants to tweak what it wrote. */
export function configObject(config: unknown): Record<string, unknown> {
  return JSON.parse(configJson(config)) as Record<string, unknown>
}
