import path from 'node:path'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { hhDir } from '#src/helpers/paths'

/**
 * How the panel last stopped — the fact `status` could not report.
 *
 * A clean `down` deletes `run.json`, and so does `up` when it finds a record with nothing behind the
 * pid. So "no record" covered both "you stopped it" and "it died and the next start tidied up", and a
 * script could only tell them apart by inferring from which *keys* were absent. This records the
 * answer instead of leaving it to be guessed.
 *
 * Only a deliberate stop writes it. A panel that was killed has nobody to write anything, which is
 * why a *stale record* stays the signal for that one — see `status`.
 */
export const lastStopSchema = type({
  /** Milliseconds since the epoch, from the process that stopped it. */
  at: 'number',
  /** How it stopped. `down` is the only writer today; the field exists so a future cause is named. */
  reason: '"down"',
})

export type LastStop = typeof lastStopSchema.infer

const lastStopPath = path.join(hhDir, '.last-stop.json')

/** Records a deliberate stop. Best-effort: a panel that stopped is stopped, whatever this file does. */
export function recordCleanStop(at = Date.now()): void {
  try {
    writeFileAtomic(lastStopPath, `${JSON.stringify({ at, reason: 'down' }, null, 2)}\n`, { mode: 0o600 })
  }
  catch {
    // The stop itself succeeded; a missing marker only costs `status` one detail.
  }
}

/** The last deliberate stop, or null when there is none (or it cannot be read). */
export function readLastStop(): LastStop | null {
  try {
    const parsed = lastStopSchema(JSON.parse(readStateFile(lastStopPath)) as unknown)
    return parsed instanceof type.errors ? null : parsed
  }
  catch {
    return null
  }
}
