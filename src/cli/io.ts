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
export const green = (text: string): string => paint('32', text)

/** The seam `ui-switch` takes, so the command stays testable without a terminal. */
export const style = { bold, dim, green }

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
