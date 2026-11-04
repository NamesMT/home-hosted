import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, refusal } from '#src/cli/io'
import { errorMessage } from '#src/shared/error-message'

/** `logs` answers "what has the panel been saying" — the file `up` redirects it into. */

export const logsArgs = {
  id: { type: 'positional', required: false, description: 'show one server\'s own log instead of the panel console' },
  lines: { type: 'string', description: 'how many lines to show (default 50, `all` for everything)' },
  follow: { type: 'boolean', description: 'keep printing as the panel writes (like tail -f)' },
  json: { type: 'boolean', description: 'print machine-readable JSON' },
  workspace: { type: 'string', alias: 'w', description: 'the workspace the server is in (default: the panel\'s default workspace)' },
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

export interface LogTarget {
  /** The file the lines come from, for the header and for `--json`'s `path`. */
  file: string
  lines: number
}

/**
 * Resolves which log a `logs` call is about: the panel's own console, or one server's.
 *
 * A server's log is JSONL on disk (`<id>.log`, plus `.log.N` rotations) and is readable with no
 * session, no token and no answering panel — the same property that makes `panel.console` a
 * first-class diagnostic. The workspace is explicit because a server id is only unique inside one.
 *
 * An omitted `--workspace` resolves through `defaultWorkspaceId` — the same rule the panel uses for
 * an omitted `?workspace` — because reading `DEFAULT_WORKSPACE_ID` literally here made `logs`
 * disagree with `start`/`stop` on a host that does not declare a `default` workspace.
 */
async function resolveTarget(input: { id?: string, lines: number, workspace?: string }): Promise<LogTarget> {
  const { daemonLogPath, workspaceLogsDir, workspacesPath } = await import('#src/helpers/paths')
  if (input.id === undefined || input.id.length === 0)
    return { file: daemonLogPath, lines: input.lines }

  const id = input.id.trim()
  const explicit = input.workspace !== undefined && input.workspace.length > 0
  // `readDefaultWorkspaceId`, not `DEFAULT_WORKSPACE_ID`: "which one is the default" is the panel's
  // own rule (`default` if declared, else the first listed), and reading the literal id here made
  // `logs` name a workspace that `start`/`stop` would not act in. Read only when it is needed.
  if (!explicit)
    return { file: await serverLogFile(workspacesPath, id), lines: input.lines }
  // Refused rather than guessed: an id is only unique inside a workspace, and reading the default
  // one for a server that lives elsewhere would print another server's output under this name.
  return { file: path.join(workspaceLogsDir(input.workspace!.trim()), `${id}.log`), lines: input.lines }
}

/** The file one server's log is in, inside the workspace this host treats as the default. */
async function serverLogFile(registryFile: string, id: string): Promise<string> {
  const { workspaceLogsDir } = await import('#src/helpers/paths')
  const { readDefaultWorkspaceId } = await import('#src/config/workspaces')
  return path.join(workspaceLogsDir(readDefaultWorkspaceId(registryFile)), `${id}.log`)
}

export async function runLogs(input: { id?: string, lines?: string, follow?: boolean, json?: boolean, workspace?: string }): Promise<void> {
  const { readLog } = await import('#src/helpers/daemon-log')
  const lines = parseLines(input.lines)
  const { file: logPath } = await resolveTarget({ id: input.id, lines, workspace: input.workspace })
  // A server's log is JSONL, the panel console is text. `--json` must still hand back the **stored**
  // record, so only the human form is rendered.
  const isServerLog = input.id !== undefined && input.id.length > 0

  if (input.follow === true) {
    const { followLog } = await import('#src/helpers/daemon-log')
    // `lines` goes through unchanged: `readLog` already reads `0` as "the whole log", which is what
    // `--lines all` (and a negative, the same sentinel) parsed to. This used to rewrite 0 to
    // `DEFAULT_LINES`, so `logs --lines all --follow` printed 50 lines of a 200-line log while the
    // help and synopsis advertise `[--lines <n>] [--follow]` as composable — the worst failure
    // for a diagnostic command, since the answer looked complete. Same class as `--follow --json`
    // ignoring `--json`, which the branch below already fixed.
    if (input.json !== true) {
      // A server's log is JSONL, so the human form renders each line; a chunk can end mid-line, so
      // only complete lines are rendered and the tail is carried to the next chunk.
      if (!isServerLog) {
        await followLog(logPath, lines, chunk => process.stdout.write(chunk))
        return
      }
      let partial = ''
      const emitLine = (raw: string): void => {
        process.stdout.write(`${renderLine(raw, true)}\n`)
      }
      await followLog(logPath, lines, (chunk) => {
        partial += chunk
        const parts = partial.split('\n')
        partial = parts.pop() ?? ''
        for (const part of parts) {
          if (part.length > 0)
            emitLine(part)
        }
      })
      if (partial.length > 0)
        emitLine(partial)
      return
    }
    // `--follow --json` used to ignore `--json` and print raw text, which the synopsis
    // (`logs [--lines <n>] [--follow] [--json]`) advertised as composable. A stream has no
    // single document, so the machine-readable form of it is one JSON object per line — each
    // carrying the same `path` the one-shot form reports, so a consumer needs no out-of-band
    // knowledge of which file it is reading.
    const emit = (line: string): void => {
      process.stdout.write(`${JSON.stringify({ path: logPath, line })}\n`)
    }
    // A chunk can end mid-line, so lines are only emitted once their newline has arrived.
    let pending = ''
    await followLog(logPath, lines, (chunk) => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const part of parts) emit(part)
    })
    if (pending.length > 0)
      emit(pending)
    return
  }

  const output = readLog(logPath, lines)

  // Checked once, before either output form. `readLog` treats every read failure as "not there",
  // so an unreadable log and a missing one look identical to it — and both surfaces would then
  // claim the panel has written nothing when it may have written plenty. A panel run as another
  // user (systemd, root) is the realistic case. Doing this above the `--json` branch is what keeps
  // the two forms from disagreeing: `--json` used to answer `{ lines: [] }` while the text form
  // reported the permission problem, because the check sat below it.
  if (output.length === 0 && isUnreadable(logPath)) {
    if (input.json === true) {
      process.stdout.write(`${JSON.stringify({ path: logPath, error: 'unreadable' }, null, 2)}\n`)
    }
    else {
      // The refusal goes to **stderr**: stdout is the answer, and a script reading a diagnostic
      // command's output must not have to tell a permission problem from a line of the log. The
      // `--json` branch above keeps its document on stdout because that *is* the answer — `error`
      // is the key a JSON consumer reads there.
      refusal(`cannot read ${logPath} — check its permissions`)
    }
    process.exitCode = 1
    return
  }

  if (input.json === true) {
    process.stdout.write(`${JSON.stringify({ path: logPath, lines: output }, null, 2)}\n`)
    return
  }

  if (output.length === 0) {
    // Not an error: a panel that has just started, or never started, has nothing to say.
    process.stdout.write(`${dim(`no output yet — ${logPath}`)}\n`)
    return
  }

  process.stdout.write(`${bold(logPath)}\n`)
  for (const line of output)
    process.stdout.write(`${renderLine(line, isServerLog)}\n`)
}

/**
 * One stored server line as text.
 *
 * A server's log is JSONL (`{ ts, stream, text }`), so the raw bytes would show a person a JSON
 * object per line where the panel shows them a log. A line that does not parse is not dropped: a
 * truncated write still says something, and hiding it is worse than showing it raw.
 */
function renderLine(raw: string, server: boolean): string {
  if (!server)
    return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { text?: unknown }).text === 'string')
      return (parsed as { text: string }).text
  }
  catch {
    // Fall through: an unparseable line is shown as it was written.
  }
  return raw
}

export const logsCommand = defineCommand({
  // No `description`: the one copy is `SUMMARIES` in `cli.ts`. See `server.ts` for why a module copy
  // here is unreachable.
  meta: { name: 'logs' },
  args: logsArgs,
  async run({ args }) {
    try {
      await runLogs({ id: args.id, lines: args.lines, follow: args.follow, json: args.json, workspace: args.workspace })
    }
    catch (error) {
      fail(errorMessage(error))
    }
  },
})
