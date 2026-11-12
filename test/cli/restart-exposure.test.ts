import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true })
})

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-restart-exposure-'))
  homes.push(dir)
  return dir
}

/**
 * `restart --host lan` on the first-run password ran `down` first — the panel and every
 * non-persistent server stopped — and only then did the new panel refuse to start. The exposure
 * check is asked before anything is stopped, and `up` asks it before it spawns a daemon.
 */
describe('a bind the panel would refuse', () => {
  it('is refused by restart before down runs', () => {
    const dir = home()
    const result = runCli(['restart', '--host', 'lan'], { home: dir, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to restart')
    expect(result.stderr).toContain('first-run password')
    expect(result.stderr).toContain('nothing was stopped')
    // `down` never ran: it would have said so on stdout.
    expect(result.stdout).toBe('')
    // And no daemon was spawned to write a first-run password.
    expect(fs.existsSync(path.join(dir, '.hh', '.control-secrets.json'))).toBe(false)
  })

  it('is refused by up before a daemon is spawned', () => {
    const dir = home()
    const result = runCli(['up', '--host', 'lan'], { home: dir, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/refusing to start: can't listen on lan while the panel still has its first-run password — run `.+ set-password`/)
    expect(fs.existsSync(path.join(dir, '.hh', 'run.json'))).toBe(false)
  })
})
