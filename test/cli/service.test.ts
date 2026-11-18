import type { ServiceRunner, ServiceSpec } from '#src/cli/service'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { launchdPlist, managerCommands, renderService, runService, scheduledTaskXml, serviceDir, servicePath, systemdUnit } from '#src/cli/service'
import { runCli } from '../support/run-cli'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-service-'))
  dirs.push(dir)
  return dir
}

const spec: ServiceSpec = {
  node: '/home/me/.nvm/versions/node/v24.1.0/bin/node',
  entry: ['/home/me/.nvm/versions/node/v24.1.0/lib/node_modules/home-hosted/dist/cli.js'],
  home: '/home/me/my servers/state',
  project: '/home/me/my servers',
  pathEnv: '/home/me/.nvm/versions/node/v24.1.0/bin:/usr/bin',
  logFile: '/home/me/my servers/state/.hh/.logs/home-hosted.log',
  scope: 'user',
  user: 'me',
  name: 'home-hosted',
}

/**
 * The README's hand-written unit stopped persistent entries with the panel (the default KillMode
 * kills the whole cgroup), ran `home-hosted` from a PATH a boot-time manager does not have, and with
 * `Restart=always` brought the panel back after `home-hosted down`.
 */
describe('the systemd unit', () => {
  const unit = systemdUnit(spec)

  it('signals only the panel on stop, and restarts only a failure', () => {
    expect(unit).toContain('KillMode=process')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).not.toContain('Restart=always')
  })

  it('runs the absolute node and entry, with the home and project, in the foreground', () => {
    expect(unit).toContain('ExecStart=/home/me/.nvm/versions/node/v24.1.0/bin/node /home/me/.nvm/versions/node/v24.1.0/lib/node_modules/home-hosted/dist/cli.js --home "/home/me/my servers/state" --project "/home/me/my servers" up --foreground')
    expect(unit).toContain('Environment="HHOSTED_HOME=/home/me/my servers/state"')
    expect(unit).toContain('Environment=PATH=/home/me/.nvm/versions/node/v24.1.0/bin:/usr/bin')
    expect(unit).toContain('WorkingDirectory="/home/me/my servers"')
  })

  it('is a default.target user unit, or a multi-user system unit with a User', () => {
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).not.toContain('User=')
    const system = systemdUnit({ ...spec, scope: 'system' })
    expect(system).toContain('WantedBy=multi-user.target')
    expect(system).toContain('User=me')
  })

  it('escapes what systemd would expand', () => {
    expect(systemdUnit({ ...spec, home: '/srv/50%$off' })).toContain('/srv/50%%$$off')
  })
})

describe('the launchd plist', () => {
  const plist = launchdPlist(spec)

  it('keeps the panel\'s children alive on stop and restarts only a failure', () => {
    expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toContain('<string>dev.home-hosted</string>')
  })

  it('carries the argv, the PATH and the home', () => {
    expect(plist).toContain(`<string>${spec.node}</string>`)
    expect(plist).toContain('<string>--foreground</string>')
    expect(plist).toContain(`<string>${spec.pathEnv}</string>`)
    expect(plist).toContain('<key>HHOSTED_HOME</key>')
  })
})

describe('the Task Scheduler task', () => {
  it('starts at logon for a user, at boot as SYSTEM for the machine', () => {
    const user = scheduledTaskXml({ ...spec, node: 'C:\\Program Files\\nodejs\\node.exe', entry: ['C:\\hh\\dist\\cli.js'], home: 'C:\\Users\\me\\hh state', project: 'C:\\Users\\me' })
    expect(user).toContain('<LogonTrigger>')
    expect(user).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>')
    expect(user).toContain('<Arguments>C:\\hh\\dist\\cli.js --home &quot;C:\\Users\\me\\hh state&quot; --project C:\\Users\\me up --foreground</Arguments>')
    const system = scheduledTaskXml({ ...spec, scope: 'system' })
    expect(system).toContain('<BootTrigger>')
    expect(system).toContain('<UserId>S-1-5-18</UserId>')
  })

  it('is written as UTF-16 with a BOM, the encoding its declaration names', () => {
    const rendered = renderService('win32', spec)
    expect(rendered.bytes.subarray(0, 2)).toEqual(Buffer.from([0xFF, 0xFE]))
    expect(rendered.fileName).toBe('home-hosted.xml')
  })
})

