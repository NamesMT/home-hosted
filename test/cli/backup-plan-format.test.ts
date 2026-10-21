import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * `create` and `restore` print the same tree.
 *
 * They printed two shapes for the same ids — create grouped leaves under entries, restore was a flat
 * list of identical-looking lines — and neither had a root row, so nothing said which scope a line
 * belonged to.
 */

const run = promisify(execFile)
const CLI = path.join(process.cwd(), 'src', 'cli.ts')
const TSX = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')
const dirs: string[] = []

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-plan-'))
  dirs.push(home)
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

async function cli(home: string, args: string[]): Promise<string> {
  const result = await run(TSX, [CLI, '--home', home, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
    .then(out => out.stdout, (error: { stdout?: string, stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`)
  // eslint-disable-next-line no-control-regex
  return result.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('the plan tree', () => {
  it('shows a root row per scope, the entry, then its leaves', async () => {
    const home = makeHome()
    const out = await cli(home, ['backup', 'create', '--all'])

    // The root rows, so a line says which scope it belongs to.
    expect(out).toMatch(/^ {2}global$/m)
    expect(out).toMatch(/^ {2}workspace$/m)
    // The entry, indented under its root, and its leaves one step deeper.
    expect(out).toMatch(/^ {4}- global:settings$/m)
    expect(out).toMatch(/^ {4}- workspace:default$/m)
    expect(out).toMatch(/^ {6}- workspace:default:servers$/m)
  }, 60_000)

  it('prints the same shape for a restore plan', async () => {
    const home = makeHome()
    // Take one, so the archive exists to plan a restore from.
    await cli(home, ['backup', 'create', '--all', '--confirm'])
    const archive = fs.readdirSync(path.join(home, '.hh', '.backups')).find(name => name.endsWith('.zip'))!

    const out = await cli(home, ['backup', 'restore', archive, '--all'])
    expect(out).toMatch(/^ {2}global$/m)
    expect(out).toMatch(/^ {2}workspace$/m)
    expect(out).toMatch(/^ {4}- workspace:default$/m)
    expect(out).toMatch(/^ {6}- workspace:default:servers$/m)
  }, 60_000)
})
