import type { LogStream, NannyExit, NannySpec, NannyState } from '#src/shared/contracts'
import process from 'node:process'
import { NANNY_HEARTBEAT_MS, nannyLogFile, writeNannyState } from '#src/providers/nanny'
import { spawnManaged, terminate } from '#src/providers/process'
import { LineSplitter } from '#src/services/log-buffer'
import { LogFiles } from '#src/services/log-files'

/**
 * The nanny of one persistent entry: it spawns the child, owns its pipes, writes its
 * output to the entry's JSONL log and mirrors the child's exit.
 *
 * This is the whole reason a persistent entry survives the panel. The pipes belong to
 * a process that is not the panel, so a panel stop, restart or SIGKILL cannot break
 * them; the log keeps being written; and the exit code the panel would have collected
 * as a parent is left in the state file for whoever comes back.
 *
 * It deliberately does *not* restart anything: retries, backoff and health stay the
 * panel's business, so there is only ever one supervisor making that decision.
 */
export async function runNanny(spec: NannySpec, statePath: string): Promise<void> {
  const id = spec.serverId
  const startedAt = Date.now()
  const logFile = nannyLogFile(spec.logDir, id)
  // The file is this entry's log *transport*, not its retention policy: the panel
  // still decides whether that history is served. So it is always written.
  const logFiles = new LogFiles(spec.logDir, () => ({ ...spec.logs, persist: true }))

  let childPid: number | null = null
  let lastExit: NannyExit | null = null
  let exitCode = 0

  const persistState = (): void => {
    const state: NannyState = {
      serverId: id,
      nannyPid: process.pid,
      childPid,
      startedAt,
      logFile,
      heartbeatAt: Date.now(),
    }
    if (lastExit !== null)
      state.lastExit = lastExit
    writeNannyState(statePath, state)
  }

  const emit = (stream: LogStream, text: string): void => {
    logFiles.append(id, { ts: Date.now(), stream, text })
  }

  // Not detached: the child shares this nanny's process group, which is the group the
  // panel signals — one `kill(-pid)` still reaches the whole tree.
  const child = spawnManaged(
    { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env },
    { detached: false },
  )
  childPid = child.pid ?? null
  persistState()
  emit('system', `persistent: nanny pid ${process.pid} runs this entry`)

  const stdout = new LineSplitter((stream, text) => emit(stream, text))
  const stderr = new LineSplitter((stream, text) => emit(stream, text))
  child.stdout?.on('data', chunk => stdout.push('stdout', chunk))
  child.stderr?.on('data', chunk => stderr.push('stderr', chunk))

  const heartbeat = setInterval(persistState, NANNY_HEARTBEAT_MS)
  heartbeat.unref()

  let stopping = false
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping)
      return
    stopping = true
    emit('system', `${signal} — stopping this entry (grace ${spec.stop.graceMs}ms)`)
    // The child is not a group leader, so the signal goes to its pid alone; the panel
    // still signals this group, which is what covers anything the child left behind.
    void terminate(child, { signal: spec.stop.signal, killGroup: false, graceMs: spec.stop.graceMs })
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null, runtimeMs: number, note?: string): void => {
      if (settled)
        return
      settled = true
      clearInterval(heartbeat)
      stdout.flush('stdout')
      stderr.flush('stderr')
      lastExit = { code, signal, at: Date.now(), runtimeMs }
      emit('system', note ?? (signal !== null ? `persistent: exited with signal ${signal}` : `persistent: exited with code ${code}`))
      persistState()
      logFiles.dispose()
      // The panel reads the real cause from the state file; this is only the mirror.
      exitCode = code ?? (signal === null ? 0 : 1)
      resolve()
    }

    child.once('exit', (code, signal) => finish(code, signal, Date.now() - startedAt))
    child.once('error', (error: Error) => {
      // A command that cannot even be spawned: the panel reports it as "did not start".
      finish(null, null, 0, `persistent: could not start the entry: ${error.message}`)
    })
  })

  // This nanny lives exactly as long as the child it owns, and says so by exiting.
  // Lingering is what an inherited pipe would do to us — a successor that kept our
  // stdout open refs the event loop — and a nanny that outlives its child is worse
  // than useless: the panel would report a healthy entry while the real server is a
  // detached process it can neither stop nor read. Exiting hands the entry back to
  // the panel, which is where `reclaim` can put it under a fresh nanny.
  process.exit(exitCode)
}
