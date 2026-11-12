import type { SubCommandsDef } from 'citty'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineCommand, runCommand } from 'citty'
import { errorMessage } from '#src/shared/error-message'
import { applyDirFlags, extractDirFlags, rejectUnknownFlags, resolveInvocation } from './cli/args'
import { cyan, dim, fail, heading, treatClosedReaderAsDone } from './cli/io'
import { nearestWord } from './cli/nearest'
import { NANNY_COMMAND } from './helpers/runtime'
import { appVersion } from './helpers/version'

/**
 * The command line, and nothing else. Two things happen before citty is asked
 * anything: `--home`/`--project` are peeled off and applied (because
 * `#src/helpers/paths.ts` resolves at import time), and the curated surface —
 * `help`, `version`, `unknown command`, and the `-p 4000` shorthand for `up` —
 * is decided. The command modules are then resolved lazily by citty, so their
 * own `#src` imports are safe: by the time one is imported, the directories are
 * already in the environment.
 *
 * The only static imports here are node builtins, citty, and the path-free local
 * modules the pre-pass needs (`helpers/runtime.ts` only names the hidden nanny
 * command); every command (and so every state-reading module) is a dynamic import
 * behind `subCommands`.
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
  'down': 'home-hosted down [--with-persistent]',
  'restart': 'home-hosted restart [<id>] [options]',
  'status': 'home-hosted status [--json]',
  'logs': 'home-hosted logs [<id>] [--lines <n>] [--follow] [--json] [--workspace <id>]',
  'usage': 'home-hosted usage [--json]',
  'backup': 'home-hosted backup [list|create|restore] [options]',
  'start': 'home-hosted start <id> [--workspace <id>] [--free-port]',
  'stop': 'home-hosted stop <id> [--workspace <id>]',
  'free-port': 'home-hosted free-port <id> [--workspace <id>]',
  'set-password': 'home-hosted set-password [--clear]',
  'set-token': 'home-hosted set-token [--generate|--clear]',
  'setup-temp': 'home-hosted setup-temp [--wsl] [--download|--no-download] [--clear]',
  'migrate': 'home-hosted migrate [--dry-run] [--yes]',
  'init': 'home-hosted init [options]',
  'ui-switch': 'home-hosted ui-switch [options]',
  'ui-update': 'home-hosted ui-update [options]',
  'ui-revert': 'home-hosted ui-revert',
  'service': 'home-hosted service [install|uninstall|status] [--user|--system] [--print]',
}

const SUMMARIES: Record<string, string> = {
  'up': 'start it in the background (detached)',
  'down': 'stop it, and everything it supervises',
  'restart': 'down then up — or one server, given an id',
  'status': 'is it running, where, and how to reach it',
  'logs': 'show the panel\'s console, or one server\'s own log with an id',
  'usage': 'live CPU and memory per server, loudest first',
  'backup': 'list, create or restore a backup archive',
  'start': 'start one server, leaving the panel up',
  'stop': 'stop one server, leaving the panel up',
  'free-port': 'free the port a server needs, so it can start',
  'set-password': 'set the panel password without the API',
  'set-token': 'set the API token that scripts and agents use',
  'setup-temp': 'teach the panel how to read this machine\'s CPU temperature',
  'migrate': 'bring the config up to this release\'s schema',
  'init': 'scaffold a project that keeps its state in the repo',
  'ui-switch': 'install a UI from a release asset, a zip file or a URL',
  'ui-update': 'bring the installed UI up to date, or pick a release',
  'ui-revert': 'go back to the stock control panel UI',
  'service': 'start the panel at boot with systemd, launchd or Task Scheduler',
}

/** One option line, as the left column and the description that follows it. */
type OptionLine = [left: string, right: string]

/** A heading and the option lines under it. */
interface OptionSection {
  heading: string
  lines: OptionLine[]
}

/** Every section lays its left column out at this width, so the two views align. */
const OPTION_WIDTH = 21

const UP_SECTION: OptionSection = {
  heading: 'Options for up',
  lines: [
    // Both are saved to settings.json, so the next plain `up` binds the same way.
    ['-p, --port <port>', 'control panel port (default: 3999); saved to settings.json'],
    ['--host <bind>', 'local | lan | an ipv4 address (default: local); saved to settings.json'],
    ['--open', 'open the panel in a browser once it is up'],
    ['--no-autostart', 'do not start the entries marked autostart'],
    ['--foreground', 'run in this process instead of detaching (systemd/docker)'],
    ['--print-config', 'print the effective config and exit — starts nothing, sets no password'],
  ],
}

const STATUS_SECTION: OptionSection = {
  heading: 'Options for status',
  lines: [
    ['--json', 'print machine-readable JSON'],
  ],
}

const LOGS_SECTION: OptionSection = {
  heading: 'Options for logs',
  lines: [
    ['<id>', 'one server\'s own log instead of the panel console (optional)'],
    ['--lines <n>', 'how many lines to show: 1 or more (default 50), or `all`'],
    ['--follow', 'keep printing as the panel writes (like tail -f)'],
    ['--json', 'print machine-readable JSON (one object per line with --follow)'],
    ['-w, --workspace <id>', 'the workspace the server is in (default: the panel\'s default)'],
  ],
}

