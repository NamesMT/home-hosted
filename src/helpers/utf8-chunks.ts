import type { Buffer } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'

/**
 * Decodes one byte stream's chunks as UTF-8, carrying a character split across two chunks.
 *
 * A pipe or a bounded read cuts wherever it likes, so `chunk.toString()` per chunk turned a `€`
 * straddling the cut into two U+FFFD. One decoder per stream, ended when the stream ends.
 */
export class Utf8Chunks {
  private decoder = new StringDecoder('utf8')

  write(chunk: string | Buffer): string {
    return typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
  }

  /** The stream ended: whatever incomplete bytes remain, rendered as U+FFFD. */
  end(): string {
    return this.decoder.end()
  }

  /** Drop held bytes without rendering them, e.g. when the source was replaced. */
  reset(): void {
    this.decoder = new StringDecoder('utf8')
  }
}
