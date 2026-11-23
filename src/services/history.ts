import type { HistoryEvent, ServerHistory } from '#src/shared/contracts'
import fs from 'node:fs'
import { writeFileAtomic } from '#src/helpers/atomic'

/**
 * The rolling window — **and the total ceiling**. Nothing adds to it.
 *
 * At most `MAX_EVENTS` events are retained, of which up to `MAX_PINS` are pinned one-`job-run`-per-
 * server, because the scheduler's boot catch-up reads that to decide whether an occurrence is owed.
 * The pin budget is reserved *out of* the window (`MAX_EVENTS - pinned.size`), so pins displace
 * ordinary events rather than sitting beside them.
 */
const MAX_EVENTS = 5000
/**
 * How many servers keep a pinned `job-run`.
 *
 * The pin exists so the scheduler's boot catch-up cannot lose its only input to a busy neighbour. It
 * needs to be bounded or the cap stops meaning anything: 200 is far more jobs than a home panel has,
 * and keeps the real ceiling at `MAX_EVENTS + MAX_PINS`.
 */
const MAX_PINS = 200
const SAVE_DEBOUNCE_MS = 2000
const EVENTS_IN_VIEW = 8

/**
 * Bounded event log per server, persisted as JSON so uptime and crash counts
 * survive a restart of the control plane.
 *
 * Uptime is derived from recorded runtimes (each exit stores how long the process
 * was up) rather than from sampling, so it stays accurate without a background
 * poller.
 */
export class HistoryStore {
  private events: HistoryEvent[] = []
  private saveTimer: NodeJS.Timeout | null = null
  private loaded = false
  /** Bumped on every record, so readers can cache their summaries. */
  private version = 0

  constructor(private readonly file: string) {}

  get revision(): number {
    return this.version
  }

