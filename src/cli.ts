import type { SubCommandsDef } from 'citty'
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineCommand, runCommand } from 'citty'
import { applyDirFlags, extractDirFlags, rejectUnknownFlags, resolveInvocation } from './cli/args'
import { cyan, dim, fail, heading } from './cli/io'

/**
 * The command line, and nothing else. Two things happen before citty is asked
 * anything: `--home`/`--project` are peeled off and applied (because
 * `#src/helpers/paths.ts` resolves at import time), and the curated surface —
 * `help`, `version`, `unknown command`, and the `-p 4000` shorthand for `up` —
 * is decided. The command modules are then resolved lazily by citty, so their
 * own `#src` imports are safe: by the time one is imported, the directories are
 * already in the environment.
 *
 * The only static imports here are node builtins, citty, and the two path-free
 * local modules the pre-pass needs; every command (and so every state-reading
 * module) is a dynamic import behind `subCommands`.
 */

const CLI_ENTRY = fileURLToPath(import.meta.url)

/**
 * The curated prose, kept here because citty cannot generate it. One named
 * piece per command, so the full reference and a single command's help are
 * composed from the same lines and can never drift apart. Every section lays
 * its left column out at the same width, so the two views read alike.
 */

const HEADER = 'home-hosted — a control panel for the processes on your home server'

/** The one line the full reference lists for a command. */
const SYNOPSIS: Record<string, string> = {
  'up': 'home-hosted up [options]',
  'down': 'home-hosted down',
  'restart': 'home-hosted restart [options]',
  'status': 'home-hosted status [--json]',
  'set-password': 'home-hosted set-password',
  'set-token': 'home-hosted set-token',
  'migrate': 'home-hosted migrate',
  'init': 'home-hosted init',
  'ui-switch': 'home-hosted ui-switch',
  'ui-update': 'home-hosted ui-update',
  'ui-revert': 'home-hosted ui-revert',
}

const SUMMARIES: Record<string, string> = {
  'up': 'start it in the background (detached)',
  'down': 'stop it, and everything it supervises',
  'restart': 'down, then up',
  'status': 'is it running, where, and how to reach it',
  'set-password': 'set the panel password without the API',
  'set-token': 'set the API token that scripts and agents use',
  'migrate': 'bring the config up to this release\'s schema',
  'init': 'scaffold a project that keeps its state in the repo',
  'ui-switch': 'install a UI from a release asset, a zip file or a URL',
  'ui-update': 'bring the installed UI up to date, or pick a release',
  'ui-revert': 'go back to the stock control panel UI',
}

/** One option line, as the left column and the description that follows it. */
type OptionLine = [left: string, right: string]

/** A heading and the option lines under it. */
interface OptionSection {
  heading: string
  lines: OptionLine[]
}

/** Every section lays its left column out at this width, so the two views align. */
const OPTION_WIDTH = 19

const UP_SECTION: OptionSection = {
  heading: 'Options for up/restart',
  lines: [
    ['-c, --config <file>', 'servers config (default: <state>/servers.config.json)'],
    ['-p, --port <port>', 'control panel port (default: 3999)'],
    ['--host <bind>', 'local | lan | an ipv4 address (default: local)'],
    ['--open', 'open the panel in a browser once it is up'],
    ['--no-autostart', 'do not start the entries marked autostart'],
    ['--foreground', 'run in this process instead of detaching (systemd/docker)'],
    ['--print-config', 'print the effective config and exit'],
  ],
}

const STATUS_SECTION: OptionSection = {
  heading: 'Options for status',
  lines: [
    ['--json', 'print machine-readable JSON'],
  ],
}

const SET_PASSWORD_SECTION: OptionSection = {
  heading: 'Options for set-password',
  lines: [
    ['--clear', 'remove the password, which disables authentication'],
  ],
}

const SET_TOKEN_SECTION: OptionSection = {
  heading: 'Options for set-token',
  lines: [
    ['--generate', 'create a strong token and print it once'],
    ['--clear', 'remove the token, so it stops working'],
  ],
}

const MIGRATE_SECTION: OptionSection = {
  heading: 'Options for migrate',
  lines: [
    ['--dry-run', 'print what would change, write nothing'],
    ['-y, --yes', 'apply without asking (or set HHOSTED_MIGRATE=allow)'],
  ],
}

