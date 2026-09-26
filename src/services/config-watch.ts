import type { FSWatcher } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Tells the caller when the config file *may* have changed. Whether it really did
 * is the store's decision: it remembers the bytes it last read and the bytes it
 * wrote, so a save from the panel's own UI never reloads anything.
 *
 * The watch is on the file's directory, because that is what catches the common
 * edit — an editor writes a temporary file and renames it over the target, which
 * replaces the inode and would slip past a watch on the file itself. `fs.watch` is
 * not dependable on network mounts, so a slow poll backs it up: one small read
 * every couple of seconds costs nothing next to a state frame.
 */

export interface ConfigWatchOptions {
  /** The config file; its directory is what is actually watched. */
  file: string
  /** Called after a burst of changes settles. */
  onChange: () => void
  /** How long to wait for an editor to finish writing. */
  debounceMs?: number
  /** Backup poll interval in ms; 0 turns the poll off. */
  pollMs?: number
  /** A watch that cannot be established is reported; the poll still covers the file. */
  onError?: (error: unknown) => void
}

const DEFAULT_DEBOUNCE_MS = 150
const DEFAULT_POLL_MS = 2000

export class ConfigWatch {
  private readonly debounceMs: number
  private readonly pollMs: number
  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly options: ConfigWatchOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
  }

  start(): void {
    if (this.disposed || this.watcher !== null)
      return

    try {
      this.watcher = fs.watch(path.dirname(this.options.file), (_event, filename) => {
        // Only our file: the directory is shared with the logs, the secrets file and
        // whatever else home-hosted keeps beside its config. The name is compared by
        // basename because a platform may hand back a path, not the bare name — macOS
        // has been seen to — and an exact compare then drops the edit it was told about.
        if (filename !== null && path.basename(filename) !== path.basename(this.options.file))
          return
        this.schedule()
      })
      this.watcher.on('error', (error) => {
        // A watch can die with the mount it was opened on. Stop pretending it works
        // and let the poll carry the file.
        this.options.onError?.(error)
        this.closeWatcher()
      })
      this.watcher.unref()
    }
    catch (error) {
      this.options.onError?.(error)
    }

    if (this.pollMs > 0) {
      this.pollTimer = setInterval(() => this.check(), this.pollMs)
      this.pollTimer.unref()
    }
  }

  /** One check, exactly what the poll does — tests drive this instead of waiting. */
  check(): void {
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.closeWatcher()
  }

  /** One reload per burst: an editor writing in pieces is still one edit. */
  private schedule(): void {
    if (this.disposed || this.debounceTimer !== null)
      return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (!this.disposed)
        this.options.onChange()
    }, this.debounceMs)
    this.debounceTimer.unref()
  }

  private closeWatcher(): void {
    this.watcher?.close()
    this.watcher = null
  }
}
