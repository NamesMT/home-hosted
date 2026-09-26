import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { defineCommand } from 'citty'
import { delay, dim, green } from '#src/cli/io'

/** `down` stops the panel and everything it supervises. */

export async function runDown(): Promise<void> {
  const { clearRuntime, isProcessAlive, readRuntime, requestShutdown } = await import('#src/helpers/daemon')

  const runtime = readRuntime()
  if (runtime === null) {
    process.stdout.write('home-hosted is not running\n')
    return
  }
  if (!isProcessAlive(runtime.pid)) {
    clearRuntime()
    process.stdout.write('home-hosted is not running (removed a stale run.json)\n')
    return
  }

  process.stdout.write(`stopping pid ${runtime.pid}…\n`)
  // The panel's own endpoint stops supervised servers cleanly on every platform;
  // a signal is the fallback for a wedged or unreachable process.
  if (!(await requestShutdown(runtime)))
    signal(runtime.pid, 'SIGTERM')

  if (await waitForExit(runtime.pid, 20000)) {
    clearRuntime()
    process.stdout.write(`${green('stopped')}\n`)
    await reportPersistent()
    return
  }

  process.stdout.write(`${dim('it did not stop in time — forcing')}\n`)
  forceStop(runtime.pid)
  await waitForExit(runtime.pid, 5000)
  clearRuntime()
  process.stdout.write(`${green('stopped')} (forced)\n`)
  await reportPersistent()
}

/**
 * `down` stops what this panel supervises — a persistent entry is the one thing it
 * deliberately does not, so the silence about it has to be broken here. The state
 * files are the only record that survives the panel, so they answer it.
 */
async function reportPersistent(): Promise<void> {
  const { readNannyState, nannyIsAlive, SPEC_SUFFIX } = await import('#src/providers/nanny')
  const { defaultNannyDir } = await import('#src/helpers/paths')
  const { readdirSync } = await import('node:fs')
  const path = await import('node:path')

  let files: string[] = []
  try {
    // One state file per entry; a spawn spec is not one, and carries no pid.
    files = readdirSync(defaultNannyDir)
      .filter(name => name.endsWith('.json') && !name.endsWith(SPEC_SUFFIX))
  }
  catch {
    // No persistent entry was ever started here.
    return
  }

  const running: string[] = []
  for (const file of files) {
    const state = readNannyState(path.join(defaultNannyDir, file))
    if (state !== null && await nannyIsAlive(state, state.serverId))
      running.push(state.serverId)
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
  meta: { name: 'down', description: 'stop it, and everything it supervises' },
  run: async () => {
    await runDown()
  },
})
