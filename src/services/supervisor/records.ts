import type { ProcessBirth, ProcessLiveness } from '#src/providers/port'
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
    /**
     * It was recorded, so it was running when that panel died, and it is not there now. The caller
     * reports it: a run that ended while nobody watched is a crash, never a clean stop.
     */
    | { kind: 'gone', pid: number, startedAt: number | null, recycled: boolean }
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
 *
 * A record whose process is **gone** is reported, not silently dropped. The file exists only because
 * this entry was running when its panel died, so its absence is the end of that run — and a run that
 * ended while nobody was watching is a crash. Returning `{ kind: 'none' }` made it a clean stop:
 * `status: stopped`, `lastError: null`, no `crash` event, `degraded: false`, and the restart budget
 * untouched, so a child that dies with the panel was invisible for ever.
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
  const liveness = await pidLiveness(recorded.pid, recorded.startedAt)
  if (liveness === 'gone' || liveness === 'recycled') {
    // The record goes here, as it always did; the *reason* is now the caller's to report.
    const pid = recorded.pid
    const startedAt = recorded.startedAt > 0 ? recorded.startedAt : null
    entry.lastChild = null
    ctx.persist(entry)
    return { kind: 'gone', pid, startedAt, recycled: liveness === 'recycled' }
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
 * Reports a recorded child that is gone, as the end of a run rather than as "nothing happened".
 *
 * The record exists only because this entry was running when its panel died, so its absence is that
 * run's end. It is always an exit; at **boot** it is also a crash, with the reason kept, because a
 * person has to be told that the thing the panel was supposedly keeping alive is not there. A Start
 * someone asked for afterwards is answered by its own outcome, the same rule a persistent entry's
 * `resume({ reportAway })` follows.
 *
 * No `runtimeMs`: the child died at an instant nothing recorded, and `now - startedAt` would charge
 * the panel's whole downtime to the server's uptime.
 *
 * The status becomes `crashed` — that is load-bearing, not decoration: `needsAttention` reads it, so
 * without it `/healthz` still answered `200 ok` and the panel's own "anything wrong" count stayed
 * zero. A caller that is about to spawn a fresh child overwrites it a moment later, which is right:
 * the crash is history and the notification has already gone out.
 */
export function reportRecordedChildGone(
  ctx: SupervisorContext,
  entry: Entry,
  gone: Extract<RecordedChild, { kind: 'gone' }>,
  options: { reportAway: boolean },
): void {
  const why = gone.recycled
    ? `pid ${gone.pid} belongs to another process now`
    : `pid ${gone.pid} is not running`
  const exit = `the child this panel started is gone (${why})`
  ctx.options.history.record(entry.config.id, { type: 'exit', detail: exit })
  ctx.log(entry, 'system', exit)
  if (!options.reportAway)
    return

  const detail = `it was running when the panel died and is gone now (${why})`
  // Only for an entry nothing is about to take over: a boot that will start it reports the crash and
  // then publishes the fresh run's status, so a `crashed` set here would be a frame nobody sees.
  if (entry.status !== 'starting' && entry.status !== 'running')
    entry.status = 'crashed'
  entry.lastError = detail
  ctx.options.history.record(entry.config.id, { type: 'crash', detail })
  ctx.notify(entry, 'crash', detail)
  ctx.publishServer(entry)
}

/**
 * The record of a child that was running when a previous panel died, when that process is gone —
 * cleared as it is read, so the start that follows cannot report the same run twice.
 *
 * `resolveRecordedChild` answers the same question as part of a start, but it also blocks the entry
 * when the pid is alive and unattributable. This is the boot sweep's narrower question, asked of the
 * entries a boot will *not* start, and it never touches a pid that cannot be proven gone.
 */
export async function takeGoneRecordedChild(ctx: SupervisorContext, entry: Entry): Promise<Extract<RecordedChild, { kind: 'gone' }> | null> {
  const recorded = entry.lastChild
  if (recorded === null || entry.config.persistent || !entry.config.enabled || entry.removed)
    return null
  if (recorded.pid === process.pid) {
    entry.lastChild = null
    ctx.persist(entry)
    return null
  }

  const liveness = await pidLiveness(recorded.pid, recorded.startedAt)
  if (liveness !== 'gone' && liveness !== 'recycled')
    return null

  const pid = recorded.pid
  entry.lastChild = null
  ctx.persist(entry)
  return { kind: 'gone', pid, startedAt: recorded.startedAt > 0 ? recorded.startedAt : null, recycled: liveness === 'recycled' }
}

/**
 * The liveness of a pid a record describes, normalised in the one place both verdicts read it.
 *
 * A birth stamp decides `'recycled'`; a record written before `startedAt` was stored has only
 * `isProcessAlive` to go on, and answers `'unknown'` (alive) or `'gone'`. Callers then say which
 * verdicts matter to them — a **record** is gone on `'gone'`/`'recycled'`, a **survivor** still runs
 * on `'live'`/`'unknown'` — because collapsing the two rules is what let a recycled pid be reported
 * as a live survivor and a dead child as a clean stop.
 *
 * Not for a 1 Hz death poll: `processLiveness` costs a `ps` on macOS and a PowerShell call on
 * Windows, so the tick's adopted-process check stays on `isProcessAlive` and lets a probe or the
 * restart policy catch a recycled pid.
 */
export function pidLiveness(pid: number, startedAt: number): Promise<ProcessLiveness> {
  return startedAt > 0
    ? processLiveness(pid, startedAt)
    : Promise.resolve(isProcessAlive(pid) ? 'unknown' : 'gone')
}

/** How long an orphan's birth check is trusted before it is read again. */
const ORPHAN_BIRTH_RECHECK_MS = 15_000

/**
 * The birth verdicts of earlier scans, keyed by `(pid, startedAt)`. A birth read is a `ps` (or a
 * PowerShell call on Windows) per pid, and the scan runs every second.
 */
export type OrphanLivenessCache = Map<string, { liveness: ProcessLiveness, at: number }>

/**
 * Processes this panel started that no configured entry claims any more (renamed or removed while the
 * panel was down), read from the state directory so an earlier panel's files count too.
 *
 * A readdir plus one cheap signal-0 per record each call; the birth check, which costs a process
 * spawn on macOS and Windows, is cached per `(pid, startedAt)` and repeated only every
 * `ORPHAN_BIRTH_RECHECK_MS`. A pid that dies is still seen on the next scan.
 */
export async function scanOrphans(
  nannyDir: string,
  owned: (id: string) => boolean,
  options: { cache?: OrphanLivenessCache, now?: number, readBirth?: (pid: number) => Promise<ProcessBirth | null> } = {},
): Promise<ServerOrphan[]> {
  let names: string[]
  try {
    names = fs.readdirSync(nannyDir)
  }
  catch {
    return []
  }

  const now = options.now ?? Date.now()
  const seen = new Set<string>()
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
    let liveness: ProcessLiveness
    if (!isProcessAlive(pid)) {
      liveness = 'gone'
    }
    else if (startedAt <= 0) {
      liveness = 'unknown'
    }
    else {
      const key = `${pid}:${startedAt}`
      seen.add(key)
      const cached = options.cache?.get(key)
      if (cached !== undefined && now - cached.at < ORPHAN_BIRTH_RECHECK_MS) {
        liveness = cached.liveness
      }
      else {
        liveness = await processLiveness(pid, startedAt, { readBirth: options.readBirth })
        options.cache?.set(key, { liveness, at: now })
      }
    }
    if (liveness === 'gone' || liveness === 'recycled')
      continue
    found.push({ serverId: id, pid, startedAt: startedAt > 0 ? startedAt : null })
  }
  // Only what this scan still saw, so the cache cannot grow past the state directory.
  for (const key of options.cache?.keys() ?? []) {
    if (!seen.has(key))
      options.cache?.delete(key)
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
