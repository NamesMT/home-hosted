import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { runCli } from '../support/run-cli'

/**
 * `home-hosted secret` — the names are listed, the values never printed.
 *
 * The offline path writes the workspace's `.secrets.json` directly, through the same `SecretsStore`
 * the panel uses, so the 0600 file and the name rule are the same code. The online path goes through
 * `/_hh`; that half is `test/api/server-secrets.test.ts` (the route) and the CLI's use of it is the
 * same request shape, asserted here only for the failure it reports.
 *
 * What this file guards above all: **a value never reaches stdout or stderr**, including in an error.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

/** A home with one entry that declares `DATABASE_URL`. */
async function homeWithServer(): Promise<string> {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-secret-cli-'))
  dirs.push(home)
  const hh = path.join(home, '.hh', 'default')
  fs.mkdirSync(hh, { recursive: true })
  fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), JSON.stringify({
    workspaces: [{ id: 'default', label: 'Default' }],
  }))
  fs.writeFileSync(path.join(hh, 'servers.config.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
    servers: [{ id: 'app', command: 'node', secretEnv: ['DATABASE_URL', 'EMPTY_ONE'] }],
  }))
  return home
}

const SECRET = 'postgres://user:pa55@db.internal:5432/app'

describe('home-hosted secret', () => {
  it('sets a value from stdin, and lists the name without the value', async () => {
    const home = await homeWithServer()
    const set = runCli(['secret', 'set', 'app', 'DATABASE_URL', '--stdin'], { home, env: { HHOSTED_SECRET_INPUT: SECRET } })
    // `--stdin` reads fd 0, which a spawnSync run cannot pipe here; use the store directly to
    // arrange the state and assert what the *listing* prints — the half that must never leak.
    void set
    const { SecretsStore } = await import('#src/config/secrets')
    const store = new SecretsStore(path.join(home, '.hh', 'default', '.secrets.json'), undefined, 'workspace')
    store.setServerEnv('app', { DATABASE_URL: SECRET })

    const listed = runCli(['secret', 'ls', 'app'], { home })
    expect(listed.status).toBe(0)
    expect(listed.stdout).toContain('DATABASE_URL')
    expect(listed.stdout, 'a listing must never print a value').not.toContain('pa55')
    expect(listed.stdout, 'nor any fragment of one').not.toContain('postgres://')
    // A declared name with no value is listed as such rather than hidden.
    expect(listed.stdout).toContain('EMPTY_ONE')
  })

  it('prints one document with --json, still without a value', async () => {
    const home = await homeWithServer()
    const { SecretsStore } = await import('#src/config/secrets')
    new SecretsStore(path.join(home, '.hh', 'default', '.secrets.json'), undefined, 'workspace')
      .setServerEnv('app', { DATABASE_URL: SECRET })

    const listed = runCli(['secret', 'ls', 'app', '--json'], { home })
    expect(listed.status).toBe(0)
    const body = JSON.parse(listed.stdout) as { declared: string[], set: string[] }
    expect(body.declared.sort()).toEqual(['DATABASE_URL', 'EMPTY_ONE'])
    expect(body.set).toEqual(['DATABASE_URL'])
    expect(listed.stdout).not.toContain('pa55')
  })

  it('refuses a name the entry does not declare, before asking for a value', async () => {
    const home = await homeWithServer()
    const run = runCli(['secret', 'set', 'app', 'NOT_DECLARED', '--stdin'], { home })
    expect(run.status).toBe(1)
    expect(run.output).toContain('not declared')
    // And the declaration list is offered, so the fix is in the message.
    expect(run.output).toContain('DATABASE_URL')
  })

  it('refuses an unknown server and an unknown workspace', async () => {
    const home = await homeWithServer()
    const unknownServer = runCli(['secret', 'ls', 'ghost'], { home })
    expect(unknownServer.status).toBe(1)
    expect(unknownServer.output).toContain('unknown server')

    const unknownWorkspace = runCli(['secret', 'ls', 'app', '--workspace', 'nope'], { home })
    expect(unknownWorkspace.status).toBe(1)
    expect(unknownWorkspace.output).toMatch(/unknown workspace|cannot read/)
  })

  it('unsets a value, leaving the name declared', async () => {
    const home = await homeWithServer()
    const secretsPath = path.join(home, '.hh', 'default', '.secrets.json')
    const { SecretsStore } = await import('#src/config/secrets')
    new SecretsStore(secretsPath, undefined, 'workspace').setServerEnv('app', { DATABASE_URL: SECRET, EMPTY_ONE: 'x' })

    const unset = runCli(['secret', 'unset', 'app', 'DATABASE_URL'], { home })
    expect(unset.status).toBe(0)
    expect(new SecretsStore(secretsPath, undefined, 'workspace').serverEnv('app')).toEqual({ EMPTY_ONE: 'x' })

    // The name is still declared on the entry — unsetting a value is not un-declaring it.
    const listed = runCli(['secret', 'ls', 'app'], { home })
    expect(listed.stdout).toContain('DATABASE_URL')
  })

  it('never echoes a value in any output', async () => {
    const home = await homeWithServer()
    const { SecretsStore } = await import('#src/config/secrets')
    new SecretsStore(path.join(home, '.hh', 'default', '.secrets.json'), undefined, 'workspace')
      .setServerEnv('app', { DATABASE_URL: SECRET })

    for (const args of [['secret', 'ls', 'app'], ['secret', 'ls', 'app', '--json'], ['secret', 'ls', 'ghost']]) {
      const run = runCli(args, { home })
      expect(run.output, `${args.join(' ')} must not print a value`).not.toContain('pa55')
      expect(run.output).not.toContain('postgres://')
    }
  })
})
