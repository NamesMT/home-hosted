import type { LogLine, LogsConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { LogFiles } from '#src/services/log-files'
import { logsSchema } from '#src/shared/contracts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeLogs(overrides: Partial<LogsConfig> = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-logs-'))
  dirs.push(dir)

  const parsed = logsSchema({ ...overrides })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)

  const files = new LogFiles(path.join(dir, 'logs'), () => parsed)
  return { files, dir }
}

function line(text: string, stream: LogLine['stream'] = 'stdout'): LogLine {
  return { ts: 1700000000000, stream, text }
}

describe('log files', () => {
  it('appends and tails what was written', async () => {
    const { files } = await makeLogs()
    files.append('web', line('first'))
    files.append('web', line('second', 'stderr'))
    files.flush()

    const lines = files.readTail('web', 10)
    expect(lines.map(entry => entry.text)).toEqual(['first', 'second'])
    expect(lines[1]?.stream).toBe('stderr')
  })

  it('keeps servers in separate files', async () => {
    const { files } = await makeLogs()
    files.append('a', line('from a'))
    files.append('b', line('from b'))
    files.flush()

    expect(files.readTail('a', 10).map(entry => entry.text)).toEqual(['from a'])
    expect(files.readTail('b', 10).map(entry => entry.text)).toEqual(['from b'])
  })

  it('only returns the requested tail', async () => {
    const { files } = await makeLogs()
    for (let index = 0; index < 20; index++) files.append('web', line(`line ${index}`))
    files.flush()

    const lines = files.readTail('web', 5)
    expect(lines.map(entry => entry.text)).toEqual(['line 15', 'line 16', 'line 17', 'line 18', 'line 19'])
  })

  it('does not write anything when persistence is off', async () => {
    const { files } = await makeLogs({ persist: false })
    files.append('web', line('ignored'))
    files.flush()

    expect(files.readTail('web', 10)).toEqual([])
    expect(files.info('web').enabled).toBe(false)
  })

  it('rotates once the file passes maxBytes and keeps the history readable', async () => {
    const { files } = await makeLogs({ maxBytes: 10000, keep: 2 })

    for (let index = 0; index < 200; index++) {
      files.append('web', line(`line ${index} ${'x'.repeat(80)}`))
    }
    files.flush()

    const info = files.info('web')
    expect(info.files.length).toBeGreaterThan(1)
    expect(info.files.some(file => file.name === 'web.log.1')).toBe(true)

    // The tail spans the rotation boundary.
    const lines = files.readTail('web', 10)
    expect(lines.map(entry => entry.text)).toContain(`line 199 ${'x'.repeat(80)}`)
    expect(lines.length).toBe(10)
  })

  it('reports the disk size and clears on demand', async () => {
    const { files } = await makeLogs()
    files.append('web', line('something'))
    files.flush()

    expect(files.info('web').sizeBytes).toBeGreaterThan(0)
    files.clear('web')
    expect(files.info('web').sizeBytes).toBe(0)
    expect(files.readTail('web', 5)).toEqual([])
  })

  it('flushes pending lines on dispose', async () => {
    const { files, dir } = await makeLogs()
    files.append('web', line('written on dispose'))
    files.dispose()

    const written = await fs.promises.readFile(path.join(dir, 'logs', 'web.log'), 'utf8')
    expect(written).toContain('written on dispose')
  })
})
