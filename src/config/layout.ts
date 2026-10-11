import fs from 'node:fs'
import { hasLegacyLayout, legacy } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'

/**
 * Refuses a state directory this release cannot use, before any command resolves a
 * path into it.
 *
 * Through 0.7.x this relocated a pre-workspace `$HHOSTED_HOME` automatically. 0.8.0
 * dropped the mover, so an instance that never crossed `.hh` is stopped instead of
 * being read as an empty one — its `servers.config.json` would otherwise sit unread
 * beside a panel supervising nothing, with no error anywhere. The migration itself is
 * unchanged and still shipped: the 0.7 line performs it on its first run.
 */
export function ensureLayout(): void {
  if (!hasLegacyLayout())
    return

  const found = [legacy.configPath, legacy.secretsPath].filter(file => fs.existsSync(file))
  throw new Error(
    `${found.join(', ')} belongs to home-hosted 0.6.x, which ${appVersion()} no longer relocates.\n`
    + '  Install the latest 0.7.x once — it moves that state into .hh/ on its first run — then start this release.\n'
    + '  Nothing has been changed or deleted.',
  )
}
