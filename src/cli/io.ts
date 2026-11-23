import process from 'node:process'
import readline from 'node:readline'
import { shellQuote } from '#src/helpers/shell'

/**
 * The bits every command shares: the colours, the failure shape, and the one
 * place readline is set up. Imported by `src/cli.ts` and by the command modules
 * it loads lazily, so it may not read the state directories. Its only imports are
 * node builtins and `helpers/shell.ts`, which reads neither the filesystem nor
 * `helpers/paths.ts` — the two ways a `#src` import here would pull the state
 * graph in before citty is even asked anything.
 */

export const isTty = (): boolean => process.stdout.isTTY === true

export const paint = (code: string, text: string): string => (isTty() ? `\x1B[${code}m${text}\x1B[0m` : text)
export const dim = (text: string): string => paint('2', text)
export const bold = (text: string): string => paint('1', text)
export const cyan = (text: string): string => paint('36', text)
export const green = (text: string): string => paint('32', text)
/** A section title in the help output. */
export const heading = (text: string): string => paint('1;4', text)

/** The seam `ui-switch` takes, so the command stays testable without a terminal. */
export const style = { bold, dim, green }

/**
 * How this process was invoked, so a hint names a command the person can actually run.
 *
 * `npx home-hosted` leaves no `home-hosted` on `PATH`, so a hard-coded "run `home-hosted down`"
 * fails with `command not found`. A package-manager cache path means npx/dlx; `cli.ts` means a
 * source checkout. A string to print, not a parser. `HHOSTED_INVOCATION` overrides it.
 *
 * **The state directory travels with it.** A hint without the `--home` a command was given reaches the
 * default state instead, and running it verbatim creates `~/.home-hosted` beside the `.dev-state/` it
 * was asked about. So the flag is part of the invocation whenever a state directory was chosen, quoted
 * for the shell that will run it.
 *
 * `HHOSTED_INVOCATION` overrides the *program*, never the state: a wrapper that sets it still wants
 * its hints pointed at the home it is driving.
 */
export function invocation(): string {
  const program = invocationProgram()
  const home = process.env.HHOSTED_HOME?.trim()
  return home === undefined || home.length === 0 ? program : `${program} --home ${shellQuote(home)}`
}

/** The program alone — what a hint would say if every home were the default one. */
function invocationProgram(): string {
  const override = process.env.HHOSTED_INVOCATION?.trim()
  if (override !== undefined && override.length > 0)
    return override

  const entry = process.argv[1] ?? ''
  // A package-manager cache (`~/.npm/_npx/…`, `~/.local/share/pnpm/dlx/…`) means the package is
  // not installed, so the bare name would not resolve in the user's shell.
  if (/[\\/](?:_npx|dlx)[\\/]/.test(entry))
    return 'npx home-hosted'
  // A source checkout (`tsx src/cli.ts`, the repo's own scripts) has no installed bin either.
  if (/[\\/]cli\.ts$/.test(entry))
    return 'pnpm exec tsx src/cli.ts'

  return 'home-hosted'
}

/**
 * A reader that hangs up is a finished conversation, not a crash.
 *
 * Node's stdout is a socket: a closed reader raises `EPIPE` as an **error event**, and unhandled it
 * kills the process with an engine stack trace and exit 1 — so `set -o pipefail` turns
 * `status | head -1` into a failed deploy step. This exits 0 like Node's own CLI and Python do,
 * because the command *succeeded* and only the reader stopped listening. GNU tools die of SIGPIPE
 * (141), which `pipefail` also reports as a failure.
 *
 * **The code for "the reader is gone" differs per platform** — `EPIPE` on Linux, `ENOTCONN` from a
 * stdout socket on macOS, `ERR_STREAM_DESTROYED` or a bare `closed` elsewhere — so the test is "does
 * this error say the reader went away". Matching only `EPIPE` left macOS exiting 1 with an **empty
 * stderr**. A full disk or an EIO still ends the process. `ENOTCONN` means this here and nowhere
 * else: nothing in the CLI opens its own socket.
 *
 * Installed once at the entry so every command shares it; a per-command copy leaves the next command
 * broken, and every release adds more write sites.
 */
const READER_GONE = /^(?:EPIPE|ENOTCONN|ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END|ECONNRESET)$/

export function isClosedReaderError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && READER_GONE.test(code))
    return true
  // A write to a destroyed stream carries no code, only the message.
  const message = (error as Error | null)?.message ?? ''
  return /^(?:closed|write after end|premature close)$/i.test(message)
}

export function treatClosedReaderAsDone(): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (isClosedReaderError(error))
      process.exit(0)
    // Anything else is a real write failure, which used to end the process by default; keep that.
    throw error
  })
}

/** One shape for every failure: a red `error <message>` on stderr and exit 1. */
export function fail(message: string): never {
  process.stderr.write(`${paint('31', 'error')} ${message}\n`)
  process.exit(1)
}

/**
 * The same red `error <message>` line on stderr, for a refusal that still has something to do
 * afterwards — `logs --json` has already written its document, and `down` has a persistent sweep to
 * report. `fail()` cannot serve those because it exits.
 *
 * **Every refusal goes to stderr**, whether or not the command has more to say: a `--json` caller
 * parses stdout, so a refusal written there makes stdout not-a-document — a script sees prose where
 * it expected JSON. `logs` printed its unreadable-file refusal on stdout while the exit code said 1,
 * and `down` printed "could not stop pid N" there too. Both go through here now.
 */
export function refusal(message: string): void {
  process.stderr.write(`${paint('31', 'error')} ${message}\n`)
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A plain y/N question, for decisions that are not secrets. */
export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** Reads a line with echo suppressed, so the password never lands in scrollback. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const onData = (): void => {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(question)
    }

    process.stdin.on('data', onData)
    rl.question(question, (answer) => {
      process.stdin.off('data', onData)
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

/** Asks a yes/no question with a default, so an empty answer is a real answer. */
export async function confirm(question: string, fallback: boolean): Promise<boolean> {
  const answer = (await prompt(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  if (answer.length === 0)
    return fallback
  return answer === 'y' || answer === 'yes'
}

/**
 * The first-run password, as this machine can report it.
 *
 * `recorded` while it is in use and its text is in the 0600 secrets file; `unrecorded` when it is
 * still in use but the text is gone — a restore of `global:secrets` carries the hash and the flag,
 * not always the text — so nobody can read it back and the panel is one forgotten password away from
 * a lockout. `null` once a password of the person's own is set (or the file cannot be read).
 */
export type FirstRunPassword = { kind: 'recorded', password: string } | { kind: 'unrecorded' }

export async function firstRunPasswordState(file?: string): Promise<FirstRunPassword | null> {
  const { SecretsStore } = await import('#src/config/secrets')
  const path = file ?? (await import('#src/helpers/paths')).globalSecretsPath
  try {
    const store = new SecretsStore(path, undefined, 'global')
    if (!store.usingDefaultPassword)
      return null
    const password = store.initialPassword
    return password === null ? { kind: 'unrecorded' } : { kind: 'recorded', password }
  }
  catch {
    return null
  }
}

/** The line `up` and `status` print for an unrecorded first-run secret. */
export function unrecordedFirstRunHint(): string {
  return `the first-run secret is in use but no longer recorded — run \`${invocation()} account reset\``
}

/** The first-run password while it is still the one in use, read from this machine's secrets file. */
export async function firstRunPassword(): Promise<string | null> {
  const state = await firstRunPasswordState()
  return state?.kind === 'recorded' ? state.password : null
}
