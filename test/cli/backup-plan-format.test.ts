import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * `create` and `restore` print the same tree.
 *
 * They printed two shapes for the same ids — create grouped leaves under entries, restore was a flat
 * list of identical-looking lines — and neither had a root row, so nothing said which scope a line
 * belonged to.
 */

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

/** The plan, or both streams if the command failed — the reason may be on either. */
function cli(home: string, args: string[]): string {
  const result = runCli(args, { home, env: { NO_COLOR: '1' } })
  return result.status === 0 ? result.stdout : result.output
}

describe('the plan tree', () => {
  it('shows a root row per scope, the entry, then its leaves', () => {
    const home = makeHome()
    const out = cli(home, ['backup', 'create', '--all'])

    // The root rows, so a line says which scope it belongs to.
    expect(out).toMatch(/^ {2}global$/m)
    expect(out).toMatch(/^ {2}workspace$/m)
    // The entry, indented under its root, and its leaves one step deeper.
    expect(out).toMatch(/^ {4}- global:settings$/m)
    expect(out).toMatch(/^ {4}- workspace:default$/m)
    expect(out).toMatch(/^ {6}- workspace:default:servers$/m)
  }, 60_000)

  it('prints the same shape for a restore plan', () => {
    const home = makeHome()
    // Take one, so the archive exists to plan a restore from.
    cli(home, ['backup', 'create', '--all', '--confirm'])
    const archive = fs.readdirSync(path.join(home, '.hh', '.backups')).find(name => name.endsWith('.zip'))!

    const out = cli(home, ['backup', 'restore', archive, '--all'])
    expect(out).toMatch(/^ {2}global$/m)
    expect(out).toMatch(/^ {2}workspace$/m)
    expect(out).toMatch(/^ {4}- workspace:default$/m)
    expect(out).toMatch(/^ {6}- workspace:default:servers$/m)
  }, 60_000)
})
