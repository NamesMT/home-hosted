import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { Utf8Chunks } from '#src/helpers/utf8-chunks'

/**
 * A supervised child's stdout and stderr, as files instead of pipes.
 *
 * A child spawned with `stdio: ['ignore', 'pipe', 'pipe']` has the **panel** as the read end of its
 * two streams. Kill the panel and both pipes close, so the child's next `write` to stdout raises
 * `EPIPE` — and a process that writes anything at all, which is every server that logs a request,
 * dies of the signal it was supposed to outlive. `docs/SERVERS.md` promises the opposite.
 *
 * These descriptors are opened here and handed to the child, so the file belongs to the child: no
 * panel action closes it, and the panel reads the bytes back afterwards at its own pace. This module
 * is only the file half — the descriptors for the spawn, the poller that reads them back, and the
 * bounded-truncation policy. Splitting into `LogLine`s stays `LineSplitter`'s job, one per stream, and
 * everything downstream (`LogBuffer`, `LogFiles`, SSE) is unchanged.
 *
 * **They are transport, not history.** Nothing serves these files: `LogFiles` never sees them, the
 * Logs page never lists them, `logs.keep` does not bound them and no backup captures them. That is
 * why they live under the workspace's `.state/` beside the entry-state record rather than in
 * `.logs/` — `LogFiles.prune()` derives candidates from `<id>.log*` names in `.logs/`, and a raw
 * transport file there would be one refactor away from being treated as a rotation of the log a
 * person asked to keep.
 */

/** One poll reads at most this much, so a burst cannot stall the 1 Hz state frame. */
const MAX_BYTES_PER_POLL = 256 * 1024

/**
 * How often the files are read back.
 *
 * `log-relay.ts`'s 250 ms, for the same reason: fast enough that a live log reads as live, and it is
 * a stat plus one bounded read per entry, so polling is cheaper than a watcher that has to be
 * re-established every time a file is truncated.
 */
export const OUTPUT_POLL_MS = 250

/** The two files of one entry's run. */
export interface OutputFiles {
  stdout: string
  stderr: string
}

const STREAMS = ['stdout', 'stderr'] as const
type Stream = typeof STREAMS[number]

/**
 * `<id>.out` / `<id>.err` in the workspace state directory.
 *
 * Two files rather than one: the stream label then needs no parsing, ordering within each stream is
 * the child's own, and one `LineSplitter` per file keeps the same "a half-written stdout line must
 * not absorb stderr's" guarantee the pipe path had.
 */
export function outputFiles(stateDir: string, id: string): OutputFiles {
  return {
    stdout: path.join(stateDir, `${id}.out`),
    stderr: path.join(stateDir, `${id}.err`),
  }
}

/** Descriptors for `spawn`, plus the paths they came from. */
export interface OpenedOutput {
  files: OutputFiles
  fds: Record<Stream, number>
}

/**
 * Creates both files and returns the descriptors to hand the child.
 *
 * A previous run's bytes are dropped: they belong to a process that is gone, and the fresh reader
 * would otherwise serve an old run's output as the new one's. `'a'` is load-bearing, not style — an
 * `O_APPEND` descriptor is what makes the truncation below land the child's next write at position 0
 * instead of at a stale offset, which would leave a run of NUL bytes at the head of the file.
 */
export function openOutput(files: OutputFiles): OpenedOutput {
  fs.mkdirSync(path.dirname(files.stdout), { recursive: true })
  const fds = {} as Record<Stream, number>
  for (const stream of STREAMS) {
    const fd = fs.openSync(files[stream], 'a', 0o600)
    fds[stream] = fd
    try {
      fs.ftruncateSync(fd, 0)
    }
    catch {
      // A file that cannot be emptied still appends; the reader starts at its head either way.
    }
  }
  return { files, fds }
}

/**
 * Closes the panel's own copies of the descriptors.
 *
 * The child has its own, duplicated across the spawn, so closing these cannot affect it — and leaving
 * them open would leak one pair per restart.
 */
export function closeOutput(open: OpenedOutput): void {
  for (const stream of STREAMS) {
    try {
      fs.closeSync(open.fds[stream])
    }
    catch {
      // Already closed.
    }
  }
}

/** Removes both files, once the process that wrote them is known gone. */
export function removeOutputFiles(files: OutputFiles): void {
  for (const stream of STREAMS) {
    try {
      fs.rmSync(files[stream], { force: true })
    }
    catch {
      // Already gone.
    }
  }
}

