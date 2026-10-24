import type { LogLine, LogsConfig } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Append-only JSONL per server, one line per log entry, rotated by size.
 *
 * JSONL keeps the tail readable without parsing a stream, and appending needs no
 * rewrite of the existing file. Writes are batched on a short timer so a chatty
 * child cannot turn into a syscall per line.
 */
const FLUSH_INTERVAL_MS = 250
const MAX_PENDING_LINES = 500
const READ_CHUNK_BYTES = 256 * 1024

export interface LogFileInfo {
  name: string
  sizeBytes: number
}

export class LogFiles {
  private readonly pending = new Map<string, LogLine[]>()
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(
    private readonly dir: string,
    private readonly getConfig: () => LogsConfig,
  ) {}

  get directory(): string {
    return this.dir
  }

  /** The retention a nanny has to apply itself, on the same files. */
  get config(): LogsConfig {
    return this.getConfig()
  }

  append(serverId: string, line: LogLine): void {
    if (this.closed || !this.getConfig().persist)
      return

    const bucket = this.pending.get(serverId) ?? []
    bucket.push(line)
    this.pending.set(serverId, bucket)

    if (bucket.length >= MAX_PENDING_LINES) {
      this.flush()
      return
    }
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_INTERVAL_MS)
    this.timer.unref()
  }

  flush(): void {
    if (this.pending.size === 0)
      return

    const batches = [...this.pending.entries()]
    this.pending.clear()

    for (const [serverId, lines] of batches) {
      try {
        this.write(serverId, lines)
      }
      catch {
        // Logging must never take the control plane down.
      }
    }
  }

  info(serverId: string): { enabled: boolean, sizeBytes: number, files: LogFileInfo[] } {
    const config = this.getConfig()
    const files: LogFileInfo[] = []
    let sizeBytes = 0

    if (!config.persist)
      return { enabled: false, sizeBytes, files }

    for (const file of this.retained(serverId)) {
      try {
        const stats = fs.statSync(file)
        files.push({ name: path.basename(file), sizeBytes: stats.size })
        // The whole retained set, not just the newest file: this is summed into the page's
        // "on disk" total, and a server whose current file had just rotated read as nearly
        // empty while its rotations sat beside it.
        sizeBytes += stats.size
      }
      catch {
        // Not there yet.
      }
    }

    return { enabled: config.persist, sizeBytes, files }
  }

  /**
   * Reads the last `tail` lines, newest file first, padding from the rotations behind it.
   *
   * With `persist` off there is nothing this panel is willing to serve, even though a
   * persistent entry's nanny still writes its file: that file is the log's transport —
   * there is no pipe to carry it — and `persist` decides what counts as history.
   *
   * Every *retained* file is a source, not just `.1`: `keep` is the number of rotations the
   * person asked to keep, so a 5000-line window over a 10 MB rotation could not be filled by
   * the current file and `.1` alone. It read two of eleven files and returned "no matches" for
   * a line that was on disk — a search that answers "nothing found" while the log holds the
   * match is worse than a shorter window.
   */
  readTail(serverId: string, tail: number): LogLine[] {
    if (!this.getConfig().persist)
      return []

    // Oldest first, so `unshift` walks it backwards into reading order.
    const sources = this.retained(serverId)
    const lines: LogLine[] = []

    for (const file of sources) {
      if (lines.length >= tail)
        break
      const chunk = this.readTailChunk(file, tail - lines.length)
      lines.unshift(...chunk)
    }

    return lines.slice(-tail)
  }

  clear(serverId: string): void {
    // The batch that has not been flushed yet is still this server's, and `flush()` would write it
    // straight back — so the lines a delete was meant to remove reappeared a moment later.
    this.pending.delete(serverId)
    // Every file this id has, not the ones `keep` would name: lowering `keep` leaves rotations
    // numbered above it, and those are still this server's bytes. Deleting "all the logs" and
    // leaving five files behind is the worst version of this bug, because nothing lists them.
    for (const file of this.ownedFiles(serverId)) {
      try {
        fs.rmSync(file, { force: true })
      }
      catch {
        // Nothing to remove.
      }
    }
  }

  /**
   * Drops rotations above the current `keep`, for every server, now.
   *
   * `rotate` prunes too, but it only runs when a file fills — which on a quiet entry can be days
   * after the person lowered the ceiling. A retention setting that takes effect "eventually, once
   * the server is chatty enough" is not the promise the page makes, so the settings save calls
   * this directly.
   */
  prune(): void {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    }
    catch {
      return
    }

    const ids = new Set<string>()
    for (const name of names) {
      // `<id>.log` or `<id>.log.<n>`; the id charset has no dot, so the first dot ends it.
      const dot = name.indexOf('.log')
      if (dot > 0 && (name.length === dot + 4 || name.startsWith('.log.', dot)))
        ids.add(name.slice(0, dot))
    }
    for (const id of ids) this.pruneServer(id)
  }

  dispose(): void {
    this.closed = true
    if (this.timer !== null)
      clearTimeout(this.timer)
    this.timer = null
    this.flush()
  }

  private write(serverId: string, lines: LogLine[]): void {
    const { maxBytes } = this.getConfig()
    const file = this.currentPath(serverId)
    fs.mkdirSync(this.dir, { recursive: true })

    // A batch is split at the size limit: writing it whole would sail past
    // maxBytes long before the next rotation check runs.
    let encoded: string[] = []
    let bytes = 0

    const commit = (): void => {
      if (encoded.length === 0)
        return
      const payload = `${encoded.join('\n')}\n`
      const currentSize = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (currentSize + Buffer.byteLength(payload) > maxBytes)
        this.rotate(serverId)
      fs.appendFileSync(this.currentPath(serverId), payload)
      encoded = []
      bytes = 0
    }

    for (const line of lines) {
      const json = JSON.stringify(line)
      const size = Buffer.byteLength(json) + 1
      if (bytes > 0 && bytes + size > maxBytes)
        commit()
      encoded.push(json)
      bytes += size
    }

    commit()
  }

  /**
   * Drops this id's rotations numbered above `keep`.
   *
   * They are left over from a higher ceiling (or an older release). Renaming up only ever shifts
   * them further out of reach, so they have to be removed outright: a retention setting is a
   * promise about the directory, not about a rename loop.
   */
  private pruneServer(serverId: string): void {
    const { keep } = this.getConfig()
    const current = this.currentPath(serverId)
    for (const file of this.ownedFiles(serverId)) {
      if (file === current)
        continue
      const index = Number(file.slice(current.length + 1))
      if (!Number.isInteger(index) || index <= keep)
        continue
      try {
        fs.rmSync(file, { force: true })
      }
      catch {
        // Already gone.
      }
    }
  }

  private rotate(serverId: string): void {
    const { keep } = this.getConfig()
    this.pruneServer(serverId)
    for (let index = keep - 1; index >= 1; index--) {
      const from = this.rotatedPath(serverId, index)
      if (!fs.existsSync(from))
        continue
      fs.renameSync(from, this.rotatedPath(serverId, index + 1))
    }
    if (fs.existsSync(this.currentPath(serverId))) {
      fs.renameSync(this.currentPath(serverId), this.rotatedPath(serverId, 1))
    }
  }

  /**
   * The last `tail` parseable lines of one file.
   *
   * Reads backwards, growing the window until it has enough lines. It used to read exactly one
   * fixed chunk, which silently truncated: a JSONL line here is a couple of hundred bytes, so
   * one 256 KB chunk holds roughly 1500 of them, while the route accepts `tail=5000`. Asking
   * for 5000 returned 1464 and dropped 3536 lines with no error — the oldest line handed back
   * was not the oldest asked for.
   */
  private readTailChunk(file: string, tail: number): LogLine[] {
    let handle: number
    try {
      handle = fs.openSync(file, 'r')
    }
    catch {
      return []
    }

    try {
      const size = fs.fstatSync(handle).size
      if (size === 0)
        return []

      let start = Math.max(0, size - READ_CHUNK_BYTES)
      let parsed: LogLine[] = []

      // One extra loop's worth of margin, because a partial line at the window's start is
      // dropped and a line can be long: growing beats guessing the exact byte count.
      while (true) {
        const length = size - start
        const buffer = Buffer.alloc(length)
        fs.readSync(handle, buffer, 0, length, start)

        // A mid-file cut leaves a partial first line. A JSONL log is one object per line, so a
        // fragment cannot parse and the loop below skips it — but the whole-file case has no
        // fragment, which is what `start > 0` distinguishes.
        const raw = buffer.toString('utf8').split('\n')
        parsed = []
        for (const entry of start > 0 ? raw.slice(1) : raw) {
          if (entry.trim().length === 0)
            continue
          try {
            parsed.push(JSON.parse(entry) as LogLine)
          }
          catch {
            // A partial line, or a torn write at the file's end.
          }
        }

        if (parsed.length >= tail || start === 0)
          return parsed.slice(-tail)

        start = Math.max(0, start - READ_CHUNK_BYTES)
      }
    }
    finally {
      fs.closeSync(handle)
    }
  }

  private currentPath(serverId: string): string {
    return path.join(this.dir, `${serverId}.log`)
  }

  private rotatedPath(serverId: string, index: number): string {
    return path.join(this.dir, `${serverId}.log.${index}`)
  }

  /**
   * Every file this id owns on disk, newest first, found by reading the directory.
   *
   * The count comes from the directory rather than from `keep` because the two disagree the
   * moment a person lowers it: `rotate` only renames *up* to the new ceiling, so it never removes
   * the rotations numbered above it. Those files stayed, were invisible to `info()`, were served
   * by no reader, and survived a `clear` — growth the retention setting promised to bound, in
   * files nothing would ever show. Reading the directory is also what makes them prunable.
   */
  private ownedFiles(serverId: string): string[] {
    const current = this.currentPath(serverId)
    const prefix = `${serverId}.log.`
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    }
    catch {
      return fs.existsSync(current) ? [current] : []
    }

    // `.log.1`, `.log.2`, … in numeric order — a plain string sort puts `.10` before `.2`.
    const rotated = names
      .filter(name => name.startsWith(prefix))
      .map(name => ({ name, index: Number(name.slice(prefix.length)) }))
      .filter(entry => Number.isInteger(entry.index) && entry.index >= 1)
      .sort((a, b) => a.index - b.index)
      .map(entry => path.join(this.dir, entry.name))

    // Newest first, which is the order `info()` lists and the order a tail walks.
    return fs.existsSync(current) ? [current, ...rotated] : rotated
  }

  /**
   * The files `keep` still covers, newest first — what `info` lists and what a tail may read.
   *
   * The current file is always first and never counted against `keep`, which is what the UI
   * promises ("before rolling to .1, .2, …").
   */
  private retained(serverId: string): string[] {
    const { keep } = this.getConfig()
    const owned = this.ownedFiles(serverId)
    if (owned.length === 0)
      return []
    const [current, ...rotated] = owned
    // `rotated` is ascending from `.1`, so the first `keep` of it are the newest rotations.
    const covered = rotated.slice(0, keep)
    return current === undefined ? covered : [current, ...covered]
  }
}
