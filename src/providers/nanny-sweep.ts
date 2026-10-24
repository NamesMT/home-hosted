import type { NannyState, StopConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { nannyIsAlive, nannySpecPath, nannyStatePath, readNannyState, SPEC_SUFFIX } from '#src/providers/nanny'
import { isProcessAlive } from '#src/providers/port'
import { terminatePid } from '#src/providers/process'
import { stopSchema } from '#src/shared/contracts'

/**
 * Finds and ends the persistent entries a host is running, with no panel in the loop.
 *
 * `down` leaves these alone on purpose, so `--with-persistent` is the one caller that has to
 * act on them — often after the panel is already gone. The nanny state files are the only
 * record that survives that, and they are per workspace, so every workspace is read.
 *
 * The **nanny** is what gets signalled: it traps the signal and forwards the entry's own
 * `stop` policy to the child it owns, which is what the panel's stop does. That is also why
 * this cannot go through `/_hh` — after a crash there is nothing left to ask.
 */

/** One live persistent entry, as its state file describes it. */
export interface PersistentHandle {
  workspaceId: string
  serverId: string
  state: NannyState
  /** The workspace's `.state` directory, which owns the state file. */
  dir: string
}

/**
 * Every workspace's state directory.
 *
 * Read here rather than through `workspaceStateDir()`, which resolves from *this* process's
 * `HHOSTED_HOME`: a caller passing `--home` elsewhere would otherwise sweep another host's
 * state — the mistake `backup-offline` already paid for.
 */
function stateDirs(hhDir: string): Array<{ workspaceId: string, dir: string }> {
  try {
    return fs.readdirSync(hhDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .filter(id => /^[a-z0-9][a-z0-9_-]*$/.test(id))
      .map(workspaceId => ({ workspaceId, dir: path.join(hhDir, workspaceId, '.state') }))
  }
  catch {
    return []
  }
}

/**
 * The persistent entries whose nanny is running right now.
 *
 * A `<id>.run.json` file is a *non-persistent* child's own record and carries no nanny, so it
 * is skipped by suffix — the same distinction `backup-offline` relies on. `nannyIsAlive` is
 * the identity check: a live pid alone proves nothing, since pids are reused.
 */
export async function livePersistentEntries(hhDir: string): Promise<PersistentHandle[]> {
  const found: PersistentHandle[] = []

  for (const { workspaceId, dir } of stateDirs(hhDir)) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    }
    catch {
      // No persistent entry was ever started in this workspace.
      continue
    }

    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith(SPEC_SUFFIX))
        continue
      // One file per entry, named for it: a file that disagrees with its own name is not
      // something to act on.
      const serverId = name.slice(0, -'.json'.length)
      const state = readNannyState(path.join(dir, name))
      if (state === null || state.serverId !== serverId)
        continue
      if (await nannyIsAlive(state, serverId))
        found.push({ workspaceId, serverId, state, dir })
    }
  }
  return found
}

/** What one stop did, so a survivor is reported rather than dressed up as success. */
export interface PersistentStop {
  handle: PersistentHandle
  stopped: boolean
  error: string | null
}

/**
 * Stops these entries and consumes the record of each one that ended.
 *
 * `stopFor` is the entry's own `stop` config, read by the caller from the workspace that
 * declares it: the grace period here has to be the one the entry asked for, or a stop that
 * was still finishing its shutdown reads as a failure and escalates to `SIGKILL`.
 */
export async function stopPersistentEntries(
  handles: PersistentHandle[],
  options: {
    stopFor?: (handle: PersistentHandle) => StopConfig
    /**
     * The one thing a test cannot supply: `SIGKILL` is not survivable, and a pid this process
     * may not signal (the real survivor) is a second user this host has no way to create. The
     * seam is the terminator, not the decision — everything below still runs.
     */
    terminate?: typeof terminatePid
  } = {},
): Promise<PersistentStop[]> {
  const results: PersistentStop[] = []
  const terminate = options.terminate ?? terminatePid
  // `.assert` returns the parsed value with the schema's defaults filled in; the plain call
  // type is `Value | errors`, which would make every field a type error to read.
  const defaultStop = stopSchema.assert({})

  for (const handle of handles) {
    const stop = options.stopFor?.(handle) ?? defaultStop
    const { state, dir, serverId } = handle
    const nanny = await terminate(state.nannyPid, { signal: stop.signal, killGroup: stop.killGroup, graceMs: stop.graceMs })

    // A nanny this process could not signal, or one that outlived `SIGKILL`, keeps its
    // record: it is the only way a later boot can find that process again.
    if (isProcessAlive(state.nannyPid)) {
      results.push({ handle, stopped: false, error: `pid ${state.nannyPid} survived the stop — its record is kept, so the next \`up\` can still find it` })
      continue
    }

    // A nanny stops its child on the graceful path. `SIGKILL` cannot be trapped, and with
    // `killGroup: false` the group signal never reached the child either, so the pid in the
    // state file is the only handle left on a server that would otherwise keep serving.
    if (!stop.killGroup && nanny === 'force-killed' && state.childPid !== null && state.childPid > 0)
      await terminate(state.childPid, { signal: 'SIGKILL', killGroup: false, graceMs: 0 })

    consumeRecord(dir, serverId)
    results.push({ handle, stopped: true, error: null })
  }
  return results
}

/**
 * The record goes only once the process it names is gone: a state file kept past its process
 * is a false reattach waiting, which is what `resumePersistent` exists to prevent.
 */
function consumeRecord(dir: string, serverId: string): void {
  for (const file of [nannyStatePath(dir, serverId), nannySpecPath(dir, serverId)]) {
    try {
      fs.rmSync(file, { force: true })
    }
    catch {
      // A file this process may not remove is the next boot's business, not a stop failure.
    }
  }
}
