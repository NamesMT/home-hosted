import type { ChildProcess } from 'node:child_process'
import type { EventHub } from '#src/services/events'
import type { Entry, ResolvedSpawn, SupervisorContext } from '#src/services/supervisor/entry'
import type { LogLine, NannySpec, NannyState } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { nannyArgv } from '#src/helpers/runtime'
import {
  clearNannySpec,
  clearNannyState,
  describeNannyExit,
  nannyEntryPoint,
  nannyIsAlive,
  nannyLogFile,
  nannySpecPath,
  nannyStatePath,
  readNannyState,
  writeNannySpec,
} from '#src/providers/nanny'
import { LogRelay } from '#src/services/log-relay'
import { resetHealth } from '#src/services/supervisor/health'

/** History a panel attaches with, so a persistent entry's live view is not blank. */
const PERSISTENT_BACKFILL_LINES = 200

/** Echoes are read within a poll or two of being written; a bounded set is plenty. */
const ECHOED_LINE_LIMIT = 100

/** One line's exact identity: a timestamp this panel minted, its stream and its text. */
function echoedKey(line: LogLine): string {
  return `${line.ts}\u0000${line.stream}\u0000${line.text}`
}

export function rememberEchoedLine(set: Set<string>, line: LogLine): void {
  set.add(echoedKey(line))
  while (set.size > ECHOED_LINE_LIMIT)
    set.delete(set.values().next().value as string)
}

/** True when this line is this panel's own echo, so it is only ever reported once. */
function forgetEchoedLine(set: Set<string>, line: LogLine): boolean {
  return set.delete(echoedKey(line))
}

export interface PersistentContext extends SupervisorContext {
  hub: EventHub
  entry: (id: string) => Entry | undefined
}

/**
 * The persistent-entry half of supervision: a nanny owns the child's pipes so it outlives the panel,
 * and the panel reads its output back from the log file and its exit from the nanny's state file.
 */
export class PersistentEntries {
  private readonly relay: LogRelay

  constructor(private readonly ctx: PersistentContext) {
    this.relay = new LogRelay({ onLines: (serverId, lines) => this.ingest(serverId, lines) })
  }

  /**
   * Spawns the nanny that runs this entry. The spec carries the already-expanded argv and env, so
   * `resolveSpawn()` stays the only resolver; it is 0600 and unlinked by the nanny as it reads it.
   */
  launch(entry: Entry, resolved: ResolvedSpawn): { child: ChildProcess, detail: string } | { error: string } {
    const { command, args, env, cwd, loggedArgs } = resolved
    const { options } = this.ctx

    this.ctx.log(entry, 'system', `start (persistent): ${command} ${loggedArgs.join(' ')}`)

    // The CLI this panel was launched through, under tsx, dist/cli.js and the published bin alike.
    const entryPoint = nannyEntryPoint()
    if (entryPoint.length === 0)
      return { error: 'cannot locate this CLI to start a persistent entry' }

    const id = entry.config.id
    const specPath = nannySpecPath(options.nannyDir, id)
    const statePath = nannyStatePath(options.nannyDir, id)
    const spec: NannySpec = {
      serverId: id,
      command,
      args,
      cwd,
      env,
      logDir: options.logFiles.directory,
      logs: options.logFiles.config,
      stop: entry.config.stop,
    }

    let child: ChildProcess
    try {
      writeNannySpec(specPath, spec)
      child = spawn(process.execPath, nannyArgv(entryPoint, id, specPath, statePath), {
        cwd,
        env: { ...process.env, ...env, HHOSTED_HOME: dataRoot, HHOSTED_PROJECT: projectDir },
        // The nanny reports through the entry's log file and holds no pipe of ours.
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      })
    }
    catch (error) {
      clearNannySpec(specPath)
      return { error: (error as Error).message }
    }

    // Outliving this panel is the point, so the loop must not be held open by it.
    child.unref()
    return { child, detail: `nanny → ${command} ${args.join(' ')}`.trim() }
  }

  /**
   * Follows the entry's log file. The backfill is read *through* the tailer, the only owner of the
   * offset. `attach` means "already running, and its history is new to this panel" — the buffer cannot
   * tell, because spawn, adopt and reattach all log a line first — and an empty buffer is still
   * required so a second attach cannot replay older lines.
   */
  follow(entry: Entry, attach = false): void {
    const id = entry.config.id
    const { logFiles } = this.ctx.options
    // `logs.persist: false` means that history is not served, and the backfill follows suit.
    const backfill = attach && entry.logs.size === 0 && logFiles.config.persist
      ? PERSISTENT_BACKFILL_LINES
      : 0

    const history = this.relay.follow(id, nannyLogFile(logFiles.directory, id), { backfill })
    if (history.length > 0)
      entry.logs.extend(history)
  }

