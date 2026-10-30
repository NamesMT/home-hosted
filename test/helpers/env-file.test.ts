/* eslint-disable no-template-curly-in-string */
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandEnv, expandEnvList, expandEnvRecord, loadEnvFile, parseEnvFile } from '#src/helpers/env-file'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe('parseEnvFile', () => {
  it('reads plain, exported, quoted and commented lines', () => {
    const env = parseEnvFile([
      '# a comment',
      'PLAIN=value',
      'export EXPORTED=other',
      'QUOTED="with spaces"',
      'SINGLE=\'single\'',
      '',
      'EMPTY=',
      'not-an-assignment',
    ].join('\n'))

    expect(env).toEqual({
      PLAIN: 'value',
      EXPORTED: 'other',
      QUOTED: 'with spaces',
      SINGLE: 'single',
      EMPTY: '',
    })
  })

  it('keeps the rest of a line that contains an equals sign', () => {
    expect(parseEnvFile('TOKEN=abc=def==').TOKEN).toBe('abc=def==')
  })
})

describe('loadEnvFile', () => {
  it('treats a missing file as an empty layer, not an error', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-env-'))
    dirs.push(dir)

    const missing = loadEnvFile(path.join(dir, 'nope.env'))
    expect(missing.env).toEqual({})
    expect(missing.error).toBeNull()
  })

  /**
   * An env file is hand-edited, so it arrives with whatever mark the editor wrote.
   *
   * `docs/SERVERS.md` calls it the machine-local layer and the panel never writes one — a person
   * writes it in Notepad or PowerShell. `Out-File`/`>` on Windows write **UTF-16LE** with `FF FE`,
   * and reading that as `'utf8'` yields `"\uFFFD\u0000T\u0000O\u0000K\u0000E\u0000N\u0000"` for a
   * key: every key carries a NUL, so `resolveSpawn` drops it as "an environment key containing a
   * null byte" and the process starts without the secret the file exists to keep out of the config.
   */
  it('reads a file a Windows editor saved as UTF-16 or with a byte-order mark', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-env-'))
    dirs.push(dir)

    const utf16 = path.join(dir, 'utf16.env')
    await fs.promises.writeFile(utf16, Buffer.concat([
      Buffer.from([0xFF, 0xFE]),
      Buffer.from('TOKEN=s3cret\nPORT=8080\n', 'utf16le'),
    ]))
    expect(loadEnvFile(utf16).env).toEqual({ TOKEN: 's3cret', PORT: '8080' })

    // `Set-Content -Encoding UTF8` on PowerShell 5.1 prepends a UTF-8 mark.
    const marked = path.join(dir, 'marked.env')
    await fs.promises.writeFile(marked, Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from('TOKEN=s3cret\n', 'utf8'),
    ]))
    expect(loadEnvFile(marked).env).toEqual({ TOKEN: 's3cret' })
  })

  it('reads a real file and reports unreadable ones', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-env-'))
    dirs.push(dir)

    const file = path.join(dir, 'app.env')
    await fs.promises.writeFile(file, 'A=1\nB=2\n')
    expect(loadEnvFile(file).env).toEqual({ A: '1', B: '2' })

    const asDirectory = loadEnvFile(dir)
    expect(asDirectory.error).not.toBeNull()
  })
})

describe('expandEnv', () => {
  it('expands known references and leaves unknown ones visible', () => {
    expect(expandEnv('token=${TOKEN}', { TOKEN: 'secret' })).toBe('token=secret')
    expect(expandEnv('token=${MISSING}', {})).toBe('token=${MISSING}')
  })

  it('expands repeatedly and inside larger strings', () => {
    expect(expandEnv('${A}-${A}-${B}', { A: '1', B: '2' })).toBe('1-1-2')
    expect(expandEnv('--flag=${FLAG}', { FLAG: 'x' })).toBe('--flag=x')
  })

  it('does not treat shell-ish or template placeholders as env references', () => {
    expect(expandEnv('{port}', { port: '8080' })).toBe('{port}')
    expect(expandEnv('$TOKEN', { TOKEN: 'secret' })).toBe('$TOKEN')
  })

  it('is case sensitive for the variable name', () => {
    expect(expandEnv('${token}', { TOKEN: 'secret' })).toBe('${token}')
  })

  it('maps over records and lists', () => {
    expect(expandEnvRecord({ A: '${X}' }, { X: '1' })).toEqual({ A: '1' })
    expect(expandEnvList(['${X}', 'plain'], { X: '1' })).toEqual(['1', 'plain'])
  })
})
