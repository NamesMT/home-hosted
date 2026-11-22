/**
 * Turning another manager's declaration into this panel's entries — a **pure** mapping.
 *
 * pm2 and compose describe a service differently, and the interesting part is not the copy but the
 * **refusals**: a name that slugifies onto another one, a `watch` this panel has no equivalent for, a
 * `cron_restart` that is a scheduled job rather than a supervisor setting. Those are reported, never
 * dropped in silence — a person importing a setup needs to know what will not be carried, and the
 * plan is the only place they will read it.
 *
 * No I/O here: the command reads the file, this decides, and the command writes. That keeps every
 * mapping testable without a home, a panel or a file.
 */

/** One pm2 `apps[]` element, as far as this importer reads it. */
export interface Pm2App {
  name?: unknown
  script?: unknown
  interpreter?: unknown
  args?: unknown
  cwd?: unknown
  env?: unknown
  autorestart?: unknown
  max_restarts?: unknown
  max_memory_restart?: unknown
  watch?: unknown
  cron_restart?: unknown
  instances?: unknown
  exec_mode?: unknown
}

export interface ImportPlan {
  /** The entries that would be written, ready for `addServerEntry`. */
  entries: Array<Record<string, unknown>>
  /** One line per thing this panel cannot carry, naming the app and the field. */
  warnings: string[]
  /** One line per refusal: a collision, an unusable name, a missing script. */
  errors: string[]
}

/**
 * An id from a pm2 name: lowercase, everything that is not `[a-z0-9_-]` collapsed to a dash.
 *
 * pm2 names are free text (`"My App"`, `"api/worker"`), while a server id is a directory-safe slug.
 * The collapse can make two names collide, which is why the caller checks — silently merging two
 * apps into one id would lose one of them.
 */
export function slugifyId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
  return slug.length === 0 ? 'app' : slug
}

/**
 * pm2's `args` is **one string**, split the way a shell would for a simple case.
 *
 * Deliberately not a full shell parse: quoting is where `exec_mode: 'cluster'` apps and anything with
 * an embedded `\` diverge, and guessing wrong would silently change a program's arguments. A string
 * with quotes is split on whitespace and the quotes reported, so a person can fix the entry rather
 * than discover it at spawn.
 */
