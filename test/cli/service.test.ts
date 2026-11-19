import type { ServiceRunner, ServiceSpec } from '#src/cli/service'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { detectContainer, isServiceOurs, launchdPlist, managerCommands, renderService, runService, scheduledTaskXml, serviceDir, servicePath, serviceUser, systemdUnit, windowsArg } from '#src/cli/service'
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
  // Not on Windows: `service install` there writes a Task XML and registers it through `schtasks`,
  // and the ownership proof reads the task's own registration — a path and a passwd-free flow this
  // test does not model. macOS keeps accounts in Open Directory, so its passwd lookup cannot be
  // exercised either (the user-resolution test below says so explicitly).
  it.runIf(process.platform === 'linux')('leaves a unit it did not write alone, and says so', () => {
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

  /**
   * Ownership is checked against the file systemd **loaded**, not the one at our path.
   *
   * A unit copied by hand to `/etc/systemd/system/home-hosted.service` — the name a distro package
   * uses — shadows a user unit of the same name, so `systemctl --user` then acts on that one. A check
   * that only read our own path would report on a unit we never wrote, and `uninstall` would disable
   * and delete it. `FragmentPath` is the file systemd actually read.
   */
  it('tells a file it wrote from a foreign one, on every platform', () => {
    // The marker is per **format**, so this is driven through the generators rather than `--print`:
    // that answers for the platform the test happens to run on, and on macOS it prints a plist while
    // the assertion below speaks about a systemd unit (the first CI run failed exactly there).
    const unit = systemdUnit(spec)
    expect(isServiceOurs(unit, 'linux'), 'a unit we wrote is ours').toBe(true)
    expect(isServiceOurs('[Unit]\nDescription=somebody elses panel\n[Service]\nExecStart=/bin/true\n', 'linux'), 'an unmarked unit is not').toBe(false)

    const plist = launchdPlist(spec)
    expect(isServiceOurs(plist, 'darwin'), 'a plist we wrote is ours').toBe(true)
    expect(isServiceOurs('<?xml version="1.0"?>\n<plist version="1.0"><dict/></plist>', 'darwin'), 'an unmarked plist is not').toBe(false)

    // Windows carries the marker in the task's `<Description>`, which is the only free-text element a
    // Task XML has.
    const task = scheduledTaskXml(spec)
    expect(isServiceOurs(task, 'win32'), 'a task we wrote is ours').toBe(true)
    expect(isServiceOurs('<Task><RegistrationInfo><Description>home-hosted</Description></RegistrationInfo></Task>', 'win32'), 'a task without the marker is not').toBe(false)

    // An unreadable file is never ours, on any platform.
    for (const platform of ['linux', 'darwin', 'win32'] as const)
      expect(isServiceOurs('', platform), `an empty file is not ours (${platform})`).toBe(false)
  })

  it.runIf(process.platform === 'linux')('recognises the unit it wrote, so the guard is not a blanket refusal', () => {
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
  /**
   * A panel inside a container is **told** it cannot autostart, and what to do instead.
   *
   * `service install` writes a file the host's manager reads at boot. Inside a container that file
   * lives in the container's own filesystem — gone when the container is replaced, never seen by the
   * host — so the panel would not come back and nothing said why. `--print` still prints (it installs
   * nothing), and the refusal names the mechanism that does work.
   */
  it.runIf(process.platform === 'linux')('refuses to install inside a container, naming the restart policy', () => {
    const home = scratch()
    const config = scratch()
    // `container=` is the documented, explicit spelling a runtime may set; the CLI reads it.
    const env = { XDG_CONFIG_HOME: config, NO_COLOR: '1', container: 'docker' }

    const printed = runCli(['service', 'install', '--print'], { home, env })
    expect(printed.status, 'printing installs nothing, so it still works').toBe(0)
    expect(printed.stdout).toContain('[Unit]')

    const refused = runCli(['service', 'install'], { home, env })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('inside container environment')
    expect(refused.stderr).toContain('--restart unless-stopped')
    // And nothing was written: the refusal is before the file, not after it.
    expect(fs.existsSync(path.join(config, 'systemd', 'user', 'home-hosted.service'))).toBe(false)
  })

  it('detects the container markers it claims, and says none on a plain host', () => {
    // An explicit `container=` is the one input a test can state; the marker files are probed for real.
    expect(detectContainer({ container: 'docker' })).toBe('container environment (container=docker)')
    expect(detectContainer({ container: '  ' })).toBeNull()
    // On a host without a container marker this is null; inside CI it may be a real container, which
    // is a truthful answer either way — so assert the shape rather than the absence.
    const found = detectContainer({})
    expect(found === null || typeof found === 'string').toBe(true)
  })

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

  /**
   * The account a unit runs as is the **person**, and a stale environment cannot move it.
   *
   * `sudo` rewrites `USER`/`LOGNAME`/`HOME` to the target and `os.userInfo()` reports the euid, so
   * both would write `User=root` for somebody who only meant to install a service. `SUDO_USER` is the
   * instruction that survives — but it is an environment variable, so a shell that inherited
   * `SUDO_USER=root` from an ancestor would collapse the unit to root. `SUDO_UID` is the fact, so the
   * name is trusted only while the two agree.
   */
  it('takes the elevating tool\'s login while it agrees with its uid', () => {
    const own = os.userInfo().username

    // A name with no uid beside it is still an explicit statement about an account.
    expect(serviceUser({ SUDO_USER: own })).toBe(own)
    expect(serviceUser({ PKEXEC_USER: own })).toBe(own)
    // Nothing stated: this process's own login.
    expect(serviceUser({})).toBe(own)

    // **The uid half needs a row to check against, and macOS keeps accounts in Open Directory**, so
    // its `/etc/passwd` has no user rows and `passwdEntryFor` honestly answers null there — which
    // means the lookup cannot be exercised off Linux. Skipped rather than faked: asserting against a
    // synthetic passwd would test the fake, not the rule.
    // Windows has no `/etc/passwd` at all, and macOS keeps accounts in Open Directory so its passwd
    // has no user rows — in both cases `passwdEntryFor` honestly answers null and the uid half of the
    // rule cannot be exercised. Read defensively rather than assume the file exists.
    let passwd = ''
    try {
      passwd = fs.readFileSync('/etc/passwd', 'utf8')
    }
    catch {
      expect(process.platform, 'no passwd file means no local rows to check').toBe('win32')
      return
    }
    const line = passwd.split('\n').find(entry => entry.startsWith(`${own}:`))
    if (line === undefined) {
      expect(process.platform, 'no local row for this login means accounts live elsewhere').toBe('darwin')
      return
    }
    const ownUid = line.split(':')[2]!

    // Agreeing pair: the elevating tool's login wins over this process's euid.
    expect(serviceUser({ SUDO_USER: own, SUDO_UID: ownUid })).toBe(own)
    // A name that contradicts its uid is an inconsistent environment: fall back to this process.
    expect(serviceUser({ SUDO_USER: own === 'root' ? 'nobody' : 'root', SUDO_UID: ownUid })).toBe(own)
  })

  /**
   * `windowsArg` round-trips every nasty value through the **CRT** rules, byte for byte.
   *
   * The quoting was previously untested, and it is the one place a wrong backslash pair silently
   * splits an argument: `--home C:\Program Files\hh` and a value ending in a backslash both go
   * through here, and a mistake shows up as a service that starts with a truncated path rather than
   * as an error. The parser below is an independent implementation of those rules — not the writer's
   * inverse, so the two cannot agree by sharing a bug — and it is the same shape the sibling project
   * validated against a real Windows command line (37 nasty values, each child dumping its own argv).
   */
  it('round-trips every word through the real CreateProcess rules', () => {
    const values = [
      'plain',
      'with space',
      'C:\\Program Files\\home-hosted',
      'a"b',
      'a\\"b',
      'a\\\\"b',
      'trailing\\',
      'trail\\\\',
      // A trailing backslash only reaches the quoter when the word also needs quoting — a bare word
      // is emitted as-is, so the values above never exercised the doubling. These do, and they are
      // the realistic shape: a directory path ("…/My Dir\\") is what a home or project path looks like.
      'C:\\Program Files\\hh\\',
      'a b\\',
      'x y\\\\',
      'space then quote "',
      'ends with quote"',
      'quote at end"',
      '\\\"',
      'ünïcode 日本語',
      '-p',
      '{}',
      'a b c',
      '',
      'tab\there',
    ]
    for (const value of values) {
      // A word with no whitespace and no quote is emitted bare; the parser must still read it back.
      const line = windowsArg(value)
      expect(createProcessArgv(line), `round-trip for ${JSON.stringify(value)} via ${JSON.stringify(line)}`).toEqual([value])
    }
    // And a whole command line keeps its word boundaries.
    const words = ['C:\\Program Files\\node.exe', 'C:\\My App\\cli.js', '--home', 'C:\\Users\\A B\\.hh']
    expect(createProcessArgv(words.map(windowsArg).join(' '))).toEqual(words)
  })
})

/**
 * An independent implementation of the CRT/`CreateProcess` argv rules.
 *
 * Whitespace splits a word; backslashes are literal except before a `"`, where they pair and an odd
 * one escapes it. Written here rather than imported, so the writer in `service.ts` is checked by a
 * second reading of the rules instead of by its own inverse.
 */
function createProcessArgv(commandLine: string): string[] {
  const argv: string[] = []
  let index = 0
  while (index < commandLine.length) {
    while (index < commandLine.length && (commandLine[index] === ' ' || commandLine[index] === '\t'))
      index += 1
    if (index >= commandLine.length)
      break

    let word = ''
    let quoted = false
    while (index < commandLine.length) {
      const char = commandLine[index]!
      if (!quoted && (char === ' ' || char === '\t'))
        break
      if (char === '\\') {
        let backslashes = 0
        while (commandLine[index] === '\\') {
          backslashes += 1
          index += 1
        }
        if (commandLine[index] === '"') {
          word += '\\'.repeat(Math.floor(backslashes / 2))
          if (backslashes % 2 === 1)
            word += '"'
          else
            quoted = !quoted
          index += 1
          continue
        }
        word += '\\'.repeat(backslashes)
        continue
      }
      if (char === '"') {
        quoted = !quoted
        index += 1
        continue
      }
      word += char
      index += 1
    }
    argv.push(word)
  }
  return argv
}
