/**
 * Written when `$HHOSTED_HOME` has no state yet. Every seed stays empty of
 * servers on purpose: home-hosted ships none, so what a user supervises is
 * theirs to declare. The rest is default policy, which the settings pages can
 * change.
 */

/** `$HHOSTED_HOME/.hh/settings.json`. */
export const SEED_GLOBAL_SETTINGS = {
  $schema: './settings.schema.json',
  control: {
    port: 3999,
    host: 'local',
    openBrowser: false,
  },
} as const

/** `$HHOSTED_HOME/.hh/<id>/settings.json`. */
export const SEED_WORKSPACE_SETTINGS = {
  $schema: './settings.schema.json',
  defaults: {
    enabled: true,
    autostart: false,
    bind: 'local',
    onPortConflict: 'block',
  },
} as const

/** `$HHOSTED_HOME/.hh/<id>/servers.config.json`. */
export const SEED_SERVERS_FILE = {
  $schema: './servers.config.schema.json',
  servers: [],
} as const
