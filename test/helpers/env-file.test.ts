/* eslint-disable no-template-curly-in-string */
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
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-env-'))
    dirs.push(dir)

    const missing = loadEnvFile(path.join(dir, 'nope.env'))
    expect(missing.env).toEqual({})
    expect(missing.error).toBeNull()
  })

  it('reads a real file and reports unreadable ones', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-env-'))
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
