import { LogLevels } from 'consola'
import { describe, expect, it, vi } from 'vitest'

/**
 * The level this logger runs at, which the module's own comment promises.
 *
 * It said "will log the `debug` level logs in development mode" and nothing checked it: the only
 * assertion was `expect(logger).toHaveProperty('info')`, which consola's own constructor satisfies
 * whatever this module passes it. Deleting the level config left the test green.
 *
 * `createConsola({ level: undefined })` falls back to consola's default, so the dev branch has to be
 * taken rather than assumed — the module is re-imported with `std-env` told which mode it is in.
 */
async function loggerWith(development: boolean) {
  vi.resetModules()
  vi.doMock('std-env', () => ({ isDevelopment: development }))
  const { logger } = await import('#src/helpers/logger.js')
  return logger
}

describe('the shared logger', () => {
  it('logs debug in development, and stays at the default level otherwise', async () => {
    expect((await loggerWith(true)).level).toBe(LogLevels.debug)
    expect((await loggerWith(false)).level).toBe(LogLevels.info)
  })

  it('is a consola instance a caller can use', async () => {
    const logger = await loggerWith(false)
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.error).toBe('function')
  })
})