export function splitArgs(raw: string): { args: string[], quoted: boolean } {
  const args = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/).filter(part => part.length > 0)
  return { args, quoted: /['"]/.test(raw) }
}

/** `200M`, `1G`, `512K`, `1024` (pm2 reads a bare number as bytes) — or `null` for "no ceiling". */
export function parseMemoryLimit(raw: unknown): number | null {
  if (typeof raw === 'number')
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null
  if (typeof raw !== 'string')
    return null
  // Anchored, and each quantifier on a distinct run of characters: `\s*(\d+)\s*` lets the two
  // `\s*` exchange characters, which backtracks polynomially on a long non-matching string. Trimmed
  // first and then matched without leading whitespace, so there is one ambiguity fewer.
  const match = /^(\d+(?:\.\d+)?)\s{0,4}([kmg])?b?$/i.exec(raw.trim())
  if (match === null)
    return null
  const value = Number.parseFloat(match[1]!)
  const unit = (match[2] ?? '').toLowerCase()
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1
  const bytes = Math.round(value * factor)
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

/**
 * The keys of `env` whose **names** read as secrets, sorted so the plan is stable.
 *
 * Conservative by design — see the call site. `envFile` would be the other answer, but that is a file the
 * person owns and this importer is creating entries, not asking them to write one.
 */
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)(?:$|_)/i
function envOfSecretNames(env: Record<string, string>): string[] {
  return Object.keys(env).filter(key => SECRET_NAME.test(key)).sort()
}

/** A flat `Record<string, string>` from whatever pm2 put in `env`, dropping non-strings. */
function envOf(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return {}
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string')
      env[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean')
      env[key] = String(value)
  }
  return env
}

/**
 * pm2 apps to entries.
 *
 * The mapping, and the reasoning for each choice:
 * - `interpreter` (default `node`) becomes `command`, and `script` its first argument — pm2 runs
 *   `node server.js` and this panel spawns `command` with `args`, so anything else would ask for a
 *   program named `server.js`;
 * - `autorestart: false` becomes `restart.enabled: false`; `max_restarts` becomes `maxRetries`;
 * - `max_memory_restart` becomes `resources.maxRssBytes` (the panel restarts on it too);
 * - `watch` and `cron_restart` have no equivalent here and are **reported**: the first is a
 *   development convenience, the second a scheduled job (this release has neither);
 * - `instances`/`exec_mode: 'cluster'` are reported: this panel supervises one process per entry, so
 *   importing a 4-instance cluster would silently run one.
 */
export function planPm2Apps(apps: readonly Pm2App[]): ImportPlan {
  const entries: Array<Record<string, unknown>> = []
  const warnings: string[] = []
  const errors: string[] = []
  const taken = new Map<string, string>()

  for (const app of apps) {
    const name = typeof app.name === 'string' && app.name.trim().length > 0 ? app.name.trim() : null
    if (name === null) {
      errors.push('an app with no `name` cannot be imported — give it one and try again')
      continue
    }
    const id = slugifyId(name)
    const previous = taken.get(id)
    if (previous !== undefined) {
      // Two names, one id. Merging them would lose an app; renaming one silently would surprise.
      errors.push(`id collision: "${name}" and "${previous}" both become "${id}" — rename one in the pm2 file, or add them one at a time`)
      continue
    }
    taken.set(id, name)

    const script = typeof app.script === 'string' ? app.script.trim() : ''
    if (script.length === 0) {
      errors.push(`"${name}" has no \`script\` — pm2 needs one too, so this is a broken app declaration`)
      continue
    }
    const interpreter = typeof app.interpreter === 'string' && app.interpreter.trim().length > 0
      ? app.interpreter.trim()
      : 'node'

    // `node` runs `script` directly; anything else (`python`, `bash`) is the program with the script
    // as its argument, which is the same shape.
    const split = typeof app.args === 'string' ? splitArgs(app.args) : { args: [], quoted: false }
    if (split.quoted)
      warnings.push(`"${name}": \`args\` contains quotes, which this importer splits on whitespace — check the arguments after importing`)

    const entry: Record<string, unknown> = {
      id,
      command: interpreter,
      args: [script, ...split.args],
    }
    if (typeof app.cwd === 'string' && app.cwd.trim().length > 0)
      entry.cwd = app.cwd.trim()
    const env = envOf(app.env)
    /**
     * A **secret-looking** pm2 env value must not be written into `servers.config.json`.
     *
     * `AGENTS.md` is flat about it: *"Secrets never enter a config file; secret files are 0600"*. Importing
     * an ecosystem file used to carry every `env` entry across verbatim — measured, `API_KEY:
     * "secret-value"` landed in `servers.config.json` in the clear. `secretEnv` is the mechanism that
     * exists for this: the **names** stay in the config and the values go to the workspace's
     * `.secrets.json` (0600).
     *
     * The detection is by name, deliberately conservative: a key is treated as a secret when it reads as
     * one (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `PRIVATE`). A false positive costs
     * nothing — the value still works, it just lives in the 0600 file — while a false negative puts a
     * credential in the config, which is the outcome worth avoiding.
     */
    const secrets = envOfSecretNames(env)
    const plain = Object.fromEntries(Object.entries(env).filter(([key]) => !secrets.includes(key)))
    if (Object.keys(plain).length > 0)
      entry.env = plain
    if (secrets.length > 0)
      entry.secretEnv = secrets

    // `enabled` is written whenever pm2 states it, in both directions: an imported entry should say
    // what pm2 said rather than inherit a default that a later default change could move. It is also
    // what makes the import readable — a person checking the result sees `autorestart` carried.
    // `max_restarts` merges into the same group rather than replacing it (assigning twice dropped
    // the first).
    const restart: Record<string, unknown> = {}
    if (typeof app.autorestart === 'boolean')
      restart.enabled = app.autorestart
    if (typeof app.max_restarts === 'number' && Number.isInteger(app.max_restarts) && app.max_restarts >= 0)
      restart.maxRetries = app.max_restarts
    if (Object.keys(restart).length > 0)
      entry.restart = restart
    const maxRssBytes = parseMemoryLimit(app.max_memory_restart)
    if (maxRssBytes !== null)
      entry.resources = { maxRssBytes }

    if (app.watch === true)
      warnings.push(`"${name}": \`watch\` is not carried — this panel restarts on a crash, not on a file change (run a build watcher as its own entry)`)
    if (typeof app.cron_restart === 'string' && app.cron_restart.trim().length > 0)
      // No `invocation()` here: this module is a **pure** map with no runtime imports, which is what lets
      // its tests read it as data. The caller that prints this warning adds the invocation — see
      // `import.ts`.
      warnings.push(`"${name}": \`cron_restart "${app.cron_restart}"\` is not carried — this release has no scheduled restart; use a cron job that runs the restart command`)
    if (app.exec_mode === 'cluster' || (typeof app.instances === 'number' && app.instances > 1))
      warnings.push(`"${name}": \`instances\`/\`exec_mode: cluster\` is not carried — this panel supervises one process per entry, so importing would run a single instance`)

    entries.push(entry)
  }

  return { entries, warnings, errors }
}

/**
 * A compose file as one entry, because the containers *are* the server.
 *
 * The panel already knows how to supervise a compose stack: it detects the project from the entry's
 * argv (`isComposeCommand`) and treats the containers as the process. So the import is the argv pm2
 * would never describe — `docker compose -f <file> up` — with the file path as an argument.
 *
 * `--id` defaults to the directory name, which is compose's own default project name.
 */
export function composeEntry(file: string, id: string, cwd?: string): Record<string, unknown> {
  return {
    id,
    command: 'docker',
    args: ['compose', '-f', file, 'up'],
    ...(cwd === undefined ? {} : { cwd }),
    // A stack that comes up at boot is what a compose entry is for; compose itself owns restarting.
    autostart: true,
  }
}

/** Whether a compose file actually declares services, which is the one thing that makes it one. */
export function looksLikeCompose(parsed: unknown): boolean {
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && typeof (parsed as { services?: unknown }).services === 'object'
    && (parsed as { services?: unknown }).services !== null
}
