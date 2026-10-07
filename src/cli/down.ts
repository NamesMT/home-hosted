import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { defineCommand } from 'citty'
import { delay, dim, green } from '#src/cli/io'
import { versionMismatchNote } from '#src/helpers/version'

/** `down` stops the panel and everything it supervises. */

export async function runDown(): Promise<void> {
  const { clearRuntime, isLiveLiveness, readRuntime, requestShutdown, runtimeLiveness } = await import('#src/helpers/daemon')

  const runtime = readRuntime()
  if (runtime === null) {
    process.stdout.write('home-hosted is not running\n')
    return
  }

  const liveness = await runtimeLiveness(runtime)
  // Nothing at all is behind the pid, so the record is simply stale: delete it, and do not touch the
  // network — a port this record names may now belong to an unrelated service.
  if (liveness === 'gone') {
    clearRuntime()
    process.stdout.write(`home-hosted is not running (removed a stale run.json from home-hosted ${runtime.version})\n`)
    return
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
    answered = await requestShutdown(runtime)
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
    const answeredByPanel = await requestShutdown(runtime)
    if (!answeredByPanel) {
      process.stdout.write(`home-hosted is not running (the pid in run.json, ${runtime.pid}, belongs to another process — it was not signalled)\n`)
      return
    }
    process.stdout.write(`stopped the panel on ${runtime.url} (its pid in run.json, ${runtime.pid}, was another process and was left alone)\n`)
    clearRuntime()
    await reportPersistent()
    return
  }

  if (await waitForExit(runtime.pid, 20000)) {
    clearRuntime()
    reportStopped(false)
    await reportPersistent()
    return
  }

  process.stdout.write(`${dim('it did not stop in time — forcing')}\n`)
  forceStop(runtime.pid)
  await waitForExit(runtime.pid, 5000)
  clearRuntime()
  reportStopped(true)
  await reportPersistent()
}

/**
 * `down` stops what this panel supervises — a persistent entry is the one thing it
 * deliberately does not, so the silence about it has to be broken here. The state
 * files are the only record that survives the panel, so they answer it — across
 * every workspace, because each keeps its own `.state` directory.
 */
async function reportPersistent(): Promise<void> {
  const { readNannyState, nannyIsAlive, SPEC_SUFFIX } = await import('#src/providers/nanny')
  const { workspaceIdsOnDisk, workspaceStateDir } = await import('#src/helpers/paths')
  const { readdirSync } = await import('node:fs')
  const path = await import('node:path')

  const running: string[] = []
  for (const workspaceId of workspaceIdsOnDisk()) {
    const dir = workspaceStateDir(workspaceId)
    let files: string[] = []
    try {
      // One state file per entry; a spawn spec is not one, and carries no pid.
      files = readdirSync(dir).filter(name => name.endsWith('.json') && !name.endsWith(SPEC_SUFFIX))
    }
    catch {
      // No persistent entry was ever started in this workspace.
      continue
    }

    for (const file of files) {
      const state = readNannyState(path.join(dir, file))
      if (state !== null && await nannyIsAlive(state, state.serverId))
        running.push(`${workspaceId}/${state.serverId}`)
    }
  }
  if (running.length === 0)
    return

  process.stdout.write(`${dim(`${running.length} persistent server(s) left running: ${running.join(', ')}`)}\n`)
  process.stdout.write(`${dim('stop one from the panel, or restart it here to reattach')}\n`)
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
  run: async () => {
    await runDown()
  },
})
