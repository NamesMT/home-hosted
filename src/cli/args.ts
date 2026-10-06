import type { ArgsDef } from 'citty'
import path from 'node:path'
import process from 'node:process'
import { nearestWord } from './nearest'

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
  = | { kind: 'help', command?: string }
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
 * command's options. A help flag after a command keeps that command's name, so
 * the curated text can stay scoped to it; the bare `help` (or a top-level flag)
 * is the whole reference. A first token that starts with `-` is the one-shot
 * form (`home-hosted -p 4000`), so `up` is prepended. Anything else has to name
 * a command, which keeps the old `unknown command:` text exact.
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
      return { kind: 'help', command: first }
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

/**
 * Every spelling that reaches one declared option: the key, its kebab form, each alias, and the
 * `no-` negation citty gives a boolean. `findArg` accepts on this set and the suggestion offers from
 * it, so a suggestion can never name a spelling the parser would then refuse.
 */
function namesOf(key: string, def: NonNullable<ArgsDef[string]>): string[] {
  return [key, kebab(key), ...aliasesOf(def)]
}

/** The spellings of every option this command declares, for a suggestion. */
function declaredOptionNames(argsDef: ArgsDef): string[] {
  const names: string[] = []
  for (const [key, def] of Object.entries(argsDef)) {
    if (def === undefined || def.type === 'positional')
      continue
    names.push(...namesOf(key, def))
    if (def.type === 'boolean')
      names.push(...namesOf(key, def).map(name => `no-${name}`))
  }
  return names
}

function findArg(argsDef: ArgsDef, name: string): ArgsDef[string] | undefined {
  for (const [key, def] of Object.entries(argsDef)) {
    if (def === undefined)
      continue
    // A positional is never reachable as `--<key>`: `start --id web` is a mistake,
    // not a second way to spell `start web`.
    if (def.type === 'positional')
      continue
    if (namesOf(key, def).includes(name))
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

  // Declared positionals are the only bare arguments a command accepts, and they
  // are filled in the order they were declared (`start <id>`).
  let positionals = Object.values(argsDef).filter(def => def?.type === 'positional').length

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--')
      return null
    if (!token.startsWith('-') || token.length === 1) {
      if (positionals === 0)
        return `Unexpected argument '${token}'`
      positionals -= 1
      continue
    }

    const body = token.startsWith('--') ? token.slice(2) : token.slice(1)
    const equals = body.indexOf('=')
    const name = equals === -1 ? body : body.slice(0, equals)
    const def = name.length === 0 ? undefined : findArg(argsDef, name)
    if (def === undefined) {
      // The valid names are right here in `argsDef`, so a near miss can name the option it meant —
      // `--autostart` for `--no-autostart` is the case that matters. A far-off name gets nothing.
      const suggested = nearestWord(name, declaredOptionNames(argsDef))
      const hint = suggested === null ? '' : ` — did you mean \`--${suggested}\`?`
      return `Unknown option '${token}'${hint}`
    }
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
