import type { PersistentHandle } from '#src/providers/nanny-sweep'
import type { StopConfig } from '#src/shared/contracts'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { defineCommand } from 'citty'
import { delay, dim, green, paint } from '#src/cli/io'
import { versionMismatchNote } from '#src/helpers/version'

/**
 * `down` stops the panel and everything it supervises.
 *
 * A `persistent: true` entry is the one thing it deliberately leaves running, which is what
 * `--with-persistent` changes: the same stop, extended to those entries. While the panel is
 * up they are stopped through it, so the stop is recorded like a click in the UI; once it is
 * gone their nannies are signalled directly, because the state files are then the only record.
 */

export interface DownOptions {
  /** Also stop every persistent entry, in every workspace. */
  withPersistent?: boolean
}

/** Which persistent entries this stop ended, as `(workspace, id)` — what `restart` starts back. */
export interface DownResult {
  stoppedPersistent: Array<{ workspaceId: string, serverId: string }>
}

export async function runDown(options: DownOptions = {}): Promise<DownResult> {
  const { clearRuntime, isLiveLiveness, readRuntime, requestShutdown, runtimeLiveness } = await import('#src/helpers/daemon')

  const result: DownResult = { stoppedPersistent: [] }
  // What was running before this command did anything. The panel ends the entries itself when
  // asked, so afterwards they are simply gone — and the difference between "was running" and
  // "still running" is the only account of what was stopped. `restart` starts exactly that list.
  const before = options.withPersistent === true ? await livePersistents() : []
  // Filled by whichever path got here, so one place decides what was stopped and what survived.
  const finish = async (): Promise<DownResult> => {
    result.stoppedPersistent.push(...await reportPersistent(options, before))
    return result
  }

  const runtime = readRuntime()
  if (runtime === null) {
    process.stdout.write('home-hosted is not running\n')
    // The panel's absence is exactly when a persistent entry is easiest to forget: it outlives
    // the panel by design, so "nothing is running" must not be said by omission here.
    return finish()
  }

  const liveness = await runtimeLiveness(runtime)
  // Nothing at all is behind the pid, so the record is simply stale: delete it, and do not touch the
  // network — a port this record names may now belong to an unrelated service.
  if (liveness === 'gone') {
    clearRuntime()
    process.stdout.write(`home-hosted is not running (removed a stale run.json from home-hosted ${runtime.version})\n`)
    return finish()
  }

  /** What was stopped, and whether this CLI is a different release than it was. */
  const reportStopped = (forced: boolean): void => {
    process.stdout.write(`${green('stopped')}${forced ? ' (forced)' : ''} ${dim(`— was home-hosted ${runtime.version}`)}\n`)
    const note = versionMismatchNote(runtime.version)
    if (note !== null)
      process.stdout.write(`${dim(note)}\n`)
  }

  let answered = false
  if (isLiveLiveness(liveness)) {
    process.stdout.write(`stopping pid ${runtime.pid}…\n`)
    // The panel's own endpoint stops supervised servers cleanly on every platform; a signal is the
    // fallback for a wedged or unreachable process. Only a pid whose identity is confirmed is ever
    // signalled, and this branch is the only one that signals at all.
    // The panel ends the persistent entries itself when asked: it is the only one that can
    // record the stop (log line, history, health) and consume the state file in order.
    answered = await requestShutdown(runtime, 4000, { withPersistent: options.withPersistent === true })
    if (!answered)
      signal(runtime.pid, 'SIGTERM')
  }
  else {
    /**
     * The pid is alive but was born **after** this record was written, so it is some other process
     * that inherited the number — and it must never be signalled.
     *
     * The graceful stop is still offered, because it authenticates itself: `/_hh/shutdown` answers
     * only to the token in this `run.json`, which only the panel that wrote it knows. A reply is
     * therefore proof the panel *is* ours, which keeps it stoppable in the one case the birth time
     * can be wrong about — a forward wall-clock step, where the kernel's `btime` moves and a live
     * panel looks recycled. Either way this returns: `runtime.pid` is not the answering process, so
     * it is not signalled and the record is left for that panel to overwrite.
     */
    const answeredByPanel = await requestShutdown(runtime, 4000, { withPersistent: options.withPersistent === true })
    if (!answeredByPanel) {
      process.stdout.write(`home-hosted is not running (the pid in run.json, ${runtime.pid}, belongs to another process — it was not signalled)\n`)
      return finish()
    }
    process.stdout.write(`stopped the panel on ${runtime.url} (its pid in run.json, ${runtime.pid}, was another process and was left alone)\n`)
    clearRuntime()
    return finish()
  }

  if (await waitForExit(runtime.pid, 20000)) {
    clearRuntime()
    reportStopped(false)
    return finish()
  }

  process.stdout.write(`${dim('it did not stop in time — forcing')}\n`)
  forceStop(runtime.pid)
  await waitForExit(runtime.pid, 5000)
  clearRuntime()
  reportStopped(true)
  return finish()
}

/**
 * The persistent entries this host has running, as their state files describe them.
 *
 * Every workspace keeps its own `.state`, and only the panel normally sees all of them, so
 * `down` reads them itself — after a crash there is nobody left to ask.
 */
export async function livePersistents(): Promise<PersistentHandle[]> {
  const { livePersistentEntries } = await import('#src/providers/nanny-sweep')
  const { hhDir } = await import('#src/helpers/paths')
  return livePersistentEntries(hhDir)
}

