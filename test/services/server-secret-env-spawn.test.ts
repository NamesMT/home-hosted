import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSupervisor, runCleanups, waitFor } from '../support/supervisor-harness'

afterEach(runCleanups)

/**
 * A declared secret reaches the child, in the documented precedence, and never reaches a log.
 *
 * Precedence is **config `env` < `envFile` < secret env**: the secret is the most specific statement
 * a person can make about one variable, and it is the one stored where a backup carries it — a secret
 * that lost to a stale `envFile` line would be a secret that silently does not work.
 *
 * The log assertion is the other half. An entry's log is served over the API, streamed to every UI
 * and quoted into chat notifications, so a value in it is a value published; the spawn line names the
 * args *before* `${VAR}` expansion for the same reason (`AGENTS.md`).
 */
describe('a secret environment at spawn', () => {
  it('overrides env and envFile, and a value that was not declared is not passed', async () => {
    const harness = await makeSupervisor([])
    const out = path.join(harness.dir, 'env.json')
    const secrets = harness.secrets
    secrets.setServerEnv('web', { FROM_SECRET: 'secret', SHARED: 'secret-wins', UNDECLARED: 'should-not-appear' })

    harness.store.addServer({
      id: 'web',
      command: process.execPath,
      args: ['-e', `require("node:fs").writeFileSync(process.env.OUT, JSON.stringify({
        fromEnv: process.env.FROM_ENV, fromFile: process.env.FROM_FILE,
        fromSecret: process.env.FROM_SECRET, shared: process.env.SHARED,
        undeclared: process.env.UNDECLARED ?? null,
      }))`],
      env: { OUT: out, FROM_ENV: 'config', SHARED: 'from-env' },
      secretEnv: ['FROM_SECRET', 'SHARED'],
      port: null,
      restart: { enabled: false },
      health: { enabled: false },
    } as never)

    await harness.supervisor.start('web')
    await waitFor(() => fs.existsSync(out))
    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, string | null>

    expect(seen.fromEnv, 'a config value still arrives when it is not overridden').toBe('config')
    expect(seen.fromSecret, 'a declared secret reaches the child').toBe('secret')
    expect(seen.shared, 'the secret wins over config `env`').toBe('secret-wins')
    // The store holds it, but the entry did not declare the name — so it must not be passed either.
    // Declaration is the consent: a leftover value for another entry must not leak in.
    expect(seen.undeclared, 'an undeclared value is not passed').toBeNull()
  })

  it('beats an envFile line for the same name', async () => {
    const harness = await makeSupervisor([])
    const out = path.join(harness.dir, 'env.json')
    const envFile = path.join(harness.dir, '.env')
    fs.writeFileSync(envFile, 'SHARED=from-file\nFILE_ONLY=file\n')
    harness.secrets.setServerEnv('web', { SHARED: 'secret' })

    harness.store.addServer({
      id: 'web',
      command: process.execPath,
      args: ['-e', `require("node:fs").writeFileSync(process.env.OUT, JSON.stringify({ shared: process.env.SHARED, fileOnly: process.env.FILE_ONLY }))`],
      env: { OUT: out },
      envFile,
      secretEnv: ['SHARED'],
      port: null,
      restart: { enabled: false },
      health: { enabled: false },
    } as never)

    await harness.supervisor.start('web')
    await waitFor(() => fs.existsSync(out))
    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, string>

    expect(seen.shared, 'the secret is the most specific statement').toBe('secret')
    // An undeclared envFile value still arrives: `secretEnv` overrides names, it does not filter.
    expect(seen.fileOnly).toBe('file')
  })

  it('never writes a value into the entry log', async () => {
    const harness = await makeSupervisor([])
    harness.secrets.setServerEnv('web', { API_TOKEN: 'sk-do-not-log-this-value' })

    harness.store.addServer({
      id: 'web',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: {},
      secretEnv: ['API_TOKEN'],
      port: null,
      restart: { enabled: false },
      health: { enabled: false },
    } as never)

    await harness.supervisor.start('web')
    await waitFor(async () => harness.supervisor.views().find(entry => entry.id === 'web')?.status === 'running')
    await harness.supervisor.stop('web')

    const text = harness.supervisor.logLines('web').map(line => line.text).join('\n')
    expect(text, 'the log is served over the API and quoted into chat').not.toContain('sk-do-not-log-this-value')
    // The names are fine to show — the start line already prints the command and args.
    expect(text).toContain('start:')
  })
})
