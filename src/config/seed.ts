import type { RawConfig } from '#src/config/schema'

/**
 * Written when a data directory has no config yet (`$HHOSTED_HOME/servers.config.json`).
 *
 * It stays empty on purpose: home-hosted ships no servers of its own, so what a
 * user supervises is theirs to declare. The rest of the file is default policy,
 * which the settings page can change.
 */
export const SEED_CONFIG: RawConfig = {
  $schema: './servers.config.schema.json',
  control: {
    port: 3999,
    host: 'local',
    openBrowser: false,
  },
  defaults: {
    enabled: true,
    autostart: false,
    bind: 'local',
    onPortConflict: 'block',
  },
  servers: [],
}
