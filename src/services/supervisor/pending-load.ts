import type { Entry, SupervisorContext } from '#src/services/supervisor/entry'
import { hookFailure, runBackupHook } from '#src/providers/backup-hook'
import { delay, isActive } from '#src/services/supervisor/entry'
import { portAccepts } from '#src/services/supervisor/port-preflight'

/**
 * Runs the load hook a restore left behind, once the entry is answering: `mongorestore` and
 * `pg_restore` connect, so running them the instant the process spawns fails with "connection refused".
 */
export async function runPendingLoad(ctx: SupervisorContext, entry: Entry): Promise<void> {
  const dumpDir = entry.pendingLoad
  const hook = entry.config.load
  // `loadingPending` stops two overlapping starts from loading the dump twice.
  if (entry.loadingPending || dumpDir === null || hook === undefined || hook === null) {
    // No hook in the live config: drop the staged dump rather than keep a path nothing will read.
    if (hook === undefined || hook === null) {
      entry.pendingLoad = null
      ctx.persist(entry)
    }
    return
  }
  entry.loadingPending = true

  // The hook loads into *this* run. A stop, a crash or a dispose ends it (each bumps `runToken`), and
  // a load run then would fail against nothing and throw the staged dump away.
  const token = entry.runToken
  const sameRun = (): boolean => entry.runToken === token && isActive(entry) && entry.status !== 'stopped'
  let answered = true
  if (entry.config.port !== null) {
    const port = entry.config.port
    const deadline = Date.now() + hook.timeoutMs
    answered = false
    while (Date.now() < deadline && sameRun()) {
      if (await portAccepts(entry, port, 1000)) {
        answered = true
        break
      }
      await delay(500)
    }
  }
  else if (hook.waitMs > 0) {
    // No port to probe: wait a bounded moment rather than load into something not yet bound.
    await delay(hook.waitMs)
  }

  if (!answered || !sameRun()) {
    // Kept staged for the next start.
    entry.loadingPending = false
    ctx.log(entry, 'system', sameRun()
      ? `load: port ${entry.config.port} never answered, the restored dump waits for the next start`
      : 'load: the server stopped before it was ready, the restored dump waits for the next start')
    return
  }

  // Cleared before the run: a failing load must not retry on every restart; the dump stays on disk.
  entry.pendingLoad = null
  ctx.persist(entry)

  const result = await runBackupHook(hook, entry.config, dumpDir)
  entry.loadingPending = false
  ctx.log(entry, 'system', result.ok
    ? 'load: the restored dump was applied'
    : `load: ${hookFailure('load', entry.config, result)}`)
}
