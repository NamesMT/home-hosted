/**
 * What a new user actually has: a line someone gave them, not a form.
 *
 * The empty add-server dialog asks for a command, arguments, a port, a bind address and a health
 * check, with hints like "Spawned without a shell." — every one of which assumes the person knows
 * what those mean. A user who pasted `java -jar server.jar` into *command* got
 * `spawn java -jar server.jar ENOENT` and no next step.
 *
 * A preset is the smallest thing that fixes that: a name, a command split correctly, the port the
 * thing usually listens on, and one sentence about what to change. It fills the form; it never
 * creates anything the person cannot then edit.
 *
 * Data, not components, so the mapping is testable on its own — the failure mode of a preset is a
 * field that silently does not reach `servers.config.json`.
 */

import type { AddServerForm } from '@/components/server/addServerForm'
import { blankAddServerForm } from '@/components/server/addServerForm'

/** A starting point for the add-server form. */
export interface ServerPreset {
  /** Stable id, used as the React-style key and in tests. */
  id: string
  /**
   * A catalog key for the preset's name. A preset is a product word ("Minecraft"), not a
   * translated sentence, so most names are the same in every language — but they still travel
   * through the catalog so a translator can localise one that is not.
   */
  nameKey: string
  /** A catalog key for the one line that says what this is and what to check. */
  descriptionKey: string
  /** The executable. Never a full command line: that is the mistake this exists to prevent. */
  command: string
  /** Arguments, one per entry, exactly as the process wants them. */
  args: string[]
  /** What it usually listens on, or null when the preset has no port to probe. */
  port: number | null
  /** Whether it should come back with the panel. */
  autostart: boolean
  /** Filled into the label so the card reads as a name, not an id. */
  label: string
  /**
   * Environment the program needs to run the way the preset describes, as `KEY=value` lines.
   *
   * A rootless Gitea is the case that needs it: it has no config file on a first run, so its two
   * ports are env-only until the install wizard writes `app.ini`.
   */
  env?: string[]
}

/**
 * The gallery. Deliberately small and boring: each one is a thing a home user plausibly runs,
 * chosen because getting its command line wrong is the common failure.
 */
export const SERVER_PRESETS: ServerPreset[] = [
  {
    id: 'minecraft',
    nameKey: 'presets.minecraft',
    descriptionKey: 'presets.minecraftHint',
    command: 'java',
    // No `{port}`: the vanilla server takes its port from `server.properties`, not from argv, so a
    // port argument here would be silently ignored. The entry's port is what the panel probes.
    args: ['-Xmx2G', '-jar', 'server.jar', 'nogui'],
    port: 25565,
    autostart: true,
    label: 'Minecraft',
  },
  {
    id: 'jellyfin',
    nameKey: 'presets.jellyfin',
    descriptionKey: 'presets.jellyfinHint',
    command: 'jellyfin',
    // No port argument: Jellyfin's HTTP port lives in its own `network.xml` and is changed in its
    // web UI. The entry's port is only what the panel probes.
    args: [],
    port: 8096,
    autostart: true,
    label: 'Jellyfin',
  },
  {
    id: 'node',
    nameKey: 'presets.node',
    descriptionKey: 'presets.nodeHint',
    command: 'node',
    // The app reads `PORT`, which is the convention every Node server follows; `{port}` is what
    // makes the form's port field actually mean something to the process.
    args: ['server.js'],
    port: 3000,
    autostart: true,
    label: 'Node app',
    env: ['PORT={port}'],
  },
  {
    id: 'python',
    nameKey: 'presets.python',
    descriptionKey: 'presets.pythonHint',
    command: 'python',
    args: ['-m', 'http.server', '{port}'],
    port: 8000,
    autostart: false,
    label: 'Python server',
  },
  {
    id: 'gitea',
    nameKey: 'presets.gitea',
    descriptionKey: 'presets.giteaHint',
    // The rootless binary: no privileged port to bind, no system user needed. The web UI and the
    // built-in SSH server both need telling, and neither has a config file until the wizard runs.
    command: 'gitea',
    args: ['web'],
    port: 3000,
    autostart: true,
    label: 'Gitea (rootless)',
    // The web port follows the form (`{port}`); templates are plain substitution with no
    // arithmetic, so the SSH port stays a fixed 2222 — a second Gitea on another web port would
    // still collide there, and the form cannot express "web + 1".
    env: ['GITEA_WORK_DIR=./data', 'GITEA__server__HTTP_PORT={port}', 'GITEA__server__SSH_PORT=2222', 'GITEA__server__START_SSH_SERVER=true'],
  },
  {
    id: 'mongodb',
    nameKey: 'presets.mongodb',
    descriptionKey: 'presets.mongodbHint',
    command: 'mongod',
    args: ['--dbpath', './data', '--port', '{port}'],
    port: 27017,
    autostart: true,
    label: 'MongoDB',
  },
  {
    id: 'docker',
    nameKey: 'presets.docker',
    descriptionKey: 'presets.dockerHint',
    command: 'docker',
    args: ['compose', 'up'],
    port: null,
    autostart: true,
    label: 'Docker Compose',
  },
  {
    id: 'bot',
    nameKey: 'presets.bot',
    descriptionKey: 'presets.botHint',
    command: 'node',
    args: ['bot.js'],
    port: null,
    autostart: true,
    label: 'Bot',
  },
]

/**
 * The form a preset fills in, keeping the id and label the person may already have typed.
 *
 * Everything the preset does not name comes from `blankAddServerForm`, so a preset inherits the
 * workspace defaults exactly as a hand-filled entry would — the preset is a starting point, never
 * a second source of policy.
 */
export function applyPreset(
  preset: ServerPreset,
  options: { defaults?: Parameters<typeof blankAddServerForm>[0], id?: string, label?: string } = {},
): AddServerForm {
  const blank = blankAddServerForm(options.defaults)
  return {
    ...blank,
    // A slug of the preset's own name, so the form is valid the moment it is filled.
    id: options.id !== undefined && options.id.length > 0 ? options.id : preset.id,
    label: options.label !== undefined && options.label.length > 0 ? options.label : preset.label,
    command: preset.command,
    args: preset.args.join('\n'),
    port: preset.port,
    autostart: preset.autostart,
    env: (preset.env ?? []).join('\n'),
  }
}
