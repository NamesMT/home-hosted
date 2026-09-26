import type { LogLine } from '#src/shared/contracts'
import { logger } from '#src/helpers/logger'
import { LogTailer } from '#src/providers/log-tail'

/**
 * Live logs for persistent entries.
 *
 * A normal entry's output reaches the panel through the pipe the panel owns, so it is
 * pushed the moment the child writes. A persistent entry's output is written by its
 * nanny, so the panel has to *read* it back: this service watches the entries it was
 * asked to follow and hands new lines to the supervisor, which treats them exactly
 * like lines that came down a pipe.
 *
 * Polling rather than `fs.watch`: the file is rotated (renamed) under us, and a
 * watcher would have to be re-established on a path that briefly does not exist —
 * for a handful of stat+read calls four times a second, the simple thing wins.
 */

/** Fast enough that a live log reads as live; cheap enough to ignore. */
const TAIL_INTERVAL_MS = 250

export interface LogRelayOptions {
  onLines: (serverId: string, lines: LogLine[]) => void
  intervalMs?: number
}

export class LogRelay {
  private readonly followed = new Map<string, { file: string, tailer: LogTailer }>()
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly options: LogRelayOptions) {}

  /**
   * Idempotent: following the same file again keeps the position already read.
   *
   * With `backfill`, the last lines already on disk are returned *and* the live position
   * is set past them by the same tailer, so the caller can fill a buffer without a line
   * being both history and news. Without it, the live stream simply starts at the end.
   */
  follow(serverId: string, file: string, options: { backfill?: number } = {}): LogLine[] {
    if (this.closed)
      return []

    const current = this.followed.get(serverId)
    if (current !== undefined && current.file === file)
      return []

    const tailer = new LogTailer(file)
    const backfill = options.backfill ?? 0
    const history = backfill > 0 ? tailer.readTailLines(backfill) : []
    if (backfill <= 0)
      tailer.skipToEnd()

    this.followed.set(serverId, { file, tailer })
    this.start()
    return history
  }

  unfollow(serverId: string): void {
    this.followed.delete(serverId)
    if (this.followed.size === 0)
      this.stopTimer()
  }

  followedIds(): string[] {
    return [...this.followed.keys()]
  }

  dispose(): void {
    this.closed = true
    this.followed.clear()
    this.stopTimer()
  }

  private start(): void {
    if (this.timer !== null)
      return
    this.timer = setInterval(() => {
      // A throw here must not become an unhandled rejection: on Node 24 that ends the
      // panel, and this timer is what keeps every persistent entry's log flowing.
      try {
        this.poll()
      }
      catch (error) {
        logger.warn(`tail failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, this.options.intervalMs ?? TAIL_INTERVAL_MS)
    this.timer.unref()
  }

  private stopTimer(): void {
    if (this.timer !== null)
      clearInterval(this.timer)
    this.timer = null
  }

  private poll(): void {
    for (const [serverId, { tailer }] of this.followed) {
      const lines = tailer.read()
      if (lines.length > 0)
        this.options.onLines(serverId, lines)
    }
  }
}
