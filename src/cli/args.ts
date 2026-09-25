import type { ArgsDef } from 'citty'
import path from 'node:path'
import process from 'node:process'

/**
 * The argument work that happens *before* citty: `--home`/`--project` have to
 * change the environment before any `#src` module resolves a path, and the
 * curated surface (`help`, `version`, `unknown command`) has to stay byte-for-
 * byte what it always was. Both live here so they can be tested without a
 * terminal, a daemon or a spawned process; this module imports node builtins
 * only and never reads the state directories itself.
 */

export interface DirFlags {
  project?: string
  home?: string
}

export interface DirFlagResult extends DirFlags {
  rest: string[]
  error?: string
}

/** `--home`/`--project` are handled for every command, so they are peeled off first. */
export function extractDirFlags(argv: string[]): DirFlagResult {
  const rest: string[] = []
  let project: string | undefined
  let home: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (name !== '--project' && name !== '--home') {
      rest.push(arg)
      continue
    }
    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1)
    if (value === undefined || value.length === 0)
      return { rest, project, home, error: `${name} needs a directory` }
    if (name === '--project')
      project = value
    else
      home = value
  }

  return { rest, project, home }
}

/** Set before any state module is imported, so it decides where state lives. */
export function applyDirFlags(flags: DirFlags): void {
  if (flags.project !== undefined)
    process.env.HHOSTED_PROJECT = path.resolve(flags.project)
  if (flags.home !== undefined)
    process.env.HHOSTED_HOME = path.resolve(flags.home)
}

export type Invocation
  = | { kind: 'help' }
    | { kind: 'version' }
    | { kind: 'command', argv: string[] }
    | { kind: 'unknown', command: string }

const HELP_TOKENS = new Set(['help', '--help', '-h'])
const VERSION_TOKENS = new Set(['version', '--version', '-v'])
// After a command, only the flag forms count: a bare `help` may be the value of an
// option (`init --name help`), and answering that with the usage text would skip
// the command instead of running it.
const HELP_FLAGS = new Set(['--help', '-h'])
const VERSION_FLAGS = new Set(['--version', '-v'])

/**
 * What the stripped argv means, before citty sees it.
 *
 * `help`/`version` are commands here, not flags, and a help or version flag on a
 * command is answered the same way instead of being parsed as one of that
 * command's options. A first token that starts with `-` is the one-shot form
 * (`home-hosted -p 4000`), so `up` is prepended. Anything else has to name a
 * command, which keeps the old `unknown command:` text exact.
 */
export function resolveInvocation(argv: string[], commands: readonly string[]): Invocation {
  if (argv.length === 0)
    return { kind: 'command', argv: ['up'] }

  const first = argv[0]!
  if (HELP_TOKENS.has(first))
    return { kind: 'help' }
  if (VERSION_TOKENS.has(first))
    return { kind: 'version' }

  if (first.startsWith('-'))
    return { kind: 'command', argv: ['up', ...argv] }

  if (!commands.includes(first))
    return { kind: 'unknown', command: first }

  for (const arg of argv.slice(1)) {
    if (HELP_FLAGS.has(arg))
      return { kind: 'help' }
    if (VERSION_FLAGS.has(arg))
      return { kind: 'version' }
  }

  return { kind: 'command', argv }
}

const CAMEL = /[A-Z]/g

/** citty takes camelCase definitions; the flag a person types is kebab-case. */
function kebab(name: string): string {
  return name.replace(CAMEL, match => `-${match.toLowerCase()}`)
}

function aliasesOf(def: ArgsDef[string]): string[] {
  if (def === undefined || !('alias' in def) || def.alias === undefined)
    return []
  return Array.isArray(def.alias) ? def.alias : [def.alias]
}

function findArg(argsDef: ArgsDef, name: string): ArgsDef[string] | undefined {
  for (const [key, def] of Object.entries(argsDef)) {
    if (def === undefined)
      continue
    const names = new Set([key, kebab(key), ...aliasesOf(def)])
    if (names.has(name))
      return def
    // `--no-<flag>` is citty's negation of a declared boolean, never an option.
    if (def.type === 'boolean' && (name === `no-${key}` || name === `no-${kebab(key)}`))
      return def
  }
  return undefined
}

/**
 * citty parses permissively (`strict: false`), so a mistyped flag would quietly do
 * nothing — `--autostart` where `--no-autostart` was meant would start the panel
 * with the wrong policy. This keeps the refusal the command line always had, from
 * citty's own definitions rather than a second list.
 *
 * A command that declares no arguments parses its own argv (and rejects its own
 * unknown flags), so it is left alone. Returns the message to print, or null.
 */
export function rejectUnknownFlags(argv: string[], argsDef: ArgsDef | undefined): string | null {
  if (argsDef === undefined || Object.keys(argsDef).length === 0)
    return null

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--')
      return null
    if (!token.startsWith('-') || token.length === 1)
      return `Unexpected argument '${token}'`

    const body = token.startsWith('--') ? token.slice(2) : token.slice(1)
    const equals = body.indexOf('=')
    const name = equals === -1 ? body : body.slice(0, equals)
    const def = name.length === 0 ? undefined : findArg(argsDef, name)
    if (def === undefined)
      return `Unknown option '${token}'`
    // A string option consumes the next token, unless it was given inline.
    if (def.type === 'string' && equals === -1 && argv[index + 1] === undefined)
      return `Option '${token}' needs a value`
    if (def.type === 'string' && equals === -1)
      index += 1
  }

  return null
}

export interface UpFlags {
  config?: string
  port?: number
  host?: string
  autostart: boolean
  open: boolean
  foreground: boolean
  printConfig: boolean
}

/**
 * The daemon gets the same instructions, but never `--foreground` (that is what
 * makes it the daemon) and never `--print-config` (that one is answered in the
 * calling process).
 */
export function buildDaemonArgv(flags: UpFlags): string[] {
  const args: string[] = ['up', '--foreground']
  if (flags.config !== undefined)
    args.push('--config', flags.config)
  if (flags.port !== undefined)
    args.push('--port', String(flags.port))
  if (flags.host !== undefined)
    args.push('--host', flags.host)
  if (!flags.autostart)
    args.push('--no-autostart')
  if (flags.open)
    args.push('--open')
  return args
}
