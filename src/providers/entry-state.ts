import type { EntryState } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { entryStateSchema } from '#src/shared/contracts'

/**
 * The small slice of a server's runtime the panel has to remember across its own
 * restarts: how much of the retry budget is spent, and whether a `runOnce` bootstrap
 * already ran.
 *
 * Both lived only in memory, so a panel restart — a `restart`, a crash, a reboot —
 * handed a crash-looping server a fresh `maxRetries` and re-ran its bootstrap. The
 * retry counter has to outlive the process that increments it to bound anything.
 */

/** One JSON file per entry, beside the nanny's own state. */
export function entryStatePath(dir: string, id: string): string {
  return path.join(dir, `${id}.run.json`)
}

export function readEntryState(file: string): EntryState | null {
  try {
    const parsed = entryStateSchema(JSON.parse(fs.readFileSync(file, 'utf8')))
    return parsed instanceof type.errors ? null : parsed
  }
  catch {
    return null
  }
}

export function writeEntryState(file: string, state: EntryState): void {
  try {
    writeFileAtomic(file, `${JSON.stringify(state)}\n`)
  }
  catch {
    // Best effort, like history: no state file must never stop supervision.
  }
}

export function clearEntryState(file: string): void {
  fs.rmSync(file, { force: true })
}
