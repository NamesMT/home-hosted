import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildServerEntry, commandAfterDashes } from '#src/cli/add'
import { lsLines } from '#src/cli/ls'
import { runCli } from '../support/run-cli'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-add-'))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

/** The quick start told a person to hand-edit `servers.config.json`; `add` declares an entry instead. */
describe('add turns flags into an entry', () => {
  it('takes the command after `--`, flags and all', () => {
    expect(commandAfterDashes(['web', '--port', '4000', '--', 'node', 'server.js', '--port', '4000'])).toEqual(['node', 'server.js', '--port', '4000'])
    expect(commandAfterDashes(['web'])).toEqual([])
  })

  it('builds the create body', () => {
    expect(buildServerEntry({ id: 'web', port: '4000', cwd: './app', persistent: true, autostart: true, command: ['node', 'server.js'] }))
      .toEqual({ entry: { id: 'web', command: 'node', args: ['server.js'], port: 4000, cwd: './app', persistent: true, autostart: true } })
  })

  it('refuses a missing id, a missing command and a port that is not a whole number', () => {
    expect(buildServerEntry({ command: ['node'] })).toMatchObject({ error: expect.stringContaining('needs a server id') })
    expect(buildServerEntry({ id: 'web', command: [] })).toMatchObject({ error: expect.stringContaining('after `--`') })
    expect(buildServerEntry({ id: 'web', port: '80x', command: ['node'] })).toEqual({ error: 'invalid port: 80x' })
  })
})

describe('ls', () => {
  it('lays out one row per entry, with a dash for what is unknown', () => {
    const lines = lsLines([{ id: 'web', status: null, port: 4000, command: 'node', args: ['server.js'], autostart: true, persistent: false, enabled: true }])
    expect(lines[0]).toMatch(/^ID +STATUS +PORT +COMMAND$/)
    expect(lines[1]).toMatch(/^web +— +4000 +node server\.js {2}\(autostart\)$/)
  })
})

/** With no panel, `add` writes the workspace's config through its store, and `ls` reads it back. */
describe('add and ls without a panel', () => {
  it('writes a validated entry, refuses a duplicate, and lists it', () => {
    const added = runCli(['add', 'web', '--port', '6830', '--', 'node', '-e', 'setInterval(()=>{},1000)'], { home })
    expect(added.status, added.stderr).toBe(0)
    expect(added.stdout).toContain('added web')
    expect(added.stdout).toContain('the panel is not running')

    const file = path.join(home, '.hh', 'default', 'servers.config.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { servers: Array<{ id: string, command: string, args: string[], port: number }> }
    expect(stored.servers).toEqual([expect.objectContaining({ id: 'web', command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port: 6830 })])

    const duplicate = runCli(['add', 'web', '--', 'node'], { home })
    expect(duplicate.status).toBe(1)
    expect(duplicate.stderr).toContain('already exists')

    // The panel's schema, offline too.
    const invalid = runCli(['add', 'Bad Id', '--', 'node'], { home })
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('invalid server')

    const listed = JSON.parse(runCli(['ls', '--json'], { home }).stdout) as { panelRunning: boolean, servers: Array<{ id: string, status: string | null, port: number }> }
    expect(listed.panelRunning).toBe(false)
    expect(listed.servers).toEqual([expect.objectContaining({ id: 'web', status: null, port: 6830 })])
  })

  it('refuses a workspace the home does not have', () => {
    const result = runCli(['add', 'api', '-w', 'nope', '--', 'node'], { home })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown workspace "nope"')
  })
})