const USAGE_SECTION: OptionSection = {
  heading: 'Options for usage',
  lines: [
    ['--json', 'print machine-readable JSON'],
  ],
}

const BACKUP_SECTION: OptionSection = {
  heading: 'Arguments for backup',
  lines: [
    ['list | create | restore', 'what to do (default: list)'],
    ['<name>', 'the archive, for restore — `backup list` shows them'],
    ['--from <path>', 'restore from an archive file anywhere on this machine, instead of a name'],
    ['--include <ids>', 'comma-separated item ids to act on (required for create/restore)'],
    ['--all', 'act on everything; one of --include or --all is required'],
    ['--exclude <ids>', 'leave these out; --all --exclude global:secrets keeps the password and token out of the archive'],
    ['--password <text>', 'encrypt a new archive, or unlock one on restore'],
    ['--confirm', 'apply without asking (create and restore plan first)'],
    ['--json', 'print the plan or the result as JSON'],
  ],
}

const SERVER_SECTION: OptionSection = {
  heading: 'Arguments for stop/free-port',
  lines: [
    ['<id>', 'the server id from servers.config.json'],
    ['-w, --workspace <id>', 'the workspace to act in (default: the default workspace)'],
  ],
}

// Only `start` takes the flag: freeing a port before stopping a server means nothing.
const START_SECTION: OptionSection = {
  heading: 'Arguments for start',
  lines: [
    ['<id>', 'the server id from servers.config.json'],
    ['-w, --workspace <id>', 'the workspace to act in (default: the default workspace)'],
    ['--free-port', 'free the port first, then start — the panel\'s Free port button'],
  ],
}

// `restart <id>` acts on one entry; bare `restart` acts on the panel, so the id is optional
// and reads under `up`'s heading alongside its flags.
// `down` had no options at all until `--with-persistent`, so its section is new rather than
// an addition to someone else's: the flag exists on both commands and must read the same.
const PERSISTENT_LINE: OptionLine = ['--with-persistent', 'stop the persistent entries too (default: leave them running)']

const DOWN_SECTION: OptionSection = {
  heading: 'Options for down',
  lines: [PERSISTENT_LINE],
}

const RESTART_SECTION: OptionSection = {
  heading: 'Options for restart (and every option of up)',
  lines: [
    // Its own section, not `UP_SECTION`: `restart` takes an id and `up` does not, and
    // advertising one there would document a flag `up` rejects.
    ['<id>', 'restart just this server, leaving the panel up (optional)'],
    ['-w, --workspace <id>', 'the workspace to act in, with an id'],
    PERSISTENT_LINE,
  ],
}

const SET_PASSWORD_SECTION: OptionSection = {
  heading: 'Options for set-password',
  lines: [
    ['--clear', 'remove the password: nobody can sign in until a new one is set'],
  ],
}

const SET_TOKEN_SECTION: OptionSection = {
  heading: 'Options for set-token',
  lines: [
    ['--generate', 'create a strong token and print it once'],
    ['--clear', 'remove the token, so it stops working'],
  ],
}

