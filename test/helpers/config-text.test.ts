import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeStateFile, readStateFile } from '#src/helpers/config-text'

/**
 * Every file the panel invites a person to hand-edit is JSON, and the editors that write one
 * on Windows prepend a byte-order mark: PowerShell 5.1's `Set-Content -Encoding UTF8`, and
 * `Out-File`/`>` which write UTF-16LE. `JSON.parse` refuses the mark, so the panel reported a
 * file whose JSON was fine as "cannot parse" — an error naming an invisible character, on the
 * one platform whose editors recreate it on every save.
 *
 * These pin the decoder, not a call site: a new hand-editable file that reads with
 * `readFileSync(file, 'utf8')` reopens the defect, so the readers use `readStateFile`.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-config-text-'))
  dirs.push(dir)
  return dir
}

const BODY = '{\n  "servers": []\n}'
const UTF8_BOM = [0xEF, 0xBB, 0xBF]
const UTF16LE_BOM = [0xFF, 0xFE]
const UTF16BE_BOM = [0xFE, 0xFF]

/** UTF-16BE has no Node decoder, so the fixture is written by swapping an LE buffer. */
function utf16be(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf16le')
  bytes.swap16()
  return bytes
}

describe('decodeStateFile', () => {
  it('reads a plain UTF-8 file unchanged', () => {
    expect(decodeStateFile(Buffer.from(BODY, 'utf8'))).toBe(BODY)
  })

  it('strips a UTF-8 byte-order mark', () => {
    const bytes = Buffer.concat([Buffer.from(UTF8_BOM), Buffer.from(BODY, 'utf8')])
    expect(decodeStateFile(bytes)).toBe(BODY)
    expect(JSON.parse(decodeStateFile(bytes))).toEqual({ servers: [] })
  })

  it('decodes UTF-16LE, which `>` and Out-File write on Windows', () => {
    const bytes = Buffer.concat([Buffer.from(UTF16LE_BOM), Buffer.from(BODY, 'utf16le')])
    expect(decodeStateFile(bytes)).toBe(BODY)
  })

  it('decodes UTF-16BE', () => {
    const bytes = Buffer.concat([Buffer.from(UTF16BE_BOM), utf16be(BODY)])
    expect(decodeStateFile(bytes)).toBe(BODY)
  })

  it('leaves a mark inside the content alone, so a real U+FEFF is not silently eaten', () => {
    // Only a mark in the first position is a byte-order mark. A quoted value that starts
    // with U+FEFF is content, and stripping it would change what the person wrote.
    const body = '{"label":"a"}'
    const withInner = body.replace('a', '\uFEFFa')
    expect(decodeStateFile(Buffer.from(withInner, 'utf8'))).toBe(withInner)
  })

  it('still fails on content that is not JSON, so the mark is not a blanket rescue', () => {
    const bytes = Buffer.concat([Buffer.from(UTF8_BOM), Buffer.from('{ not json', 'utf8')])
    expect(() => JSON.parse(decodeStateFile(bytes))).toThrow()
  })

  it('keeps CRLF line endings intact, so a Windows-saved file is byte-faithful apart from the mark', () => {
    const crlf = '{\r\n  "servers": []\r\n}\r\n'
    const bytes = Buffer.concat([Buffer.from(UTF8_BOM), Buffer.from(crlf, 'utf8')])
    expect(decodeStateFile(bytes)).toBe(crlf)
  })
})

describe('readStateFile', () => {
  it('reads a BOM-prefixed file from disk', () => {
    const file = path.join(scratch(), 'servers.config.json')
    fs.writeFileSync(file, Buffer.concat([Buffer.from(UTF8_BOM), Buffer.from(BODY, 'utf8')]))
    expect(JSON.parse(readStateFile(file))).toEqual({ servers: [] })
  })

  it('still throws ENOENT for a missing file, which callers branch on', () => {
    expect(() => readStateFile(path.join(scratch(), 'absent.json'))).toThrow(/ENOENT/)
  })
})
