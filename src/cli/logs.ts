import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, paint } from '#src/cli/io'

/** `logs` answers "what has the panel been saying" — the file `up` redirects it into. */

export const logsArgs = {
  lines: { type: 'string', description: 'how many lines to show (default 50, `all` for everything)' },
  follow: { type: 'boolean', description: 'keep printing as the panel writes (like tail -f)' },
  json: { type: 'boolean', description: 'print machine-readable JSON' },
} as const

const DEFAULT_LINES = 50

/**
 * Whether a path exists but cannot be read — the case `readLog` cannot distinguish from absence,
 * because it folds every failure into "nothing there".
 *
 * A *missing* log is normal (a panel that has not started), so only a real permission or IO
 * refusal is reported. `R_OK` is the question being asked; existence alone would call an
 * unreadable file readable.
 */
function isUnreadable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK)
    return false
  }
  catch (error) {
    // Missing is not unreadable: that is the ordinary empty case.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * `all` or a negative count means the whole log; an unreadable count is a typo, not a reason to
 * fail, so it falls back to the default.
 *
 * What it does **not** do is accept a *partly* numeric argument, which is how
 * `Number.parseInt` behaves and why this is not just a `parseInt`. `--lines 1e3` meant 1 line
 * (not 1000), and `--lines 0x10` parsed as 0 — which is the "whole log" sentinel, so a bounded
 * request silently became an unbounded one. Neither is a typo falling back to a default; both are
 * a wrong answer the caller cannot see. The whole trimmed argument has to be a decimal integer.
 */
function parseLines(raw: string | undefined): number {
  if (raw === undefined)
    return DEFAULT_LINES
  const trimmed = raw.trim()
  if (trimmed.toLowerCase() === 'all')
    return 0
  if (!/^[+-]?\d+$/.test(trimmed))
    return DEFAULT_LINES
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed))
    return DEFAULT_LINES
  return parsed < 0 ? 0 : parsed
}

export async function runLogs(input: { lines?: string, follow?: boolean, json?: boolean }): Promise<void> {
  const { daemonLogPath } = await import('#src/helpers/paths')
  const { readLog } = await import('#src/helpers/daemon-log')
  const lines = parseLines(input.lines)

  if (input.follow === true) {
    const { followLog } = await import('#src/helpers/daemon-log')
    const count = lines === 0 ? DEFAULT_LINES : lines
    if (input.json !== true) {
      await followLog(daemonLogPath, count, chunk => process.stdout.write(chunk))
      return
    }
    // `--follow --json` used to ignore `--json` and print raw text, which the synopsis
    // (`logs [--lines <n>] [--follow] [--json]`) advertised as composable. A stream has no
    // single document, so the machine-readable form of it is one JSON object per line — each
    // carrying the same `path` the one-shot form reports, so a consumer needs no out-of-band
    // knowledge of which file it is reading.
    const emit = (line: string): void => {
      process.stdout.write(`${JSON.stringify({ path: daemonLogPath, line })}\n`)
    }
    // A chunk can end mid-line, so lines are only emitted once their newline has arrived.
    let pending = ''
    await followLog(daemonLogPath, count, (chunk) => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const part of parts) emit(part)
    })
    if (pending.length > 0)
      emit(pending)
    return
  }

  const output = readLog(daemonLogPath, lines)

  // Checked once, before either output form. `readLog` treats every read failure as "not there",
  // so an unreadable log and a missing one look identical to it — and both surfaces would then
  // claim the panel has written nothing when it may have written plenty. A panel run as another
  // user (systemd, root) is the realistic case. Doing this above the `--json` branch is what keeps
  // the two forms from disagreeing: `--json` used to answer `{ lines: [] }` while the text form
  // reported the permission problem, because the check sat below it.
  if (output.length === 0 && isUnreadable(daemonLogPath)) {
    if (input.json === true) {
      process.stdout.write(`${JSON.stringify({ path: daemonLogPath, error: 'unreadable' }, null, 2)}\n`)
    }
    else {
      process.stdout.write(`${paint('31', 'error')} cannot read ${daemonLogPath} — check its permissions\n`)
    }
    process.exitCode = 1
    return
  }

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
  // No `description`: the one copy is `SUMMARIES` in `cli.ts`. See `server.ts` for why a module copy
  // here is unreachable.
  meta: { name: 'logs' },
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