const SETUP_TEMP_SECTION: OptionSection = {
  heading: 'Options for setup-temp',
  lines: [
    ['--wsl', 'read the temperature through the Windows host (WSL2)'],
    ['--download', 'with --wsl: fetch LibreHardwareMonitor without asking (for a script)'],
    ['--no-download', 'with --wsl: never fetch it; report what is missing'],
    ['--clear', 'stop using the command and delete the helper'],
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

const SERVICE_SECTION: OptionSection = {
  heading: 'Options for service',
  lines: [
    ['install | uninstall | status', 'what to do (default: status)'],
    ['--user', 'a service for this account (default); on Linux, see loginctl enable-linger'],
    ['--system', 'a machine-wide service started at boot (needs sudo / an administrator)'],
    ['--print', 'with install: print the unit to stdout and install nothing'],
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
    ['HHOSTED_MIGRATE', '`allow` lets migrate apply without asking, for an unattended run'],
    ['HHOSTED_DDNS_SECRET', 'the key DDNS credentials are sealed with'],
    ['GITHUB_TOKEN', 'a GitHub token for ui-switch and ui-update (GH_TOKEN also works)'],
  ],
}

/**
 * The command name a typo most likely meant, or null when nothing is close. The candidates are
 * `SYNOPSIS`, the same source the reference renders, so a suggestion cannot name a command the CLI
 * does not have.
 */
export function suggestCommand(input: string): string | null {
  return nearestWord(input, Object.keys(SYNOPSIS))
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

/** Each command's own options; a command missing here takes none. */
const SECTIONS: Record<string, OptionSection> = {
  'up': UP_SECTION,
  'down': DOWN_SECTION,
  'status': STATUS_SECTION,
  'logs': LOGS_SECTION,
  'usage': USAGE_SECTION,
  'backup': BACKUP_SECTION,
  'restart': RESTART_SECTION,
  'start': START_SECTION,
  'stop': SERVER_SECTION,
  'free-port': SERVER_SECTION,
  'set-password': SET_PASSWORD_SECTION,
  'set-token': SET_TOKEN_SECTION,
  'setup-temp': SETUP_TEMP_SECTION,
  'migrate': MIGRATE_SECTION,
  'init': INIT_SECTION,
  'ui-switch': UI_SWITCH_SECTION,
  'ui-update': UI_UPDATE_SECTION,
  'service': SERVICE_SECTION,
}

/**
 * The full reference: every command, then every command's options in the same order, then the
 * trailer. Built from `SECTIONS`, the same map `<command> --help` reads, so a command cannot be
 * listed without its options (logs, usage, backup, setup-temp and ui-update once were).
 */
const USAGE = [
  dim(HEADER),
  '',
  heading('Usage'),
  renderCommandList(),
  '',
  ...[...new Set(Object.keys(SYNOPSIS).map(name => SECTIONS[name]).filter(section => section !== undefined))]
    .flatMap(section => [renderSection(section), '']),
  SHARED_TRAILER,
].join('\n')

/**
 * `home-hosted <command> --help`: the usage line, that command's own options,
 * and the shared trailer. A command with no options says so instead of printing
 * an empty heading.
 */
export function commandHelp(command: string): string {
  const synopsis = SYNOPSIS[command]
  if (synopsis === undefined)
    return USAGE

  const section = SECTIONS[command]
  // `restart` is `up` behind the scenes, so it lists up's options after its own.
  const options = section === undefined
    ? dim('no options')
    : [renderSection(section), ...(command === 'restart' ? ['', renderSection(UP_SECTION)] : [])].join('\n')

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

function version(): void {
  process.stdout.write(`${appVersion()}\n`)
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
  'logs': () => import('#src/cli/logs').then(module => module.logsCommand),
  'usage': () => import('#src/cli/usage').then(module => module.usageCommand),
  'start': () => import('#src/cli/server').then(module => module.startCommand),
  'stop': () => import('#src/cli/server').then(module => module.stopCommand),
  'free-port': () => import('#src/cli/server').then(module => module.freePortCommand),
  'set-password': () => import('#src/cli/set-password').then(module => module.setPasswordCommand),
  'set-token': () => import('#src/cli/set-token').then(module => module.setTokenCommand),
  'setup-temp': () => import('#src/cli/setup-temp').then(module => module.setupTempCommand),
  'migrate': () => import('#src/cli/migrate').then(module => module.migrateCommand),
  'init': () => import('#src/cli/init').then(module => module.initCommand),
  'ui-switch': () => import('#src/cli/ui-switch').then(module => module.uiSwitchCommand),
  'ui-update': () => import('#src/cli/ui-update').then(module => module.uiUpdateCommand),
  'ui-revert': () => import('#src/cli/ui-revert').then(module => module.uiRevertCommand),
  'backup': () => import('#src/cli/backup').then(module => module.backupCommand),
  'service': () => import('#src/cli/service').then(module => module.serviceCommand(CLI_ENTRY)),
} satisfies SubCommandsDef

const rootCommand = defineCommand({
  meta: {
    name: 'home-hosted',
    version: appVersion(),
    description: 'a control panel for the processes on your home server',
  },
  subCommands: COMMANDS,
})

const commandNames = Object.keys(COMMANDS)

async function main(): Promise<void> {
  // Before the first byte is written: a reader that hangs up (`| head -1`, `grep -q`) closes the pipe,
  // and an unhandled EPIPE would print an engine stack trace and exit 1. One install, every command.
  treatClosedReaderAsDone()

  const dirFlags = extractDirFlags(process.argv.slice(2))
  if (dirFlags.error !== undefined)
    fail(dirFlags.error)
  applyDirFlags(dirFlags)

  // The persistent-entry nanny is spawned by the panel, never typed by a person, so
  // it is dispatched before the curated surface and stays out of it: no synopsis, no
  // unknown-command interplay, and citty owns its own `--help`.
  if (dirFlags.rest[0] === NANNY_COMMAND) {
    const { nannyCommand } = await import('#src/cli/nanny')
    try {
      await runCommand(nannyCommand, { rawArgs: dirFlags.rest })
    }
    catch (error) {
      fail(errorMessage(error))
    }
    return
  }

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
    const suggestion = suggestCommand(invocation.command)
    process.stderr.write(`unknown command: ${invocation.command}\n`)
    if (suggestion !== null)
      process.stderr.write(`${dim(`did you mean \`${suggestion}\`?`)}\n`)
    process.stderr.write(`\n${USAGE}`)
    process.exit(1)
  }

  // A state directory this release cannot use is refused before any command
  // resolves a path into it. It throws one sentence naming the fix, which is the
  // same shape as every other CLI failure below.
  const { ensureLayout } = await import('#src/config/layout')
  ensureLayout()

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
    fail(errorMessage(error))
  }
}

void main().catch((error: unknown) => {
  fail(errorMessage(error))
})
