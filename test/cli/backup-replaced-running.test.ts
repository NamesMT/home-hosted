import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-replaced-running-'))
const previous = process.env.HHOSTED_HOME
let lines: typeof import('#src/cli/backup')['replacedUnderRunningLines']

beforeAll(async () => {
  process.env.HHOSTED_HOME = home
  vi.resetModules()
  lines = (await import('#src/cli/backup')).replacedUnderRunningLines
})

afterAll(() => {
  if (previous === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
})

/**
 * A restore over a running entry's data was reported only in `--json` (`replacedUnderRunning`): the
 * text output said "restored 7 items" and the process kept the old files open.
 */
describe('a restore over a running entry', () => {
  it('names each entry once, in the plan and after the apply', () => {
    const list = [
      { workspaceId: 'default', serverId: 'worker', path: '/srv/a' },
      { workspaceId: 'default', serverId: 'worker', path: '/srv/b' },
      { workspaceId: 'media', serverId: 'jellyfin', path: '/srv/c' },
    ]
    expect(lines(list, true)).toEqual([
      '! worker is running — its data was replaced under it; restart it',
      '! media/jellyfin is running — its data was replaced under it; restart it',
    ])
    expect(lines(list, false)[0]).toBe('! worker is running — restoring replaces its data under it; restart it afterwards')
    expect(lines([], true)).toEqual([])
  })
})