const INIT_SECTION: OptionSection = {
  heading: 'Options for init',
  lines: [
    ['--dir <dir>', 'where to scaffold (default: ./my-servers)'],
    ['--name <name>', 'package name (default: the directory name)'],
    ['--pm <manager>', 'pnpm | npm | yarn | bun (default: the first one installed)'],
    ['--no-install', 'write the files, install nothing'],
    ['-y, --yes', 'take every default, ask nothing'],
  ],
}

const UI_SWITCH_SECTION: OptionSection = {
  heading: 'Options for ui-switch',
  lines: [
    ['--repo <owner/name>', 'release repo (default: NamesMT/home-hosted)'],
    ['--tag <tag>', 'release tag (default: this release\'s tag, or latest for another repo)'],
    ['--asset <name>', 'asset to install (exact or unambiguous match)'],
    ['--file <path|url>', 'install a zip from a local path or an http(s) URL'],
    ['--list', 'list the usable assets and install nothing'],
    ['--token <token>', 'GitHub token (or GITHUB_TOKEN / GH_TOKEN)'],
    ['-y, --yes', 'take the only asset instead of asking'],
  ],
}

const UI_UPDATE_SECTION: OptionSection = {
  heading: 'Options for ui-update',
  lines: [
    ['--check', 'report whether an update is available and install nothing'],
    ['--tag <tag>', 'install that release instead of asking'],
    ['--asset <name>', 'asset to install (defaults to the one in use)'],
    ['--old', 'list older releases instead of newer ones'],
    ['--repo <owner/name>', 'for a UI that does not declare its own repo'],
    ['--token <token>', 'GitHub token (or GITHUB_TOKEN / GH_TOKEN)'],
    ['-y, --yes', 'take the only release instead of asking'],
  ],
}

const EVERYWHERE_SECTION: OptionSection = {
  heading: 'Everywhere',
  lines: [
    ['--home <dir>', 'state directory (default: $HHOSTED_HOME or ~/.home-hosted)'],
    ['--project <dir>', 'base for relative entry paths (default: the current directory)'],
    ['-h, --help', 'this text'],
    ['-v, --version', 'the version'],
  ],
}

const ALIAS_SECTION: OptionSection = {
  heading: 'Alias',
  lines: [
    ['hh', 'the same CLI, on a machine where home-hosted is installed'],
  ],
}

const ENVIRONMENT_SECTION: OptionSection = {
  heading: 'Environment',
  lines: [
    ['HHOSTED_HOME', 'where config, secrets, logs, TLS and backups live'],
    ['HHOSTED_PROJECT', 'base for relative entry paths'],
    ['HHOSTED_PASSWORD', 'the password for a non-interactive set-password'],
    ['HHOSTED_TOKEN', 'the token for a non-interactive set-token'],
    ['GITHUB_TOKEN', 'a GitHub token for ui-switch (GH_TOKEN also works)'],
  ],
}

/** The command list of the full reference, aligned as it always was. */
function renderCommandList(): string {
  const width = Math.max(...Object.values(SYNOPSIS).map(synopsis => synopsis.length))
  return Object.keys(SYNOPSIS)
    .map((name) => {
      const synopsis = SYNOPSIS[name]!
      return `  ${cyan(synopsis)}${' '.repeat(width + 1 - synopsis.length)}   ${SUMMARIES[name]}`
    })
    .join('\n')
}

function renderSection(section: OptionSection): string {
  const lines = section.lines
    .map(([left, right]) => `  ${cyan(left)}${' '.repeat(Math.max(0, OPTION_WIDTH - left.length))}   ${right}`)
    .join('\n')
  return `${heading(section.heading)}\n${lines}`
}

/** The trailer every command shares: the global flags, the alias and the environment. */
const SHARED_TRAILER = [
  renderSection(EVERYWHERE_SECTION),
  '',
  renderSection(ALIAS_SECTION),
  '',
  renderSection(ENVIRONMENT_SECTION),
  '',
].join('\n')

/** The full reference: every command, every option, the trailer. */
const USAGE = [
  dim(HEADER),
  '',
  heading('Usage'),
  renderCommandList(),
  '',
  renderSection(UP_SECTION),
  '',
  renderSection(SET_PASSWORD_SECTION),
  '',
  renderSection(SET_TOKEN_SECTION),
  '',
  renderSection(MIGRATE_SECTION),
  '',
  renderSection(INIT_SECTION),
  '',
  renderSection(UI_SWITCH_SECTION),
  '',
  renderSection(STATUS_SECTION),
  '',
  SHARED_TRAILER,
].join('\n')