  /** Whatever the relay had not read yet, ingested before its tailer goes. */
  drain(entry: Entry): void {
    const rest = this.relay.unfollow(entry.config.id)
    if (rest.length > 0)
      this.ingest(entry.config.id, rest)
  }

  /** Stops tailing a removed entry, discarding what was unread: nothing will serve it. */
  forget(id: string): void {
    this.relay.unfollow(id)
  }

  dispose(): void {
    this.relay.dispose()
  }

  readState(id: string): NannyState | null {
    return readNannyState(nannyStatePath(this.ctx.options.nannyDir, id))
  }

  /**
   * An explicit stop ends the entry for real: its records go, so nothing reattaches. A pid that
   * outlived the stop keeps them — they are the only way a later boot can find it.
   */
  finishStop(entry: Entry, survivor: number | null): void {
    const { nannyDir } = this.ctx.options
    if (survivor === null) {
      clearNannyState(nannyStatePath(nannyDir, entry.config.id))
      clearNannySpec(nannySpecPath(nannyDir, entry.config.id))
    }
    else {
      this.ctx.log(entry, 'system', `pid ${survivor} is still alive after the stop — its state file is kept`)
    }
    // The last chance to read what the nanny wrote on its way out.
    this.drain(entry)
  }

  /**
   * Reattaches to a nanny that is still running, or reports how it ended while nobody was watching.
   * Never starts anything — that is `start()`'s job.
   */
  async resume(entry: Entry, current: () => boolean = () => true): Promise<boolean> {
    const id = entry.config.id
    const { history } = this.ctx.options
    const state = this.readState(id)

    const alive = state !== null && state.serverId === id && await nannyIsAlive(state, id)
    // A start cancelled meanwhile: the stop that cancelled it does its own reattach.
    if (!current())
      return false
    if (alive) {
      entry.adopted = true
      entry.child = null
      entry.pid = state.nannyPid
      entry.startedAt = state.startedAt
      entry.status = 'running'
      resetHealth(entry)
      entry.portState = entry.config.port === null ? 'unknown' : 'in-use'
      entry.lastError = null
      entry.nannyExit = null
      const child = state.childPid === null ? '' : `, server pid ${state.childPid}`
      this.follow(entry, true)
      this.ctx.log(entry, 'system', `persistent: still running (nanny pid ${state.nannyPid}${child}) — reattached`)
      this.ctx.publishServer(entry)
      return true
    }

    if (state === null)
      return false

    // The nanny is gone; its state file is the only witness, read and consumed exactly once.
    this.consumeExit(entry)
    const exit = entry.nannyExit
    entry.nannyExit = null
    if (exit === null)
      return false

    const detail = exit.code === null && exit.signal === null ? 'it could not start' : describeNannyExit(exit)
    const ranFor = `${Math.max(1, Math.round(exit.runtimeMs / 1000))}s`
    history.record(id, { type: 'exit', detail: `while the panel was away: ${detail}`, runtimeMs: exit.runtimeMs })
    this.ctx.log(entry, 'system', `persistent: exited while the panel was away with ${detail} after ${ranFor}`)

    if (exit.code !== 0 || exit.signal !== null) {
      entry.status = 'crashed'
      entry.lastError = `exited while the panel was away with ${detail}`
      history.record(id, { type: 'crash', detail: entry.lastError, runtimeMs: exit.runtimeMs })
      this.ctx.notify(entry, 'crash', entry.lastError)
    }
    this.ctx.publishServer(entry)
    return false
  }

  /** The nanny's last word onto `entry.nannyExit`, then its state file goes so it is reported once. */
  consumeExit(entry: Entry): void {
    const statePath = nannyStatePath(this.ctx.options.nannyDir, entry.config.id)
    const state = readNannyState(statePath)
    if (state?.lastExit !== undefined)
      entry.nannyExit = state.lastExit
    clearNannyState(statePath)
    // A nanny writes its last lines and exits in one breath; a crash on start fits between two polls.
    this.drain(entry)
  }

  /** Lines read back from the log file, into the same buffer and SSE frame a piped entry uses. */
  private ingest(serverId: string, lines: LogLine[]): void {
    const entry = this.ctx.entry(serverId)
    if (entry === undefined || !entry.config.persistent || lines.length === 0)
      return

    // This panel's own lines live in that file too: an echo is not news.
    const kept = lines.filter(line => !forgetEchoedLine(entry.echoed, line))
    if (kept.length === 0)
      return

    for (const line of kept) entry.logs.push(line)
    // One frame per batch, so a burst of lines is not a burst of frames.
    this.ctx.hub.publish({ type: 'log', ts: kept[kept.length - 1]!.ts, workspaceId: this.ctx.options.workspaceId, serverId, lines: kept })
  }
}
