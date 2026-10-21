import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * The refusal with neither flag must list what could be acted on — **including the leaves**.
 *
 * Two code paths build that list (a panel answering, and the state files when none is), and a fix
 * applied to only one of them is why a panel user still saw four coarse ids. These run the CLI
 * directly, with no panel, so they cover the path that had no panel; the panel path is exercised by
 * the same helper reading the same nested shape.
 */

const run = promisify(execFile)
const CLI = path.join(process.cwd(), 'src', 'cli.ts')
const TSX = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')

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
  it('names the leaves, not only the coarse entry ids', async () => {
    const home = makeHome()
    try {
      const failure = await run(TSX, [CLI, '--home', home, 'backup', 'create'], { encoding: 'utf8' })
        .then(() => null, (error: { stdout?: string, stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`)
      expect(failure).not.toBeNull()

      // The coarse ids are still there, and so is every leaf under them.
      expect(failure).toContain('workspace:default')
      expect(failure).toContain('workspace:default:servers')
      expect(failure).toContain('workspace:default:data:')
      expect(failure, 'a person needs to see that one secret can be left out alone').toContain('global:secrets')
    }
    finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})
