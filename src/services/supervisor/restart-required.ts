import type { ServerConfig } from '#src/shared/contracts'

/**
 * The config fields a running process actually reads at spawn.
 *
 * A `PUT`/`PATCH /api/servers/:id` writes config only — the process keeps whatever it was started
 * with — so a person who changed the command, the args or the port and pressed Save saw "saved" and
 * nothing else, while the old program kept serving. Comparing the current config against the one the
 * run started from is what turns that silence into a "Restart to apply" badge.
 *
 * **What is in this list is the whole decision.** A field belongs here only if the process would be
 * different after a restart:
 *
 * - `command`, `args`, `cwd`, `env`, `envFile`, `dataEnvs` — what is executed and the environment it
 *   gets. `dataEnvs` feeds both the environment and the backup paths;
 * - `port`, `bind` — the listener the process is told to use;
 * - `persistent` — whether a nanny owns it, which changes the next start entirely;
 * - `stop` — the signal and grace a restart would apply.
 *
 * Deliberately **not** here: `label`, `enabled`, `autostart`, `health`, `restart`, `resources`,
 * `dependsOn`, `logBufferLines`, the backup fields and the port-conflict policy. Every one of them is
 * read live by the panel (a health probe, a memory ceiling, a retry budget), so restarting for them
 * would restart a service for a change already in effect — the noise that makes a badge ignored.
 */
export type RestartRelevant = Pick<
  ServerConfig,
  'command' | 'args' | 'cwd' | 'env' | 'envFile' | 'secretEnv' | 'port' | 'bind' | 'persistent' | 'stop' | 'dataEnvs'
>

/** The restart-relevant part of a config, as a value that can be compared and held. */
export function restartRelevant(config: ServerConfig): RestartRelevant {
  // Defensive on the *collections* only: a caller holding a hand-built or partially-defaulted config
  // (a test fixture, a view built from a record) has no `args` to spread, and a view that throws is
  // worse than one with no badge. The schema fills these in everywhere the config comes from a file.
  return {
    command: config.command,
    args: [...(config.args ?? [])],
    cwd: config.cwd,
    env: { ...(config.env ?? {}) },
    envFile: config.envFile,
    // The child's environment is fixed at spawn, so declaring or un-declaring a secret name is a
    // change this process will not see until it restarts.
    secretEnv: [...(config.secretEnv ?? [])],
    port: config.port,
    bind: config.bind,
    persistent: config.persistent,
    stop: { ...config.stop },
    dataEnvs: { ...(config.dataEnvs ?? {}) },
  }
}

/**
 * Whether a running process predates a config change that needs a restart.
 *
 * `startedFrom` is `null` when nothing runs (and is cleared with the run), so a stopped entry never
 * claims a difference — there is nothing to restart, and the next start reads the current config.
 *
 * Compared by value, key by key, rather than `JSON.stringify`: a key order difference between a
 * schema default and a hand-written config would otherwise read as a change forever. `env` and
 * `dataEnvs` are compared key by key for the same reason, and because a person adding one variable to
 * a map of twenty must mark the entry rather than depend on where it landed.
 */
export function needsRestart(current: ServerConfig, startedFrom: RestartRelevant | null | undefined): boolean {
  // `undefined` as well as `null`: a caller that built an `Entry` by hand (a fixture, a projection)
  // has no such field, and "nothing is running" is the honest reading of both.
  if (startedFrom === null || startedFrom === undefined)
    return false
  const now = restartRelevant(current)
  if (now.command !== startedFrom.command || now.cwd !== startedFrom.cwd || now.envFile !== startedFrom.envFile)
    return true
  // Declared secret names: the environment a running child got is the set it started with.
  if (now.secretEnv.length !== startedFrom.secretEnv.length || now.secretEnv.some((name, index) => name !== startedFrom.secretEnv[index]))
    return true
  if (now.port !== startedFrom.port || now.bind !== startedFrom.bind || now.persistent !== startedFrom.persistent)
    return true
  if (now.args.length !== startedFrom.args.length || now.args.some((arg, index) => arg !== startedFrom.args[index]))
    return true
  if (now.stop.signal !== startedFrom.stop.signal || now.stop.killGroup !== startedFrom.stop.killGroup || now.stop.graceMs !== startedFrom.stop.graceMs)
    return true
  return !sameMap(now.env, startedFrom.env) || !sameMap(now.dataEnvs, startedFrom.dataEnvs)
}

/** Two string maps with the same keys and the same values. */
function sameMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length)
    return false
  return leftKeys.every(key => Object.hasOwn(right, key) && left[key] === right[key])
}
