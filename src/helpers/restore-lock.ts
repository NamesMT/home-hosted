import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { writeFileAtomic } from '#src/helpers/atomic'

/**
 * A lock file that stops two restores from writing the same host at once.
 *
 * A restore replaces config and data paths in place. Two of them interleaved — or one from the CLI
 * while the panel's own restore runs — write over each other, and neither knows the other exists.
 * That is also why it has to cover **both** paths: the panel and the offline CLI take the same lock,
 * so they exclude each other rather than only themselves.
 *
 * A pid that is gone means the holder died mid-restore, which used to leave a lock nobody could
 * clear. Stale is decided the same way `up`/`down` decide it — the recorded pid *and* its start time —
 * so a recycled pid is not mistaken for a live holder.
 */

/** How long a restore may hold the lock before another waits no longer on it. */
const STALE_AFTER_MS = 30 * 60_000

/** Absorbs the one-second granularity of a birth-time reading against the moment we recorded it. */
const BIRTH_TOLERANCE_MS = 2000

export interface LockRecord {
  pid: number
  startedAt: number
  action: string
  /**
   * The holder's own birth time where the platform reports one.
   *
   * `startedAt` is when the lock was taken, which says nothing about whether the pid still names the
   * same process — comparing the two made a long-held lock look recycled. This is the value that
   * answers the question directly, so a stale-reader compares like with like.
   */
  birthAt?: number | null
}

export interface RestoreLock {
  /** Releases the lock. Safe to call twice. */
  release: () => void
  /** The holder, when the lock was taken over from a dead one. */
  replaced?: LockRecord
}

function readRecord(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockRecord>
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number')
      return null
    // `birthAt` must survive the read: it is the whole basis for the recycled-pid check, and
    // dropping it here silently fell back to inferring liveness from the lock's age.
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      action: typeof parsed.action === 'string' ? parsed.action : 'restore',
      birthAt: typeof parsed.birthAt === 'number' ? parsed.birthAt : null,
    }
  }
  catch {
    return null
  }
}

/**
 * Is the recorded holder still the process that took it?
 *
 * Signal 0 alone is not enough — pids are recycled, and a zombie answers it — so the process's own
 * start time is compared with the recorded one where the platform can report it. Elsewhere the pid is
 * all there is, and an alive pid is taken as alive, which errs towards "somebody is working" rather
 * than stealing a live lock.
 */
function holderIsAlive(record: LockRecord): boolean {
  try {
    process.kill(record.pid, 0)
  }
  catch (error) {
    // EPERM means the process exists but belongs to another user — still a live holder.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  const birth = processBirthSync(record.pid)
  // A platform that cannot answer keeps the cautious answer — an alive pid is a live holder.
  if (birth === null)
    return true
  // When the record carries the holder's own birth time, compare like with like: this is the direct
  // question, and a recycled pid answers it plainly.
  if (record.birthAt != null)
    return Math.abs(birth - record.birthAt) <= BIRTH_TOLERANCE_MS
  // An older record has no birth time. Fall back to the only inference available: a pid born *after*
  // the lock was recorded is a different process, and one born before it may be the holder.
  return birth <= record.startedAt + BIRTH_TOLERANCE_MS
}

/** Wall-clock start of a pid in ms, or null where the platform cannot report one. */
export function processBirthSync(pid: number): number | null {
  try {
    // Linux: field 22 is the start time in clock ticks since boot, and `/proc/stat` has the boot time.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number.parseFloat(fields[19] ?? '')
    if (!Number.isFinite(ticks))
      return null
    const boot = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]
    if (boot === undefined)
      return null
    // 100 ticks a second on every mainstream kernel build.
    return Number.parseInt(boot, 10) * 1000 + (ticks / 100) * 1000
  }
  catch {
    return null
  }
}

/**
 * Take the restore lock, or explain who holds it.
 *
 * `null` means somebody else is restoring. The caller reports it rather than queueing: a restore is
 * an interactive decision, and waiting on one you did not start is not what a person asked for.
 */
export function acquireRestoreLock(hhDir: string, action = 'restore'): RestoreLock | { heldBy: LockRecord } {
  const file = path.join(hhDir, 'restore.lock')
  fs.mkdirSync(hhDir, { recursive: true })

  // Our record, decided once: `release()` compares against it to tell "still mine" from "taken over".
  const mine: LockRecord = { pid: process.pid, startedAt: Date.now(), action, birthAt: processBirthSync(process.pid) }
  const release = (): void => {
    const current = readRecord(file)
    if (current !== null && (current.pid !== mine.pid || current.startedAt !== mine.startedAt))
      return
    fs.rmSync(file, { force: true })
  }

  const existing = readRecord(file)
  if (existing !== null) {
    const stale = !holderIsAlive(existing) || Date.now() - existing.startedAt > STALE_AFTER_MS
    if (!stale)
      return { heldBy: existing }
    // The holder died, or has held it absurdly long: take it over, and say so.
    writeFileAtomic(file, `${JSON.stringify(mine)}\n`, { mode: 0o600 })
    return { release, replaced: existing }
  }

  try {
    // `wx` is the exclusion: creating fails if the file exists, atomically, so two starts cannot
    // both believe they created it.
    fs.writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: 'wx', mode: 0o600 })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Somebody created it between our read and our write. Their record is the answer — and if it
      // is unreadable the honest response is to say so rather than throw a raw errno.
      const holder = readRecord(file)
      return holder === null
        ? { heldBy: { pid: 0, startedAt: Date.now(), action: 'unreadable' } }
        : { heldBy: holder }
    }
    throw error
  }

  let released = false
  return {
    release: () => {
      if (released)
        return
      released = true
      release()
    },
  }
}
