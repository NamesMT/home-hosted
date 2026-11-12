import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * `home-hosted import pm2|compose` — carry an existing setup in, without hand-writing JSON.
 *
 * The shape is `backup`'s, deliberately: print a **plan**, and write only with `--confirm`. A
 * non-interactive run with no `--confirm` exits 1, so a cron job or CI step cannot silently create
 * servers nobody asked for — the same consent rule that took a missing `--confirm` from "never took a
 * backup" to "exits 1".
 *
 * The mapping is the whole feature, and each field is asserted against the container it claims:
 * pm2's `script`/`interpreter`/`args` become `command`/`args`, `autorestart` becomes
 * `restart.enabled`, `max_restarts` becomes `restart.maxRetries`, `max_memory_restart` becomes
 * `resources.maxRssBytes`, and what cannot be carried is **reported**, never dropped silently.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-import-'))
  dirs.push(dir)
  return dir
}

/** A home with the default workspace, so the offline path has somewhere to write. */
function homeAt(dir: string): string {
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, '.hh', 'default'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hh', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }))
  return home
}

/** What the workspace's config holds now. */
function serversIn(home: string): Array<Record<string, unknown>> {
  const file = path.join(home, '.hh', 'default', 'servers.config.json')
  if (!fs.existsSync(file))
    return []
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { servers?: Array<Record<string, unknown>> }
  return parsed.servers ?? []
}

const ECOSYSTEM = {
  apps: [
    {
      name: 'gateway',
      script: 'server.js',
      interpreter: 'node',
      args: '--port 4000',
      cwd: '/srv/gateway',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 8,
      max_memory_restart: '200M',
    },
    {
      name: 'worker',
      script: 'worker.js',
      cron_restart: '0 3 * * *',
      watch: true,
    },
  ],
}

describe('home-hosted import pm2', () => {
  it('prints a plan and writes nothing without --confirm', async () => {
    const dir = await scratch()
    const home = homeAt(dir)
    const file = path.join(dir, 'ecosystem.config.json')
    fs.writeFileSync(file, JSON.stringify(ECOSYSTEM))

    const run = runCli(['import', 'pm2', file], { home })
    expect(run.status, 'no TTY and no --confirm exits 1').toBe(1)
    expect(run.stdout).toContain('gateway')
    // The plan names what it would write, and says it wrote nothing.
    expect(run.output).toMatch(/would add|plan|--confirm/)
    expect(serversIn(home), 'nothing is written without consent').toEqual([])
  })

  it('maps the fields pm2 has onto the entry, and reports what it cannot carry', async () => {
    const dir = await scratch()
    const home = homeAt(dir)
    const file = path.join(dir, 'ecosystem.config.json')
    fs.writeFileSync(file, JSON.stringify(ECOSYSTEM))

    const run = runCli(['import', 'pm2', file, '--confirm'], { home })
    expect(run.status, run.output).toBe(0)

    const servers = serversIn(home)
    expect(servers.map(server => server.id)).toEqual(['gateway', 'worker'])

    const gateway = servers[0]!
    expect(gateway.command, 'the interpreter is the program').toBe('node')
    expect(gateway.args, 'the script is the first argument').toEqual(['server.js', '--port', '4000'])
    expect(gateway.cwd).toBe('/srv/gateway')
    expect(gateway.env).toEqual({ NODE_ENV: 'production' })
    expect(gateway.restart).toMatchObject({ enabled: true, maxRetries: 8 })
    expect(gateway.resources, '200M becomes a byte ceiling').toMatchObject({ maxRssBytes: 200 * 1024 * 1024 })

    // What pm2 has and this panel does not is **reported**, not dropped in silence.
    expect(run.output).toMatch(/watch|cron/i)
  })

  it('reports a slug collision instead of writing two entries under one id', async () => {
    const dir = await scratch()
    const home = homeAt(dir)
    const file = path.join(dir, 'ecosystem.config.json')
    fs.writeFileSync(file, JSON.stringify({ apps: [{ name: 'my app', script: 'a.js' }, { name: 'my-app', script: 'b.js' }] }))

    const run = runCli(['import', 'pm2', file, '--confirm'], { home })
    // Two different names slugify to one id; the second must be refused by name, not merged.
    expect(run.output).toMatch(/collision|already|same id/i)
  })

  it('refuses a .js ecosystem file without --allow-js, and evaluates it with the flag', async () => {
    const dir = await scratch()
    const home = homeAt(dir)
    const js = path.join(dir, 'ecosystem.config.js')
    fs.writeFileSync(js, `module.exports = { apps: [{ name: 'from-js', script: 'app.js' }] }`)

    const refused = runCli(['import', 'pm2', js, '--confirm'], { home })
    expect(refused.status, 'running someone else’s JavaScript is an explicit opt-in').toBe(1)
    expect(refused.output).toContain('--allow-js')
    expect(serversIn(home)).toEqual([])

    const allowed = runCli(['import', 'pm2', js, '--allow-js', '--confirm'], { home })
    expect(allowed.status, allowed.output).toBe(0)
    expect(serversIn(home).map(server => server.id)).toEqual(['from-js'])
  })

  it('refuses a file that is not an ecosystem, and one that does not exist', async () => {
    const dir = await scratch()
    const home = homeAt(dir)
    const notAnEcosystem = path.join(dir, 'plain.json')
    fs.writeFileSync(notAnEcosystem, JSON.stringify({ apps: 'nope' }))
    expect(runCli(['import', 'pm2', notAnEcosystem, '--confirm'], { home }).status).toBe(1)
    expect(runCli(['import', 'pm2', path.join(dir, 'missing.json'), '--confirm'], { home }).status).toBe(1)
  })
})

describe('home-hosted import compose', () => {
  it('declares one compose entry for the stack', async () => {
    const dir = await scratch()
    const home = homeAt(dir)
    const file = path.join(dir, 'docker-compose.yml')
    fs.writeFileSync(file, 'services:\n  web:\n    image: nginx\n')

    const run = runCli(['import', 'compose', file, '--id', 'stack', '--confirm'], { home })
    expect(run.status, run.output).toBe(0)

    const [entry] = serversIn(home)
    expect(entry!.id).toBe('stack')
    // The command is compose itself: the containers are the server, and the panel detects them from
    // this argv (the same rule `isComposeCommand` applies at spawn).
    expect(entry!.command).toMatch(/docker$/)
    expect(entry!.args).toEqual(expect.arrayContaining(['compose', '-f', file, 'up']))
  })

  it('refuses a --id it cannot use', async () => {
    const dir = await scratch()
    const home = homeAt(dir)
    const file = path.join(dir, 'docker-compose.yml')
    fs.writeFileSync(file, 'services:\n  web:\n    image: nginx\n')
    expect(runCli(['import', 'compose', file, '--id', 'Bad Id', '--confirm'], { home }).status).toBe(1)
  })
})