/** One file's read position and decoder. */
interface StreamState {
  offset: number
  fd: number | null
  /** One byte stream: a bounded read can end inside a multibyte character. */
  decoder: Utf8Chunks
}

/**
 * Reads one entry's two output files back as decoded text.
 *
 * `onText` receives text, not lines: `LineSplitter` already owns "split on newline, carry the
 * fragment" for the pipe path, and keeping that one implementation means the CRLF rule and the
 * oversized-line cap cannot drift between the two transports.
 *
 * The four conditions a writer imposes on a reader are all handled here: the file may not exist on
 * the first poll; bytes may end mid-character (the decoder carries them); a line may end mid-write
 * (`LineSplitter` carries it); and the file may shrink under the reader.
 */
export class EntryOutput {
  private readonly state: Record<Stream, StreamState> = {
    stdout: { offset: 0, fd: null, decoder: new Utf8Chunks() },
    stderr: { offset: 0, fd: null, decoder: new Utf8Chunks() },
  }

  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(
    private readonly files: OutputFiles,
    private readonly options: {
      /** The bound above which a drained file is emptied. Read per poll, so a settings change lands. */
      capBytes: () => number
      onText: (stream: Stream, text: string) => void
      /**
       * The reader fell behind a writer faster than it can drain, and had to give up its backlog.
       *
       * Called with the bytes thrown away, so the caller can say so in the entry's own log. A bound
       * that discards silently is the failure this whole module is named against.
       */
      onDropped?: (stream: Stream, bytes: number) => void
      intervalMs?: number
    },
  ) {}

  start(): void {
    if (this.timer !== null || this.closed)
      return
    this.timer = setInterval(() => this.poll(), this.options.intervalMs ?? OUTPUT_POLL_MS)
    // Never hold the process open: a panel that is stopping must not wait for a poll.
    this.timer.unref()
    this.poll()
  }