  load(): void {
    if (this.loaded)
      return
    this.loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { events?: HistoryEvent[] }
      this.events = Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : []
    }
    catch {
      this.events = []
    }
  }

  record(serverId: string, event: Omit<HistoryEvent, 'serverId' | 'ts'>, ts = Date.now()): void {
    this.load()
    this.events.push({ serverId, ts, ...event })
    this.version += 1
    /**
     * The newest `job-run` per server is **pinned** past the cap.
     *
     * It is no longer only a display value: the scheduler's boot catch-up reads it to decide whether an
     * occurrence is owed, so evicting it re-opens the double-start the `running` claim exists to
     * prevent — a busy workspace plus a reboot and a long run is enough. The cap is workspace-wide, so
     * without this a chatty neighbour could evict a quiet job's only defence.
     */
    this.pinNewestJobRun()
    this.scheduleSave()
  }

  /**
   * Keeps one `job-run` event per server even when the window rolls past it.
   *
   * Bounded in its own right: a workspace with more servers than `MAX_PINS` keeps the most recently
   * active ones and lets the rest roll. Without a bound, a workspace with six thousand ids would pin
   * six thousand events and the documented ceiling would be a lie.
   */
  private pinNewestJobRun(): void {
    const newest = new Map<string, HistoryEvent>()
    for (const event of this.events) {
      if (event.type !== 'job-run')
        continue
      const seen = newest.get(event.serverId)
      if (seen === undefined || event.ts > seen.ts)
        newest.set(event.serverId, event)
    }
    // Keep the most recently active pins, and let the rest roll: a workspace with more ids than
    // `MAX_PINS` must not quietly exceed the documented ceiling.
    const ranked = [...newest.entries()].sort((left, right) => right[1].ts - left[1].ts)
    const pinned = new Set(ranked.slice(0, MAX_PINS).map(([, event]) => event))
    const rest = this.events.filter(event => !pinned.has(event))
    const overflow = rest.length - Math.max(0, MAX_EVENTS - pinned.size)
    const kept = overflow > 0 ? rest.slice(overflow) : rest
    this.events = [...new Set([...kept, ...pinned])].sort((left, right) => left.ts - right.ts)
  }

  all(): HistoryEvent[] {
    this.load()
    return [...this.events]
  }

  /**
   * Drops every event for a server that no longer exists.
   *
   * An id is only unique *while* it exists. Nothing pruned on removal, so re-adding an id — a
   * rename-back, a restore, a config edit — inherited the old entry's crash time and event list, and
   * the card showed "Last crash" for a server that had never been started. Bounded (5000 events) so it
   * was never a leak, but wrong in the same way the log files were.
   */
  forget(serverId: string): void {
    this.load()
    const kept = this.events.filter(event => event.serverId !== serverId)
    if (kept.length === this.events.length)
      return
    this.events = kept
    this.version += 1
    this.scheduleSave()
  }

  /**
   * When a server last recorded an event of one type, or `null` when it never has.
   *
   * The scheduler's boot catch-up asks this: a `job-run` event is the **durable** record of a run
   * (the panel's in-memory clock is not), so it is what decides whether a panel that was down across
   * an occurrence still owes one. Bounded by the same event log every other read is.
   */
  lastEventAt(serverId: string, type: HistoryEvent['type']): number | null {
    this.load()
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index]!
      if (event.serverId === serverId && event.type === type)
        return event.ts
    }
    return null
  }

  /** `runningSince` adds the in-flight up-interval so a long-running server shows its real ratio. */
  summarize(serverId: string, windowMs: number, now = Date.now(), runningSince: number | null = null): ServerHistory {
    this.load()
    const since = now - windowMs
    const mine = this.events.filter(event => event.serverId === serverId)
    const recent = mine.filter(event => event.ts >= since)

    // Each recorded runtime ends at its own event, so only the part that falls inside the window
    // counts. `Math.min(runtimeMs, windowMs)` alone kept the *whole* run: a 24h run that ended 12h
    // before `now` sits half outside a 24h window, and was reported as 100% up. Clipping the start
    // against `since` is what makes the number mean "up during this window".
    let upMs = 0
    for (const event of recent) {
      if (event.runtimeMs === undefined)
        continue
      const startedAt = event.ts - event.runtimeMs
      upMs += event.ts - Math.max(startedAt, since)
    }
    if (runningSince !== null)
      upMs += Math.max(0, now - Math.max(runningSince, since))

    // The ratio is over the part of the window this server existed for: a server first seen ten
    // minutes ago and up the whole time is 100% up, not 0.7% of a day.
    const firstSeen = Math.min(...mine.map(event => event.ts - (event.runtimeMs ?? 0)), runningSince ?? now)
    const observedMs = Math.max(1, now - Math.max(since, firstSeen))

    const lastCrash = [...mine].reverse().find(event => event.type === 'crash')
    const lastExit = [...mine].reverse().find(event => event.type === 'exit' || event.type === 'crash')

    return {
      windowMs,
      uptimeRatio: mine.length === 0 ? null : Math.max(0, Math.min(1, upMs / observedMs)),
      restarts: recent.filter(event => event.type === 'start').length,
      crashes: recent.filter(event => event.type === 'crash').length,
      forcedRestarts: recent.filter(event => event.type === 'forced-restart').length,
      lastCrashAt: lastCrash?.ts ?? null,
      lastExitAt: lastExit?.ts ?? null,
      lastRuntimeMs: lastExit?.runtimeMs ?? null,
      events: recent.slice(-EVENTS_IN_VIEW),
    }
  }

  /** Flushes a pending save only: a store never read holds `[]`, and saving it would empty the file. */
  dispose(): void {
    if (this.saveTimer === null)
      return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.save()
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null)
      return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref()
  }

  private save(): void {
    try {
      writeFileAtomic(this.file, `${JSON.stringify({ version: 1, events: this.events })}\n`)
    }
    catch {
      // History is best-effort; never let it break supervision.
    }
  }
}
