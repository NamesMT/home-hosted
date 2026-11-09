import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanScratch, makeHome, rewriteArchive, takeArchive } from '../support/backup-outcome'
import { runCli } from '../support/run-cli'

afterEach(cleanScratch)

/** The first half of `a restore that applied nothing`, and why it exists, is in `backup-restore-outcome.test.ts`. */
describe('a restore that applied nothing', () => {
  it('fails, and names --password, when the password is wrong', () => {
    const { home, backups } = makeHome()
    const created = runCli(['backup', 'create', '--all', '--password', 'hunter2', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(created.status, created.output).toBe(0)
    const name = fs.readdirSync(backups).find(entry => entry.endsWith('.zip'))!

    const result = runCli(['backup', 'restore', name, '--all', '--password', 'wrong', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
    expect(result.output).toContain('--password')
  }, 90_000)

  it('reports an applied restore honestly, and keeps exiting 0', () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toMatch(/restored \d+ items?/)
  }, 90_000)
})

/**
 * A restore that applied *some* of an archive must say which pieces it left behind.
 *
 * The service puts each one in `skipped` — an unreadable `servers.config.json`, a data path whose
 * declaration this host no longer has — and the UI draws that list. The CLI printed only the applied
 * count, so a restore that lost every server definition, and the data that belonged to it, said
 * "restored 5 items" and nothing else. On a disaster-recovery run that is the difference between
 * "my stack is back" and "my stack has no servers and its data is gone".
 */
describe('a restore that applied only part of an archive', () => {
  it('names each piece it had to leave behind', async () => {
    const { home } = makeHome()
    const name = takeArchive(home)
    // An archive whose servers file this release cannot read: everything else applies, that leaf
    // is skipped.
    await rewriteArchive(path.join(home, '.hh', '.backups', name), 'workspaces/default/servers.config.json', '{"not": "a servers file"}\n')

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toMatch(/restored \d+ items?/)
    expect(result.output).toContain('!')
    expect(result.output).toContain('Servers')
  }, 90_000)
})
