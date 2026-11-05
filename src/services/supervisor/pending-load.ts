import type { Entry, SupervisorContext } from '#src/services/supervisor/entry'
import { hookFailure, runBackupHook } from '#src/providers/backup-hook'
import { probePort } from '#src/providers/port'

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

  if (entry.config.port !== null) {
    const deadline = Date.now() + hook.timeoutMs
    while (Date.now() < deadline && entry.status !== 'stopped') {
      if (await probePort('127.0.0.1', entry.config.port))
        break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  else if (hook.waitMs > 0) {
    // No port to probe: wait a bounded moment rather than load into something not yet bound.
    await new Promise(resolve => setTimeout(resolve, hook.waitMs))
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