describe('the PATH a unit runs under', () => {
  it.runIf(process.platform !== 'win32')('puts this node first and drops the fnm per-shell directories', () => {
    expect(servicePath('/home/me/.local/state/fnm_multishells/123_456/bin:/usr/bin:/home/me/.fnm/v24/bin', '/home/me/.fnm/v24/bin/node'))
      .toBe('/home/me/.fnm/v24/bin:/usr/bin')
  })
})

describe('where each unit goes', () => {
  const context = { homedir: '/home/me', env: {}, hhDir: '/home/me/.home-hosted/.hh' }
  it('follows each manager', () => {
    expect(serviceDir('linux', 'user', context)).toBe(path.join('/home/me', '.config', 'systemd', 'user'))
    expect(serviceDir('linux', 'user', { ...context, env: { XDG_CONFIG_HOME: '/cfg' } })).toBe(path.join('/cfg', 'systemd', 'user'))
    expect(serviceDir('linux', 'system', context)).toBe('/etc/systemd/system')
    expect(serviceDir('darwin', 'user', context)).toBe(path.join('/home/me', 'Library', 'LaunchAgents'))
    expect(serviceDir('win32', 'user', context)).toBe(path.join(context.hhDir, '.service'))
  })
})

describe('installing', () => {
  function recorder(): { run: ServiceRunner, calls: string[] } {
    const calls: string[] = []
    return { calls, run: (command, args) => {
      calls.push([command, ...args].join(' '))
      return { status: 0, stdout: 'active', stderr: '' }
    } }
  }

  it('writes the unit into the directory it is given and runs the manager there', async () => {
    const dir = scratch()
    const { run, calls } = recorder()
    let printed = ''
    await runService({ action: 'install', scope: 'user', print: false, platform: 'linux', targetDir: dir, run, spec, out: (text) => { printed += text } }, 'unused')

    expect(fs.readFileSync(path.join(dir, 'home-hosted.service'), 'utf8')).toBe(systemdUnit(spec))
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now home-hosted.service'])
    expect(printed).toContain('loginctl enable-linger me')
  })

  it('prints without writing or running anything with --print', async () => {
    const dir = scratch()
    const { run, calls } = recorder()
    let printed = ''
    await runService({ action: 'install', scope: 'user', print: true, platform: 'darwin', targetDir: dir, run, spec, out: (text) => { printed += text } }, 'unused')
    expect(printed).toBe(launchdPlist(spec))
    expect(calls).toEqual([])
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('names the manager commands for removal and status', () => {
    expect(managerCommands('linux', 'system', 'uninstall', '/x', 'home-hosted')).toEqual([['systemctl', ['disable', '--now', 'home-hosted.service']], ['systemctl', ['daemon-reload']]])
    expect(managerCommands('darwin', 'user', 'install', '/x.plist', 'home-hosted')).toEqual([['launchctl', ['load', '-w', '/x.plist']]])
    expect(managerCommands('win32', 'user', 'install', 'C:\\x.xml', 'home-hosted')[0]).toEqual(['schtasks', ['/Create', '/TN', 'home-hosted', '/XML', 'C:\\x.xml']])
  })

  /** A second install would replace a unit someone may have edited, and restart a running panel. */
  it.runIf(process.platform === 'linux')('refuses when it is already installed, before the manager is asked', () => {
    const home = scratch()
    const config = scratch()
    const env = { XDG_CONFIG_HOME: config, NO_COLOR: '1' }
    // `status` names the file this home's unit lives in (XDG_CONFIG_HOME keeps it in scratch).
    const status = runCli(['service', 'status'], { home, env })
    expect(status.status).toBe(1)
    const file = /not installed \(no (.+)\) —/.exec(status.stdout)?.[1]
    expect(file, status.stdout).toBeDefined()
    expect(file!.startsWith(config)).toBe(true)
    fs.mkdirSync(path.dirname(file!), { recursive: true })
    fs.writeFileSync(file!, '# edited by hand\n')

    const result = runCli(['service', 'install'], { home, env })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already installed')
    expect(fs.readFileSync(file!, 'utf8')).toBe('# edited by hand\n')
  })

  /**
   * `uninstall` and `status` act only on a file **this command wrote**.
   *
   * The path is fixed and the name is one a distro package or a hand-written README unit uses, so
   * "there is a file here" is not "this is ours": removing it would stop a panel this command never
   * started, and reporting on it would claim a boot entry that runs something else. Each format
   * carries the marker in its own comment syntax, and Windows' in the Task XML's `<Description>`.
   */
  it('leaves a unit it did not write alone, and says so', () => {
    const home = scratch()
    const config = scratch()
    const env = { XDG_CONFIG_HOME: config, NO_COLOR: '1' }
    const named = runCli(['service', 'status'], { home, env })
    const file = /not installed \(no (.+)\) —/.exec(named.stdout)?.[1]
    expect(file, named.stdout).toBeDefined()
    fs.mkdirSync(path.dirname(file!), { recursive: true })
    fs.writeFileSync(file!, '[Unit]\nDescription=somebody elses panel\n[Service]\nExecStart=/bin/true\n')

    const status = runCli(['service', 'status'], { home, env })
    expect(status.status).toBe(1)
    expect(status.stdout).toContain('was not written by this command')
    expect(status.stdout, 'it must not claim to be installed').not.toContain(`installed ${file}`)

    const removed = runCli(['service', 'uninstall'], { home, env })
    expect(removed.status).toBe(1)
    expect(removed.stderr).toContain('refusing to remove it')
    expect(fs.existsSync(file!), 'the other person\'s unit survives').toBe(true)
  })

  it('recognises the unit it wrote, so the guard is not a blanket refusal', () => {
    const home = scratch()
    const config = scratch()
    const env = { XDG_CONFIG_HOME: config, NO_COLOR: '1' }
    const named = runCli(['service', 'status'], { home, env })
    const file = /not installed \(no (.+)\) —/.exec(named.stdout)?.[1]
    expect(file, named.stdout).toBeDefined()
    fs.mkdirSync(path.dirname(file!), { recursive: true })
    // What `install` would write, marker and all.
    fs.writeFileSync(file!, runCli(['service', 'install', '--print'], { home, env }).stdout)

    const status = runCli(['service', 'status'], { home, env })
    expect(status.stdout, status.stderr).toContain('installed')
    expect(status.stdout).not.toContain('was not written by this command')
  })

  /**
   * A value a service file cannot carry is **refused**, not escaped into something else.
   *
   * `--home`, `--project` and `PATH` are argv/env — input. Each generator writes one setting per line,
   * so a newline in `--home` injects a whole directive: measured, `--home $'/tmp/x\nExecStartPre=/bin/evil'`
   * rendered a unit with an `ExecStartPre=/bin/evil` line, and that unit starts at boot. A tab is
   * allowed (a path may legitimately contain one); NUL and CR are not.
   */
  it('refuses a fact containing a control character, rather than rendering it', () => {
    const injected = { ...spec, home: '/h\nExecStartPre=/bin/evil' }
    expect(() => renderService('linux', injected)).toThrow(/control character/)
    // The message names which fact and the code point, so the fix is obvious.
    expect(() => renderService('linux', injected)).toThrow(/home.*U\+000A/i)

    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(() => renderService(platform, { ...spec, project: '/p\r' }), `${platform} must refuse CR`).toThrow(/control character/)
      expect(() => renderService(platform, { ...spec, user: 'u\u0000' }), `${platform} must refuse NUL`).toThrow(/control character/)
    }

    // A tab in a path is unusual but legitimate, and refusing it would be wrong.
    expect(() => renderService('linux', { ...spec, home: '/h\twith tab' })).not.toThrow()
  })
})
