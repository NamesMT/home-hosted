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

    for (const file of this.rotateTargets(serverId)) {
      try {
        const stats = fs.statSync(file)
        files.push({ name: path.basename(file), sizeBytes: stats.size })
        if (file === this.currentPath(serverId))
          sizeBytes = stats.size
      }
      catch {
        // Not rotated there yet.
      }
    }

    return { enabled: config.persist, sizeBytes, files }
  }

  /** Reads the last `tail` lines, newest file first, padding from one rotation back. */
  readTail(serverId: string, tail: number): LogLine[] {
    const sources = [this.currentPath(serverId), this.rotatedPath(serverId, 1)]
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
    for (const file of this.rotateTargets(serverId)) {
      try {
        fs.rmSync(file, { force: true })
      }
      catch {
        // Nothing to remove.
      }
    }
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

  private rotate(serverId: string): void {
    const { keep } = this.getConfig()
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
      const length = Math.min(size, READ_CHUNK_BYTES)
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, size - length)

      const text = buffer.toString('utf8')
      // A mid-file cut can leave a partial first line, which is dropped.
      const raw = text.split('\n').filter(entry => entry.trim().length > 0)
      const parsed: LogLine[] = []
      for (const entry of raw.slice(size > length ? 1 : 0)) {
        try {
          parsed.push(JSON.parse(entry) as LogLine)
        }
        catch {
          // Partial line from a rotation boundary.
        }
      }
      return parsed.slice(-tail)
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

  private rotateTargets(serverId: string): string[] {
    const { keep } = this.getConfig()
    const targets = [this.currentPath(serverId)]
    for (let index = 1; index <= keep; index++) targets.push(this.rotatedPath(serverId, index))
    return targets
  }
}
