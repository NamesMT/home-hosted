import type { Entry, SupervisorContext } from '#src/services/supervisor/entry'
import type { ServerOrphan } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { clearEntryState, entryStatePath, readEntryState, writeEntryState } from '#src/providers/entry-state'
import { isProcessAlive, processLiveness, terminatePids } from '#src/providers/port'
import { processCarriesServerId } from '#src/providers/proc'
import { isPersistentRun } from '#src/services/supervisor/entry'

/** What this entry's own state file says about the child the last panel spawned. */
export type RecordedChild
  = | { kind: 'none' }
    | { kind: 'adopt', pid: number }
    | { kind: 'blocked', error: string }

/** The decisions that have to survive this panel, and nothing else. */
export function persistEntryState(nannyDir: string, entry: Entry): void {
  // A removed entry's file was reclaimed; the async stop that follows must not recreate it.
  if (entry.removed)
    return
  writeEntryState(entryStatePath(nannyDir, entry.config.id), {
    restarts: entry.restarts,
    healthRestarts: entry.healthRestarts,
    bootstrapDone: entry.bootstrapDone,
    // Carried, not recomputed: a rewrite without it silently drops a restore's staged load.
    pendingLoad: entry.pendingLoad,
    // A persistent entry's nanny state is already its record; a second one could only disagree.
    lastPid: isPersistentRun(entry) ? null : entry.lastChild?.pid ?? null,
    lastStartedAt: isPersistentRun(entry) ? null : entry.lastChild?.startedAt ?? null,
  })
}

/**
 * The child this entry's state file recorded, when it is still that same process.
 *
 * A non-persistent child is detached and survives a panel killed hard; `preflight` cannot find a
 * portless one. Birth time and the marker decide, never liveness alone, and a pid this platform
 * cannot place is never adopted on a guess. The record is cleared only once its process is known gone
 * or to be somebody else.
 */
export async function resolveRecordedChild(ctx: SupervisorContext, entry: Entry): Promise<RecordedChild> {
  const recorded = entry.lastChild
  if (recorded === null)
    return { kind: 'none' }

  // Never adopt the panel itself.
  if (recorded.pid === process.pid) {
    entry.lastChild = null
    ctx.persist(entry)
    return { kind: 'none' }
  }

  // An older file has no birth stamp, and 0 would read as recycled, so liveness is all it can be judged by.
  const liveness = recorded.startedAt > 0
    ? await processLiveness(recorded.pid, recorded.startedAt)
    : (isProcessAlive(recorded.pid) ? 'unknown' : 'gone')
  if (liveness === 'gone' || liveness === 'recycled') {
    entry.lastChild = null
    ctx.persist(entry)
    return { kind: 'none' }
  }

  if (await processCarriesServerId(recorded.pid, entry.config.id))
    return { kind: 'adopt', pid: recorded.pid }

  // Alive and unattributable (Windows has no per-process env). With a port the preflight still has
  // witnesses; without one, refusing beats a duplicate portless worker.
  if (entry.config.port !== null)
    return { kind: 'none' }

  const error = `pid ${recorded.pid} may be a child this panel started for "${entry.config.id}" before it died, and this platform cannot confirm whose it is — not starting a second copy, stop pid ${recorded.pid} to clear it`
  entry.status = 'conflict'
  entry.lastError = error
  ctx.log(entry, 'system', error)
  ctx.publishServer(entry)
  return { kind: 'blocked', error }
}

/** Clears the durable record of the last child, once that pid is known to be gone. */
export function forgetRecordedChild(ctx: SupervisorContext, entry: Entry, pid: number | null): void {
  if (pid === null || entry.lastChild === null || entry.lastChild.pid !== pid)
    return
  entry.lastChild = null
  ctx.persist(entry)
}

/**
 * Processes this panel started that no configured entry claims any more (renamed or removed while the
 * panel was down), read from the state directory so an earlier panel's files count too.
 */
export async function scanOrphans(nannyDir: string, owned: (id: string) => boolean): Promise<ServerOrphan[]> {
  let names: string[]
  try {
    names = fs.readdirSync(nannyDir)
  }
  catch {
    return []
  }

  const found: ServerOrphan[] = []
  for (const name of names) {
    if (!name.endsWith('.run.json'))
      continue
    const id = name.slice(0, -'.run.json'.length)
    if (owned(id))
      continue
    const state = readEntryState(path.join(nannyDir, name))
    const pid = state?.lastPid ?? null
    if (pid === null || pid === process.pid)
      continue
    const startedAt = state?.lastStartedAt ?? 0
    // A pid born after the record is a stranger, and reporting it would offer a one-click SIGTERM of
    // it. No stamp can only be judged by liveness, and `unknown` counts as alive.
    const liveness = startedAt > 0
      ? await processLiveness(pid, startedAt)
      : (isProcessAlive(pid) ? 'unknown' : 'gone')
    if (liveness === 'gone' || liveness === 'recycled')
      continue
    found.push({ serverId: id, pid, startedAt: startedAt > 0 ? startedAt : null })
  }
  return found
}

/** Stops one orphan; its record is cleared only once the pid is gone, so a survivor stays findable. */
export async function stopOrphanProcess(nannyDir: string, orphan: ServerOrphan): Promise<{ ok: true, forced: number[] } | { ok: false, error: string }> {
  const { forced } = await terminatePids([orphan.pid], { graceMs: 5000 })
  if (isProcessAlive(orphan.pid))
    return { ok: false, error: `pid ${orphan.pid} survived the stop — kill it from a shell, its record is kept` }
  clearEntryState(entryStatePath(nannyDir, orphan.serverId))
  return { ok: true, forced }
}
