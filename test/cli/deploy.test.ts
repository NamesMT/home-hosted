import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { runCli } from '../support/run-cli'

/**
 * `home-hosted deploy` **offline** — the path someone uses *because* the panel is down.
 *
 * The panel path resolves the entry's real environment through its supervisor. The offline path has
 * no supervisor and no secrets store, so it supplies the tracked `env` and `dataEnvs` and **says**
 * that `envFile` and declared secrets are missing rather than letting a step run without them in
 * silence. That silence was the bug: a private-registry install would have failed on an empty token
 * with nothing in the output to explain it.
 */
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function homeWith(entry: Record<string, unknown>): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-deploy-cli-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, '.hh', 'default'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.hh', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }))
  fs.writeFileSync(path.join(dir, '.hh', 'default', 'servers.config.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
    servers: [entry],
  }))
  return dir
}

describe('deploy offline', () => {
  it('runs the steps with the entry\'s tracked environment', async () => {
    const out = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-deploy-out-')), 'env.txt')
    dirs.push(path.dirname(out))
    const home = await homeWith({
      id: 'app',
      command: process.execPath,
      env: { FROM_CONFIG: 'yes' },
      deploy: {
        steps: [{ command: process.execPath, args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.env.FROM_CONFIG ?? "")`] }],
        restart: false,
      },
    })

    const run = runCli(['deploy', 'app'], { home })
    expect(run.status, run.output).toBe(0)
    expect(fs.readFileSync(out, 'utf8'), 'the tracked env reached the step').toBe('yes')
  })

  it('says what it cannot supply, rather than running without it silently', async () => {
    const home = await homeWith({
      id: 'app',
      command: process.execPath,
      envFile: '/somewhere/app.env',
      secretEnv: ['REGISTRY_TOKEN'],
      deploy: { steps: [{ command: process.execPath, args: ['-e', ''] }], restart: false },
    })

    const run = runCli(['deploy', 'app'], { home })
    expect(run.output).toMatch(/without envFile/)
    expect(run.output).toMatch(/secretEnv/)
    expect(run.output, 'and it names the fix').toMatch(/start the panel/)
  })

  it('reports a failed step and exits 1', async () => {
    const home = await homeWith({
      id: 'app',
      command: process.execPath,
      deploy: { steps: [{ command: process.execPath, args: ['-e', 'process.exitCode = 4'] }], restart: false },
    })
    const run = runCli(['deploy', 'app'], { home })
    expect(run.status).toBe(1)
    expect(run.output).toMatch(/code 4/)
  })

  it('refuses an entry with no deploy steps', async () => {
    const home = await homeWith({ id: 'plain', command: process.execPath })
    const run = runCli(['deploy', 'plain'], { home })
    expect(run.status).toBe(1)
    expect(run.output).toMatch(/no deploy steps/)
  })
})
