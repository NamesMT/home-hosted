import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail } from '#src/cli/io'

/** `logs` answers "what has the panel been saying" — the file `up` redirects it into. */

export const logsArgs = {
  lines: { type: 'string', description: 'how many lines to show (default 50, `all` for everything)' },
  follow: { type: 'boolean', description: 'keep printing as the panel writes (like tail -f)' },
  json: { type: 'boolean', description: 'print machine-readable JSON' },
} as const

const DEFAULT_LINES = 50

/** `all` or a negative count means the whole log; a bad number is not worth a hard failure. */
function parseLines(raw: string | undefined): number {
  if (raw === undefined)
    return DEFAULT_LINES
  if (raw.trim().toLowerCase() === 'all')
    return 0
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed))
    return DEFAULT_LINES
  return parsed < 0 ? 0 : parsed
}

export async function runLogs(input: { lines?: string, follow?: boolean, json?: boolean }): Promise<void> {
  const { daemonLogPath } = await import('#src/helpers/paths')
  const { readLog } = await import('#src/helpers/daemon-log')
  const lines = parseLines(input.lines)

  if (input.follow === true) {
    const { followLog } = await import('#src/helpers/daemon-log')
    await followLog(daemonLogPath, lines === 0 ? DEFAULT_LINES : lines, chunk => process.stdout.write(chunk))
    return
  }

  const output = readLog(daemonLogPath, lines)

  if (input.json === true) {
    process.stdout.write(`${JSON.stringify({ path: daemonLogPath, lines: output }, null, 2)}\n`)
    return
  }

  if (output.length === 0) {
    // Not an error: a panel that has just started, or never started, has nothing to say.
    process.stdout.write(`${dim(`no output yet — ${daemonLogPath}`)}\n`)
    return
  }

  process.stdout.write(`${bold(daemonLogPath)}\n`)
  for (const line of output)
    process.stdout.write(`${line}\n`)
}

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
    description: 'show the panel\'s own console output',
  },
  args: logsArgs,
  async run({ args }) {
    try {
      await runLogs({ lines: args.lines, follow: args.follow, json: args.json })
    }
    catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  },
})
