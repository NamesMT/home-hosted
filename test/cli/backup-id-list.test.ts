import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * The refusal with neither flag must list what could be acted on — **including the leaves**.
 *
 * Two code paths build that list (a panel answering, and the state files when none is), and a fix
 * applied to only one of them is why a panel user still saw four coarse ids. These run the CLI
 * directly, with no panel, so they cover the path that had no panel; the panel path is exercised by
 * the same helper reading the same nested shape.
 */

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ids-'))
  const hh = path.join(home, '.hh')
  fs.mkdirSync(path.join(hh, 'default'), { recursive: true })
  fs.writeFileSync(path.join(hh, 'settings.json'), '{"meta":{"writtenBy":"test","schema":2},"control":{}}\n')
  fs.writeFileSync(path.join(hh, 'workspaces.json'), '{"workspaces":[{"id":"default","label":"default"}]}\n')
  fs.writeFileSync(path.join(hh, 'default', 'settings.json'), '{"meta":{"writtenBy":"test","schema":2}}\n')
  const data = path.join(home, 'data')
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, 'f.txt'), 'x')
  fs.writeFileSync(path.join(hh, 'default', 'servers.config.json'), `${JSON.stringify({
    meta: { writtenBy: 'test', schema: 2 },
    servers: [{ id: 'db', command: 'node', backupPaths: [data] }],
  })}\n`)
  return home
}

describe('the no-flag refusal lists real ids', () => {
  it('names the leaves, not only the coarse entry ids', () => {
    const home = makeHome()
    try {
      const failure = runCli(['backup', 'create'], { home })
      expect(failure.status).toBe(1)

      // The coarse ids are still there, and so is every leaf under them.
      expect(failure.output).toContain('workspace:default')
      expect(failure.output).toContain('workspace:default:servers')
      expect(failure.output).toContain('workspace:default:data:')
      expect(failure.output, 'a person needs to see that one secret can be left out alone').toContain('global:secrets')
    }
    finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})
