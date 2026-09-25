import type { SubCommandsDef } from 'citty'
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineCommand, runCommand } from 'citty'
import { applyDirFlags, extractDirFlags, rejectUnknownFlags, resolveInvocation } from './cli/args'
import { fail } from './cli/io'

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

const USAGE = `home-hosted — a control panel for the processes on your home server

Usage
  home-hosted up [options]      start it in the background (detached)
  home-hosted down              stop it, and everything it supervises
  home-hosted restart [options] down, then up
  home-hosted status [--json]   is it running, where, and how to reach it
  home-hosted set-password      set the panel password without the API
  home-hosted set-token         set the API token that scripts and agents use
  home-hosted migrate           bring the config up to this release's schema
  home-hosted init              scaffold a project that keeps its state in the repo
  home-hosted ui-switch         install a UI from a release asset, a zip file or a URL
  home-hosted ui-revert         go back to the stock control panel UI

Options for up/restart
  -c, --config <file>   servers config (default: <state>/servers.config.json)
  -p, --port <port>     control panel port (default: 3999)
      --host <bind>     local | lan | an ipv4 address (default: local)
      --open            open the panel in a browser once it is up
      --no-autostart    do not start the entries marked autostart
      --foreground      run in this process instead of detaching (systemd/docker)
      --print-config    print the effective config and exit

Options for set-token
      --generate        create a strong token and print it once
      --clear           remove the token, so it stops working

Options for migrate
      --dry-run         print what would change, write nothing
  -y, --yes             apply without asking (or set HHOSTED_MIGRATE=allow)

Options for init
      --dir <dir>       where to scaffold (default: ./my-servers)
      --name <name>     package name (default: the directory name)
      --pm <manager>    pnpm | npm | yarn | bun (default: the first one installed)
      --no-install      write the files, install nothing
  -y, --yes             take every default, ask nothing

Options for ui-switch
      --repo <owner/name>   release repo (default: NamesMT/home-hosted)
      --tag <tag>           release tag (default: this release's tag, or latest for another repo)
      --asset <name>        asset to install (exact or unambiguous match)
      --file <path|url>     install a zip from a local path or an http(s) URL
      --list                list the usable assets and install nothing
      --token <token>       GitHub token (or GITHUB_TOKEN / GH_TOKEN)
  -y, --yes                 take the only asset instead of asking

Everywhere
      --home <dir>      state directory (default: $HHOSTED_HOME or ~/.home-hosted)
      --project <dir>   base for relative entry paths (default: the current directory)
  -h, --help            this text
  -v, --version         the version

Alias
  hh                    the same CLI, on a machine where home-hosted is installed

Environment
  HHOSTED_HOME          where config, secrets, logs, TLS and backups live
  HHOSTED_PROJECT       base for relative entry paths
  HHOSTED_PASSWORD      the password for a non-interactive set-password
  HHOSTED_TOKEN         the token for a non-interactive set-token
  GITHUB_TOKEN          a GitHub token for ui-switch (GH_TOKEN also works)
`

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
    process.stdout.write(USAGE)
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
