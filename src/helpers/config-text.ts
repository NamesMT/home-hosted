import { Buffer } from 'node:buffer'
import fs from 'node:fs'

/**
 * Decodes a hand-editable state file the way the editors that write them save it.
 *
 * Every file the panel invites a person to hand-edit is JSON, and `JSON.parse` refuses a
 * **byte-order mark**: PowerShell's `Set-Content -Encoding UTF8` (5.1) and `Out-File`/`>`
 * (UTF-16LE) both prepend one, and Notepad writes one for a "UTF-8 with BOM" save. The
 * refusal is a parse error naming an invisible character — `Unexpected token '\uFEFF'` — so the
 * person is told their JSON is broken when it is not, and is invited to
 * fix a file the editor will re-encode identically on the next save.
 *
 * Stripping the mark is not a silent coercion: a BOM is not content, and a file whose real
 * content is unchanged parses to the same object with or without it. UTF-16 is decoded rather
 * than refused because that is what `>` produces on Windows, and it is recognisable from its
 * own prefix — a wrong guess would still fail loudly on `JSON.parse`.
 *
 * Read as a `Buffer`, never with `'utf8'`: a `'utf8'` read of UTF-16LE text has already lost
 * the information this needs to tell them apart.
 */
export function decodeStateFile(bytes: Buffer): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE)
      return stripBom(bytes.subarray(2).toString('utf16le'))
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      // UTF-16BE: swap into LE, the only order Node decodes.
      const swapped = Buffer.from(bytes.subarray(2))
      swapped.swap16()
      return stripBom(swapped.toString('utf16le'))
    }
  }
  return stripBom(bytes.toString('utf8'))
}

/** A UTF-8 BOM is three bytes; Node decodes it to the one `\uFEFF` character. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/** `decodeStateFile` for a path. Missing files still throw `ENOENT`, as a caller expects. */
export function readStateFile(file: string): string {
  return decodeStateFile(fs.readFileSync(file))
}