// `restart` is `up` behind the scenes, so it reads `up`'s flags under its own heading.
const UP_COMMANDS = new Set(['up', 'restart'])

const SECTIONS: Record<string, OptionSection> = {
  'status': STATUS_SECTION,
  'set-password': SET_PASSWORD_SECTION,
  'set-token': SET_TOKEN_SECTION,
  'migrate': MIGRATE_SECTION,
  'init': INIT_SECTION,
  'ui-switch': UI_SWITCH_SECTION,
  'ui-update': UI_UPDATE_SECTION,
}

/**
 * `home-hosted <command> --help`: the usage line, that command's own options,
 * and the shared trailer. A command with no options says so instead of printing
 * an empty heading.
 */
export function commandHelp(command: string): string {
  const synopsis = SYNOPSIS[command]
  if (synopsis === undefined)
    return USAGE

  const section = UP_COMMANDS.has(command) ? UP_SECTION : SECTIONS[command]
  const options = section === undefined ? dim('no options') : renderSection(section)

  return [
    dim(HEADER),
    '',
    cyan(synopsis),
    '',
    options,
    '',
    SHARED_TRAILER,
  ].join('\n')
}

function manifestVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

function version(): void {
  process.stdout.write(`${manifestVersion()}\n`)
}

/**
 * citty owns dispatch and argument parsing. Each entry is a lazy import, so a
 * command's `#src` modules are only evaluated once `applyDirFlags()` has run.
 */
const COMMANDS = {
  'up': () => import('#src/cli/up').then(module => module.upCommand(CLI_ENTRY)),
  'down': () => import('#src/cli/down').then(module => module.downCommand),
  'restart': () => import('#src/cli/restart').then(module => module.restartCommand(CLI_ENTRY)),
  'status': () => import('#src/cli/status').then(module => module.statusCommand),
  'set-password': () => import('#src/cli/set-password').then(module => module.setPasswordCommand),
  'set-token': () => import('#src/cli/set-token').then(module => module.setTokenCommand),
  'migrate': () => import('#src/cli/migrate').then(module => module.migrateCommand),
  'init': () => import('#src/cli/init').then(module => module.initCommand),
  'ui-switch': () => import('#src/cli/ui-switch').then(module => module.uiSwitchCommand),
  'ui-update': () => import('#src/cli/ui-update').then(module => module.uiUpdateCommand),
  'ui-revert': () => import('#src/cli/ui-revert').then(module => module.uiRevertCommand),
} satisfies SubCommandsDef

const rootCommand = defineCommand({
  meta: {
    name: 'home-hosted',
    version: manifestVersion(),
    description: 'a control panel for the processes on your home server',
  },
  subCommands: COMMANDS,
})

const commandNames = Object.keys(COMMANDS)

async function main(): Promise<void> {
  const dirFlags = extractDirFlags(process.argv.slice(2))
  if (dirFlags.error !== undefined)
    fail(dirFlags.error)
  applyDirFlags(dirFlags)

  const invocation = resolveInvocation(dirFlags.rest, commandNames)

  if (invocation.kind === 'help') {
    process.stdout.write(invocation.command === undefined ? USAGE : commandHelp(invocation.command))
    return
  }
  if (invocation.kind === 'version') {
    version()
    return
  }
  if (invocation.kind === 'unknown') {
    process.stderr.write(`unknown command: ${invocation.command}\n\n${USAGE}`)
    process.exit(1)
  }

  // citty parses permissively, so the refusal of a mistyped flag is asked of
  // citty's own definitions first; a command that declares none (ui-switch) keeps
  // its own parseArgs, which is strict already.
  const sub = COMMANDS[invocation.argv[0]! as keyof typeof COMMANDS]
  const command = typeof sub === 'function' ? await sub() : sub
  const problem = rejectUnknownFlags(invocation.argv.slice(1), command?.args)
  if (problem !== null)
    fail(problem)

  // `runCommand`, not `runMain`: citty's `runMain` prints its own usage and
  // `console.error`s the message before `process.exit(1)`, so a wrapper can never
  // turn a failure back into `fail()`'s red `error <message>`. Letting the error
  // out keeps every failure on the one shape this CLI has always had.
  try {
    await runCommand(rootCommand, { rawArgs: invocation.argv })
  }
  catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
