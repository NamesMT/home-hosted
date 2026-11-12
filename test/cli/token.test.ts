import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * `home-hosted token create|ls|revoke` — the scoped tokens, from a terminal.
 *
 * The offline path writes the global secrets file through the same store the panel uses. What this
 * file guards: the value is printed **once** and never by `ls`; a revoked token is gone; and an
 * unknown scope is refused rather than silently dropped, because a token with fewer scopes than its
 * owner asked for fails later in a way nobody connects back to this command.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-token-cli-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, '.hh', 'default'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.hh', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }))
  return dir
}

/** The token ids on disk, so a test can revoke one without parsing the create output. */
function idsOnDisk(home: string): string[] {
  const file = path.join(home, '.hh', '.control-secrets.json')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { apiTokens?: Array<{ id: string }> }
  return (parsed.apiTokens ?? []).map(entry => entry.id)
}

describe('home-hosted token', () => {
  it('creates a token, prints the value once, and never again', async () => {
    const dir = await home()
    const created = runCli(['token', 'create', '--name', 'monitor', '--scope', 'read'], { home: dir })
    expect(created.status, created.output).toBe(0)
    const value = /hh_[\w-]+/.exec(created.stdout)?.[0]
    expect(value, 'the value is printed once, at creation').toBeTruthy()

    const listed = runCli(['token', 'ls'], { home: dir })
    expect(listed.status).toBe(0)
    expect(listed.stdout).toContain('monitor')
    expect(listed.stdout).toContain('read')
    // The whole point of a hash-only store: `ls` cannot show it.
    expect(listed.stdout).not.toContain(value!)
    expect(listed.stdout).toMatch(/shown once|not stored/)
  })

  it('writes only a hash of the value', async () => {
    const dir = await home()
    const created = runCli(['token', 'create', '--name', 'monitor', '--scope', 'read'], { home: dir })
    const value = /hh_[\w-]+/.exec(created.stdout)![0]
    const raw = fs.readFileSync(path.join(dir, '.hh', '.control-secrets.json'), 'utf8')
    expect(raw, 'the value must never reach the file').not.toContain(value)
  })

  it('lists one document with --json', async () => {
    const dir = await home()
    runCli(['token', 'create', '--name', 'monitor', '--scope', 'read,lifecycle'], { home: dir })
    const listed = runCli(['token', 'ls', '--json'], { home: dir })
    const body = JSON.parse(listed.stdout) as { tokens: Array<{ name: string, scopes: string[] }> }
    expect(body.tokens[0]).toMatchObject({ name: 'monitor', scopes: ['read', 'lifecycle'] })
  })

  it('revokes one, and refuses an unknown id', async () => {
    const dir = await home()
    runCli(['token', 'create', '--name', 'monitor', '--scope', 'read'], { home: dir })
    const [id] = idsOnDisk(dir)

    expect(runCli(['token', 'revoke', id!], { home: dir }).status).toBe(0)
    expect(idsOnDisk(dir)).toEqual([])

    const missing = runCli(['token', 'revoke', 'ghost'], { home: dir })
    expect(missing.status).toBe(1)
    expect(missing.output).toContain('no API token')
  })

  it('refuses an unknown or missing scope, and a duplicate name', async () => {
    const dir = await home()
    expect(runCli(['token', 'create', '--name', 'x', '--scope', 'root'], { home: dir }).status).toBe(1)
    expect(runCli(['token', 'create', '--name', 'x'], { home: dir }).status).toBe(1)

    runCli(['token', 'create', '--name', 'dup', '--scope', 'read'], { home: dir })
    const again = runCli(['token', 'create', '--name', 'dup', '--scope', 'read'], { home: dir })
    expect(again.status).toBe(1)
    expect(again.output).toMatch(/already/)
  })

  it('limits a token to workspaces it names', async () => {
    const dir = await home()
    runCli(['token', 'create', '--name', 'scoped', '--scope', 'read', '--workspace', 'default'], { home: dir })
    const listed = runCli(['token', 'ls', '--json'], { home: dir })
    const body = JSON.parse(listed.stdout) as { tokens: Array<{ workspaces?: string[] }> }
    expect(body.tokens[0]!.workspaces).toEqual(['default'])
  })
})
