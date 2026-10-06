import type { HistoryEvent, ServerHistory } from '#src/shared/contracts'
import fs from 'node:fs'
import { writeFileAtomic } from '#src/helpers/atomic'

const MAX_EVENTS = 5000
const SAVE_DEBOUNCE_MS = 2000
const EVENTS_IN_VIEW = 8

export type HistoryEventType = HistoryEvent['type']

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
    if (this.events.length > MAX_EVENTS)
      this.events.splice(0, this.events.length - MAX_EVENTS)
    this.scheduleSave()
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

    const lastCrash = [...mine].reverse().find(event => event.type === 'crash')
    const lastExit = [...mine].reverse().find(event => event.type === 'exit' || event.type === 'crash')

    return {
      windowMs,
      uptimeRatio: mine.length === 0 ? null : Math.max(0, Math.min(1, upMs / windowMs)),
      restarts: recent.filter(event => event.type === 'start').length,
      crashes: recent.filter(event => event.type === 'crash').length,
      forcedRestarts: recent.filter(event => event.type === 'forced-restart').length,
      lastCrashAt: lastCrash?.ts ?? null,
      lastExitAt: lastExit?.ts ?? null,
      lastRuntimeMs: lastExit?.runtimeMs ?? null,
      events: recent.slice(-EVENTS_IN_VIEW),
    }
  }

  dispose(): void {
    if (this.saveTimer !== null)
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
