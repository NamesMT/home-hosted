import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const root = fileURLToPath(new URL('../..', import.meta.url))
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

/**
 * The reads that must go through the decoder, kept honest by a scan.
 *
 * The rule is "every file this panel invites a person to hand-edit is read through `readStateFile`"
 * — but nothing enforced it, and three readers had drifted out of it: the installed
 * UI's `ui.json` (which the docs show a UI author writing), and `--print-config`'s two files. Each
 * failed the same way, silently: `null` instead of the config, which reads as "your file is broken".
 * Most of these files are JSON, but not all: an entry's `envFile` is `KEY=value`, and the same mark
 * turns every key into one carrying a NUL.
 *
 * The scan is a **list of files and the reason each is hand-editable**, not a blanket ban on
 * `readFileSync`: plenty of reads are of files this package alone writes (`run.json`, `package.json`,
 * `/proc/*`), where a BOM cannot appear. A new hand-editable file gets a line here — and if it is
 * read as UTF-8 in any spelling, this fails.
 */
describe('a hand-edited file goes through readStateFile', () => {
  /** Files a person or a UI author writes, and the file each is read in. */
  const HAND_EDITABLE: Array<{ file: string, why: string }> = [
    { file: 'src/services/ui.ts', why: 'ui.json is written by a UI author (docs/UI_CREATION.md)' },
    { file: 'src/index.ts', why: '--print-config reads settings.json and servers.config.json' },
    { file: 'src/config/settings.ts', why: 'settings.json is hand-edited' },
    { file: 'src/config/store.ts', why: 'servers.config.json is hand-edited' },
    { file: 'src/config/workspaces.ts', why: 'workspaces.json is hand-edited' },
    { file: 'src/config/secrets.ts', why: '.control-secrets.json is hand-editable by hand' },
    { file: 'src/helpers/env-file.ts', why: 'an entry\'s envFile is written by a person, not by this panel' },
  ]

  /**
   * Every read that decodes text as UTF-8, whichever spelling it uses.
   *
   * The matcher used to require `readFileSync(…, 'utf8')` exactly, and three other spellings of the
   * same read walked past it: an options object (`{ encoding: 'utf8' }`), a chained
   * `readFileSync(…).toString('utf8')`, and `readFileSync(…, 'utf-8')`. Each has already discarded
   * the bytes that tell UTF-16 from UTF-8, which is the whole failure — measured by planting each in
   * `ui.ts` and watching this file stay green.
   *
   * Anchored on the read rather than on an enclosing `JSON.parse`: the value is often handed to a
   * schema first (`uiMetaSchema(JSON.parse(…))`), and a matcher requiring `parse` to be outermost
   * passed while `ui.ts` was broken — measured, then corrected. The exclusion is the generated
   * `settings.schema.json`, which this package writes for editor autocomplete and a person never
   * edits, so no editor puts a BOM on it.
   */
  function utf8ReadsOf(source: string): string[] {
    // `[^)]*?` cannot cross a nested call, so `readFileSync(path.join(...), 'utf8')` — the shape
    // every one of these actually has — walked straight past the first version of this matcher.
    // Balanced-paren scan instead: from each `readFileSync(`, find its own closing paren.
    const out: Array<{ target: string, at: number }> = []
    for (const start of source.matchAll(/readFileSync\(/g)) {
      const open = start.index! + start[0].length - 1
      let depth = 0
      let close = open
      for (; close < source.length; close++) {
        if (source[close] === '(')
          depth += 1
        else if (source[close] === ')' && --depth === 0)
          break
      }
      const call = source.slice(open + 1, close)
      // The path is the first argument; a trailing `'utf8'`, `{ encoding: 'utf8' }` or a
      // `.toString('utf8')` chained onto the call all mean the same thing. Split the argument at its
      // own top-level comma — `path.join(dir, 'ui.json')` holds one — so the exclusion below still
      // sees the whole path it is matching.
      const target = firstArgument(call)
      const chained = /\.toString\(\s*'utf-?8'\s*\)/.test(source.slice(close, close + 20))
      if (!isUtf8Decoded(call, chained))
        continue
      out.push({ target, at: open + 1 })
    }
    return out
      // `writeSchema`/`writeJsonSchema` re-read the `.schema.json` they are about to regenerate, to
      // skip a no-op write. That file is this package's own output, so no editor puts a BOM on it.
      .filter(read => !inWriteSchema(source, read.at))
      // The package manifest is this package's own file, not one a person edits in this checkout's
      // editors; its BOM would be a bug in the release, not a Windows save.
      .filter(read => !/package\.json/.test(read.target))
      .map(read => read.target)
  }

  /** The first argument of a call, up to its own top-level comma. */
  function firstArgument(call: string): string {
    let depth = 0
    for (let index = 0; index < call.length; index++) {
      const character = call[index]
      if (character === '(' || character === '[' || character === '{')
        depth += 1
      else if (character === ')' || character === ']' || character === '}')
        depth -= 1
      else if (character === ',' && depth === 0)
        return call.slice(0, index).trim()
    }
    return call.trim()
  }

  /** Whether one `readFileSync(…)` call (or its own return) decodes the bytes as UTF-8. */
  function isUtf8Decoded(call: string, chained: boolean): boolean {
    // `readFileSync(file, 'utf8')` and `readFileSync(file, 'utf-8')`.
    if (/,\s*'utf-?8'\s*$/.test(call))
      return true
    // `readFileSync(file, { encoding: 'utf8' })`, and the bare `{ encoding }` shorthand is not
    // used here because the value would be a variable this scan cannot resolve.
    if (/,\s*\{[\s\S]*\bencoding\s*:\s*'utf-?8'[\s\S]*\}\s*$/.test(call))
      return true
    // `readFileSync(file).toString('utf8')`.
    return chained
  }

  /** Whether an offset sits inside a method that regenerates a `.schema.json` rather than reading a config. */
  function inWriteSchema(source: string, at: number): boolean {
    const start = Math.max(source.lastIndexOf('writeSchema(', at), source.lastIndexOf('writeJsonSchema(', at))
    if (start < 0)
      return false
    const end = source.indexOf('\n  }', start)
    return end < 0 || at < end
  }

  it('finds every file it claims to check', () => {
    for (const { file } of HAND_EDITABLE)
      expect(fs.existsSync(path.join(root, file)), `${file} must exist`).toBe(true)
  })

  /**
   * The shape that matters is `JSON.parse(readFileSync(…, 'utf8'))` — a *parse of hand-editable
   * input* — not any `utf8` read at all. `settings.ts` also reads its own generated
   * `settings.schema.json` to decide whether to rewrite it, and that file is this package's output,
   * never a person's edit, so a BOM cannot appear in it.
   */
  it('never parses one from a raw `utf8` read', () => {
    const offenders = HAND_EDITABLE
      .flatMap(({ file, why }) => utf8ReadsOf(fs.readFileSync(path.join(root, file), 'utf8')).map(read => `${file} (${read}) — ${why}`))
    expect(offenders, 'a `utf8` read has already destroyed the bytes that tell UTF-16 from UTF-8').toEqual([])
  })

  /**
   * The scanner must reach each spelling of the read it forbids, or the list of files above is the
   * only thing it checks and a new spelling reopens the hole.
   *
   * Every one of these was planted in `ui.ts` — a listed file — and this test file stayed green
   * before the matcher was widened: an options object, a chained `toString`, and `'utf-8'`.
   */
  it('still reaches every spelling of the read it forbids', () => {
    const shapes = [
      'const a = fs.readFileSync(file, \'utf8\')',
      'const a = fs.readFileSync(file, \'utf-8\')',
      'const a = fs.readFileSync(file, { encoding: \'utf8\' })',
      'const a = fs.readFileSync(path.join(dir, \'ui.json\')).toString(\'utf8\')',
    ]
    for (const source of shapes)
      expect(utf8ReadsOf(source), `the scan must see ${source}`).toHaveLength(1)

    // And a read through the decoder, or one with no encoding at all, is left alone.
    expect(utf8ReadsOf('const a = readStateFile(file)')).toEqual([])
    expect(utf8ReadsOf('const a = fs.readFileSync(file)')).toEqual([])
  })
})