/** `workspace/id`, because a server id is only unique inside its workspace. */
export function persistentLabel(handle: Readonly<PersistentHandle>): string {
  return `${handle.workspaceId}/${handle.serverId}`
}

/**
 * Stops what is left of the snapshot: with the panel gone each nanny is signalled directly, and
 * its state file consumed once it is really gone. Returns which were ended here and which
 * survived, so the caller can account for the rest as the panel's work.
 */
async function stopPersistents(before: PersistentHandle[]): Promise<{ done: Set<string>, survived: Set<string> }> {
  const done = new Set<string>()
  const survived = new Set<string>()
  // Read again rather than trusting the snapshot: the panel's shutdown has been happening in
  // the meantime, and a nanny it already ended must not be signalled a second time.
  const live = new Set((await livePersistents()).map(persistentLabel))
  const handles = before.filter(handle => live.has(persistentLabel(handle)))
  if (handles.length === 0)
    return { done, survived }

  const { stopPersistentEntries } = await import('#src/providers/nanny-sweep')
  const results = await stopPersistentEntries(handles, { stopFor: await stopPolicyLookup() })

  for (const result of results) {
    const label = persistentLabel(result.handle)
    if (result.stopped) {
      done.add(label)
      process.stdout.write(`${green('stopped')} persistent ${label}\n`)
      continue
    }
    survived.add(label)
    process.stderr.write(`${paint('31', 'error')} persistent ${label}: ${result.error}\n`)
  }
  // A stop that left a server running is a failed stop, never a quiet success.
  const code = exitCodeForStops(results)
  if (code !== 0)
    process.exitCode = code
  return { done, survived }
}

/**
 * The exit code these stops earn: any survivor is a failure, because the command was asked to
 * stop them and the host is still running one. Separated from the printing so the rule is
 * pinned where it can be read, not inferred from a process's status.
 */
export function exitCodeForStops(results: ReadonlyArray<Readonly<{ stopped: boolean }>>): 0 | 1 {
  return results.some(result => !result.stopped) ? 1 : 0
}

/**
 * Each entry's own `stop` policy, read from the workspace that declares it.
 *
 * The grace period is the entry's, not a constant: the nanny forwards it to the child it
 * owns, so a shorter one here would escalate to `SIGKILL` while a shutdown the config asked
 * to allow more time for was still running. A workspace whose config cannot be read falls
 * back to the defaults — the host is being brought down either way.
 */
async function stopPolicyLookup(): Promise<(handle: PersistentHandle) => StopConfig> {
  const { WorkspaceStore } = await import('#src/config/store')
  const { workspaceServersPath, workspaceSettingsPath } = await import('#src/helpers/paths')
  const { stopSchema } = await import('#src/shared/contracts')
  const policies = new Map<string, Map<string, StopConfig>>()

  return (handle) => {
    let byId = policies.get(handle.workspaceId)
    if (byId === undefined) {
      byId = new Map()
      try {
        const store = new WorkspaceStore(handle.workspaceId, workspaceSettingsPath(handle.workspaceId), workspaceServersPath(handle.workspaceId))
        store.load()
        for (const server of store.servers)
          byId.set(server.id, server.stop)
      }
      catch {
        // A config this CLI cannot read still leaves its nanny to be stopped.
      }
      policies.set(handle.workspaceId, byId)
    }
    return byId.get(handle.serverId) ?? stopSchema.assert({})
  }
}

/**
 * The last step: name what the flag left running, or stop what the panel could not and account
 * for every entry that was running when this command started.
 *
 * The panel does the stopping whenever it is reachable — it is the only process that can record
 * it — so what is left of the snapshot is what still needs a signal here. Anything else in the
 * snapshot was ended by the panel, and is reported as stopped; a survivor is never reported as
 * stopped, or `restart` would treat a failed stop as a successful one.
 */
async function reportPersistent(options: DownOptions, before: PersistentHandle[] = []): Promise<DownResult['stoppedPersistent']> {
  if (options.withPersistent !== true) {
    const running = await livePersistents()
    if (running.length === 0)
      return []
    process.stdout.write(`${dim(`${running.length} persistent server(s) left running: ${running.map(persistentLabel).join(', ')}\n`)}`)
    process.stdout.write(`${dim('stop one from the panel, or pass --with-persistent')}\n`)
    return []
  }

  const ended = await stopPersistents(before)
  const stopped: DownResult['stoppedPersistent'] = []
  for (const handle of before) {
    const label = persistentLabel(handle)
    // A survivor is never reported as stopped, or `restart` would treat a failed stop as one.
    if (ended.survived.has(label))
      continue
    // Not ended here, so the panel did it on the way out: either way it is stopped, and the
    // caller cannot tell the two apart — nor should it have to.
    if (!ended.done.has(label))
      process.stdout.write(`${green('stopped')} persistent ${label}\n`)
    stopped.push({ workspaceId: handle.workspaceId, serverId: handle.serverId })
  }
  return stopped
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const { isProcessAlive } = await import('#src/helpers/daemon')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid))
      return true
    await delay(200)
  }
  return !isProcessAlive(pid)
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  }
  catch {
    // already gone
  }
}

/** Windows cannot deliver a graceful signal, so the whole tree is killed. */
function forceStop(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  signal(pid, 'SIGKILL')
}

export const downCommand = defineCommand({
  meta: { name: 'down' },
  args: {
    withPersistent: { type: 'boolean', description: 'also stop every persistent entry, in every workspace' },
  },
  run: async ({ args }) => {
    await runDown({ withPersistent: args.withPersistent === true })
  },
})