  /**
   * Drains what is left and releases the descriptors.
   *
   * The drain matters: a child's last words before a crash are exactly the lines still sitting in the
   * file when its `exit` lands, and losing them makes a crash report say nothing useful.
   */
  stop(): void {
    if (this.closed)
      return
    this.poll()
    this.closed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const stream of STREAMS) this.closeStream(this.state[stream])
  }

  /** One read pass over both files. Public so a test can drive it without waiting on the timer. */
  poll(): void {
    if (this.closed)
      return
    for (const stream of STREAMS) this.pollStream(stream)
  }

  private pollStream(stream: Stream): void {
    const state = this.state[stream]
    const file = this.files[stream]
    if (state.fd === null && !this.openStream(state, file))
      return

    let size: number
    try {
      size = fs.fstatSync(state.fd!).size
    }
    catch {
      this.closeStream(state)
      return
    }

    // The file shrank under us: something emptied it, so the byte it is about to be read from is not
    // the byte we stopped at. Start over, and drop any half-seen character with the bytes that would
    // have completed it. (Our *own* truncation below never lands here: it resets the offset too.)
    if (size < state.offset) {
      state.offset = 0
      state.decoder.reset()
    }

    const cap = this.options.capBytes()

    /**
     * The writer is outrunning the reader: the unread backlog has outgrown both the cap and a whole
     * poll's read budget, so it cannot be drained even by reading flat out.
     *
     * A `setInterval` callback is one synchronous pass of at most `MAX_BYTES_PER_POLL`, so a child
     * that writes faster than that forever has a backlog no amount of polling removes — and the file
     * grows without bound, which is the disk leak this cap exists to prevent. The oldest unread bytes
     * go, and the caller is told how many. Discarding nothing ends with a full disk.
     *
     * Both conditions matter. `> cap` alone would fire on any single write larger than a small cap,
     * discarding a line the reader was about to read in full; `> MAX_BYTES_PER_POLL` alone would
     * ignore a backlog that is over the cap but still catchable in a poll or two.
     *
     * The drop lands on a **line boundary** wherever one exists ahead of it, so what is lost is whole
     * lines rather than half of one: a torn line reads as corruption, where a gap reads as a gap.
     */
    const behindThreshold = Math.max(cap, MAX_BYTES_PER_POLL)
    if (size - state.offset > behindThreshold) {
      const target = size - Math.floor(cap / 2)
      const aligned = this.skipToLineStart(state, target, size)
      const dropped = aligned - state.offset
      if (dropped > 0) {
        state.offset = aligned
        // The bytes that would have completed a held character are inside the discarded range.
        state.decoder.reset()
        this.options.onDropped?.(stream, dropped)
      }
    }

    if (size > state.offset) {
      const want = Math.min(MAX_BYTES_PER_POLL, size - state.offset)
      const buffer = Buffer.allocUnsafe(want)
      let filled = 0
      try {
        while (filled < want) {
          const bytes = fs.readSync(state.fd!, buffer, filled, want - filled, state.offset + filled)
          if (bytes <= 0)
            break
          filled += bytes
        }
      }
      catch {
        this.closeStream(state)
        return
      }
      if (filled > 0) {
        state.offset += filled
        const text = state.decoder.write(buffer.subarray(0, filled))
        if (text.length > 0)
          this.options.onText(stream, text)
      }
    }

    /**
     * Drained and still over the cap: empty it. Checked **after** the read, not before, so it holds
     * for a child that writes continuously — checked before, the file could only ever be emptied on a
     * poll that happened to catch it already drained, which a steady writer never leaves.
     *
     * Nothing is lost: every byte has been read, so the only state that survives is what the consumer
     * already holds (`LineSplitter`'s half-written line, the decoder's half-character), and the
     * child's next write continues exactly that sequence. See `truncate`.
     */
    if (state.offset >= this.currentSize(state) && state.offset > cap)
      this.truncate(state)
  }

  /** The file's size now, or the offset when it cannot be read (so the caller does not truncate). */
  private currentSize(state: StreamState): number {
    if (state.fd === null)
      return 0
    try {
      return fs.fstatSync(state.fd).size
    }
    catch {
      return state.offset
    }
  }

  /**
   * The first byte after a newline at or after `from`, or `from` itself when there is none before
   * `size` — a backlog that is one enormous unterminated line has no boundary to respect, and
   * dropping bytes from it is the only way to bound it.
   */
  private skipToLineStart(state: StreamState, from: number, size: number): number {
    if (state.fd === null)
      return from
    const window = Math.min(MAX_BYTES_PER_POLL, size - from)
    if (window <= 0)
      return from
    const buffer = Buffer.allocUnsafe(window)
    try {
      const bytes = fs.readSync(state.fd, buffer, 0, window, from)
      const newline = buffer.subarray(0, bytes).indexOf(0x0A)
      return newline === -1 ? from : from + newline + 1
    }
    catch {
      return from
    }
  }

  /**
   * Empties a drained file that has outgrown the cap, and starts reading from its head again.
   *
   * Safe to do at all only because the child's descriptor is `O_APPEND`: its next write lands at
   * position 0 rather than at the offset it had reached, so no NUL gap appears.
   *
   * **Lossless for the byte stream.** The reader has consumed every byte, so the only state that
   * survives a truncation is what the consumer already holds — `LineSplitter`'s half-written line and
   * the decoder's half-character — and the child's *next* write continues exactly that sequence.
   * Neither is reset here: dropping them is what would tear a line or a character in half.
   *
   * **The one race, stated plainly:** a byte the child writes between the `fstat` in `pollStream` and
   * this `truncateSync` is destroyed unread. It is one small window, once per `capBytes` (8 MB by
   * default) of output, and it can only bite a child writing at the instant its file is emptied.
   * Closing it would need the child to acknowledge a truncation, which is more machinery than the
   * failure is worth — and the alternative, an unbounded file, is worse.
   */
  private truncate(state: StreamState): void {
    const file = state.fd === null ? null : this.fileOf(state)
    if (file !== null) {
      try {
        // By path, not by descriptor: this must act on the file the child appends to.
        fs.truncateSync(file, 0)
      }
      catch {
        // It vanished or cannot be written; the next poll reopens it and reads from 0.
      }
    }
    state.offset = 0
  }

  /** Which file a state belongs to, so `truncate` never has to guess from a descriptor. */
  private fileOf(state: StreamState): string {
    return state === this.state.stdout ? this.files.stdout : this.files.stderr
  }

  private openStream(state: StreamState, file: string): boolean {
    let fd: number
    try {
      fd = fs.openSync(file, 'r')
    }
    catch {
      // Not created yet (the child has not been spawned), or gone between two polls.
      return false
    }
    state.fd = fd
    state.offset = 0
    return true
  }

  private closeStream(state: StreamState): void {
    if (state.fd === null)
      return
    try {
      fs.closeSync(state.fd)
    }
    catch {
      // Already closed.
    }
    state.fd = null
  }
}
