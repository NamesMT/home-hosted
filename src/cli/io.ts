import process from 'node:process'
import readline from 'node:readline'

/**
 * The bits every command shares: the colours, the failure shape, and the one
 * place readline is set up. Imported by `src/cli.ts` and by the command modules
 * it loads lazily, so it may not read the state directories — the only imports
 * here are node builtins.
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
 * How this process was invoked, for hints that tell a person what to type next.
 *
 * The documented quick start is `npx home-hosted`, which puts no `home-hosted` on the user's
 * `PATH` — so `stop it with \`home-hosted down\`` printed advice they could not follow
 * (`bash: home-hosted: command not found`). The bin's own argv names the shape: a global install
 * or a linked checkout runs `.../bin/home-hosted.mjs` (or the built `dist/cli.js`), while `npx`
 * and `pnpm dlx` hand over a cache path. `HHOSTED_INVOCATION` overrides it for a wrapper that
 * knows better.
 *
 * Deliberately a *string to print*, not a parser: every caller only concatenates it.
 */
export function invocation(): string {
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

/** One shape for every failure: a red `error <message>` on stderr and exit 1. */
export function fail(message: string): never {
  process.stderr.write(`${paint('31', 'error')} ${message}\n`)
  process.exit(1)
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
