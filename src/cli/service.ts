import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation, paint } from '#src/cli/io'

/**
 * `service install|uninstall|status` — start the panel at boot with the OS's own service manager.
 *
 * Three generators, one per platform, are pure: they take the facts (node, the CLI entry, the
 * home, the project, PATH) and return the file. The installer writes that file into a directory it
 * is handed (so a test never touches systemd, launchd or Task Scheduler) and runs the manager only
 * outside `--print`. The unit runs `up --foreground`, because the manager is the supervisor here.
 *
 * What every unit gets right, because the hand-written README unit did not:
 * - **only the panel is signalled on stop** (`KillMode=process`, launchd's `AbandonProcessGroup`):
 *   the panel stops its own servers, and a persistent entry is meant to outlive it — killing the
 *   whole cgroup on `systemctl stop` ended those too;
 * - **the PATH of the shell that installed it**, so a server's `node`/`pnpm` from nvm or fnm
 *   resolves the way it did when it was tested;
 * - **the absolute node binary and CLI entry** (`process.execPath`), never `home-hosted` on a PATH
 *   a boot-time manager does not have;
 * - **restart on failure only**: a `home-hosted down` exits 0 and stays down.
 */

export type ServicePlatform = 'linux' | 'darwin' | 'win32'

/**
 * The line that marks a file as **this** command's, in each format's own comment syntax.
 *
 * `uninstall` deletes the file at a fixed path (`~/.config/systemd/user/home-hosted.service` and its
 * equivalents), and `status` reports on it — but a path being right says nothing about who wrote it.
 * `home-hosted.service` is exactly the name a distro package or a hand-written README unit uses, so
 * `service uninstall` could remove somebody else's unit, and `service status` could report on it as if
 * it were ours. The marker is the proof of ownership, and every manager here can carry one:
 * `# …` in a systemd unit and a `.desktop` file, `<!-- … -->` in a launchd plist, `<Description>` in a
 * Task Scheduler XML declaration.
 */
export const SERVICE_MARKER = 'Managed by home-hosted — `home-hosted service uninstall` removes it'

/** The marker as it appears in a rendered file, or `null` for a format that cannot carry one. */
export function markerLine(platform: ServicePlatform): string | null {
  if (platform === 'linux')
    return `# ${SERVICE_MARKER}`
  if (platform === 'darwin')
    return `<!-- ${SERVICE_MARKER} -->`
  return null
}

/**
 * Whether a rendered-or-read file was written by this command.
 *
 * A file with no marker is **not** ours. That is the safe direction: a unit a person wrote by hand at
 * the path we would use is theirs to keep, and `service install` already refuses to overwrite an
 * existing file rather than merging with one.
 */
export function isServiceOurs(contents: string, platform: ServicePlatform): boolean {
  if (platform === 'win32')
    return contents.includes(SERVICE_MARKER)
  const marker = markerLine(platform)
  return marker !== null && contents.includes(marker)
}

export type ServiceScope = 'user' | 'system'

/** What a unit runs, and as whom. */
export interface ServiceSpec {
  /** `process.execPath`. */
  node: string
  /** Runtime flags before the entry (`--import=<tsx>` in a source checkout), then the CLI entry. */
  entry: string[]
  home: string
  project: string
  /** The PATH to run under — the installing shell's. */
  pathEnv: string
  /** Where the panel's console goes when the manager has no journal of its own (launchd). */
  logFile: string
  scope: ServiceScope
  /** The account a system unit runs as, so the home stays owned by the person who installed it. */
  user: string
  /** `home-hosted`, or `home-hosted-<fingerprint>` for a home that is not the default one. */
  name: string
}

/** The argv the manager runs: node, the entry, the home and project, `up --foreground`. */
export function serviceArgv(spec: Pick<ServiceSpec, 'node' | 'entry' | 'home' | 'project'>): string[] {
  return [spec.node, ...spec.entry, '--home', spec.home, '--project', spec.project, 'up', '--foreground']
}

/** One systemd word: quoted when it needs it, with `$` and `%` escaped (systemd expands both). */
function systemdWord(word: string): string {
  const escaped = word.replace(/%/g, '%%').replace(/\$/g, '$$$$')
  return /[\s"'\\]/.test(escaped) || escaped.length === 0 ? `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : escaped
}

/** `Environment="KEY=value"`, quoted for systemd. */
function systemdEnv(key: string, value: string): string {
  return `Environment=${systemdWord(`${key}=${value}`)}`
}

/**
 * Refuse a fact that cannot be represented in the file, before anything is rendered.
 *
 * Every value here comes from `process.argv`/`process.env` — `--home`, `--project`, `PATH` — so it is
 * input, not a constant. A **newline** is the one that matters: each generator writes one setting per
 * line, so `--home $'/tmp/x\nExecStartPre=/bin/evil'` injects a whole directive into a unit that starts
 * at boot (measured: the rendered unit gained an `ExecStartPre=/bin/evil` line). A carriage return does
 * the same in a `.cmd`/XML context, and NUL cannot be written at all.
 *
 * Escaping is not the answer here — a path with a newline in it is not a path anybody meant to type,
 * and every manager's line syntax would have to be re-derived per format. Refusing says what is wrong.
 */
export function validateServiceSpec(spec: Pick<ServiceSpec, 'node' | 'entry' | 'home' | 'project' | 'pathEnv' | 'logFile' | 'user' | 'name'>): void {
  const values: Array<[string, string]> = [
    ['node', spec.node],
    ['home', spec.home],
    ['project', spec.project],
    ['PATH', spec.pathEnv],
    ['log file', spec.logFile],
    ['user', spec.user],
    ['name', spec.name],
    ...spec.entry.map((value, index) => [`entry[${index}]`, value] as [string, string]),
  ]
  for (const [what, value] of values) {
    // A code-point scan rather than a literal control-character range, which linters flag (and which
    // is unreadable in a diff anyway). C0 except a plain space, plus DEL.
    for (const character of value) {
      const code = character.codePointAt(0)!
      const control = (code < 0x20 && code !== 0x09) || code === 0x7F
      if (control) {
        const codePoint = code.toString(16).toUpperCase().padStart(4, '0')
        throw new Error(`the ${what} contains a control character (U+${codePoint}), which a service file cannot carry: ${JSON.stringify(value)}`)
      }
    }
  }
}

export function systemdUnit(spec: ServiceSpec): string {
  const lines = [
    // Ownership first: `uninstall` and `status` refuse a file without it (see `SERVICE_MARKER`).
    markerLine('linux')!,
    '[Unit]',
    `Description=home-hosted control panel (${spec.home})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    ...(spec.scope === 'system' ? [`User=${spec.user}`] : []),
    `WorkingDirectory=${systemdWord(spec.project)}`,
    `ExecStart=${serviceArgv(spec).map(systemdWord).join(' ')}`,
    systemdEnv('HHOSTED_HOME', spec.home),
    systemdEnv('HHOSTED_PROJECT', spec.project),
    systemdEnv('PATH', spec.pathEnv),
    // Only the panel: it stops its own servers, and a persistent entry is meant to outlive it.
    'KillMode=process',
    // `down` exits 0 and stays down; a crash comes back.
    'Restart=on-failure',
    'RestartSec=5',
    // The panel waits out each entry's own stop grace before it exits.
    'TimeoutStopSec=600',
    '',
    '[Install]',
    `WantedBy=${spec.scope === 'system' ? 'multi-user.target' : 'default.target'}`,
    '',
  ]
  return lines.join('\n')
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The launchd label: reverse-DNS, as launchd expects. */
export function launchdLabel(name: string): string {
  return `dev.${name}`
}

export function launchdPlist(spec: ServiceSpec): string {
  const strings = (values: string[]): string => values.map(value => `    <string>${xml(value)}</string>`).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    // Ownership, in the one place an XML prolog allows a comment: `uninstall`/`status` refuse a file
    // without it (see `SERVICE_MARKER`).
    markerLine('darwin')!,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(launchdLabel(spec.name))}</string>`,
    ...(spec.scope === 'system' ? ['  <key>UserName</key>', `  <string>${xml(spec.user)}</string>`] : []),
    '  <key>ProgramArguments</key>',
    '  <array>',
    strings(serviceArgv(spec)),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(spec.project)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>HHOSTED_HOME</key>',
    `    <string>${xml(spec.home)}</string>`,
    '    <key>HHOSTED_PROJECT</key>',
    `    <string>${xml(spec.project)}</string>`,
    '    <key>PATH</key>',
    `    <string>${xml(spec.pathEnv)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // Restart on a crash, not after `home-hosted down` (exit 0).
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    // launchd's KillMode=process: a stop signals the panel, not every process it started.
    '  <key>AbandonProcessGroup</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(spec.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(spec.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** One Windows command-line argument, quoted the way `CommandLineToArgvW` reads it back. */
function windowsArg(word: string): string {
  if (word.length > 0 && !/[\s"]/.test(word))
    return word
  return `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/**
 * A Task Scheduler task: at logon for `user`, at boot as SYSTEM for `system`. A task cannot carry
 * environment variables, so the home and project travel as flags (they always do) and PATH is the
 * account's own.
 */
export function scheduledTaskXml(spec: ServiceSpec): string {
  const [command, ...args] = serviceArgv(spec)
  const trigger = spec.scope === 'system'
    ? '    <BootTrigger>\n      <Enabled>true</Enabled>\n    </BootTrigger>'
    : `    <LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>${xml(spec.user)}</UserId>\n    </LogonTrigger>`
  const principal = spec.scope === 'system'
    ? '    <Principal id="Author">\n      <UserId>S-1-5-18</UserId>\n      <RunLevel>HighestAvailable</RunLevel>\n    </Principal>'
    : `    <Principal id="Author">\n      <UserId>${xml(spec.user)}</UserId>\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>\n    </Principal>`
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    // Ownership, in the one free-text element a Task XML allows: `uninstall`/`status` refuse a task
    // without it (see `SERVICE_MARKER`). A scheduled task is addressed by **name** in a global folder,
    // so a task somebody else registered as `home-hosted` is exactly the case this guards.
    `    <Description>home-hosted control panel (${xml(spec.home)}) — ${xml(SERVICE_MARKER)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    trigger,
    '  </Triggers>',
    '  <Principals>',
    principal,
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(command!)}</Command>`,
    `      <Arguments>${xml(args.map(windowsArg).join(' '))}</Arguments>`,
    `      <WorkingDirectory>${xml(spec.project)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n')
}

/** The file a platform's manager reads, as text, plus how it is written to disk. */
export function renderService(platform: ServicePlatform, spec: ServiceSpec): { text: string, bytes: Buffer, fileName: string } {
  // Every path — `--print`, install, status, uninstall — renders first, so validating here covers all
  // of them. `--print` matters as much as install: a person copies that text into a unit by hand.
  validateServiceSpec(spec)
  if (platform === 'linux') {
    const text = systemdUnit(spec)
    return { text, bytes: Buffer.from(text, 'utf8'), fileName: `${spec.name}.service` }
  }
  if (platform === 'darwin') {
    const text = launchdPlist(spec)
    return { text, bytes: Buffer.from(text, 'utf8'), fileName: `${launchdLabel(spec.name)}.plist` }
  }
  const text = scheduledTaskXml(spec)
  // schtasks reads the encoding the declaration names: UTF-16 with a BOM.
  return { text, bytes: Buffer.from(`\uFEFF${text}`, 'utf16le'), fileName: `${spec.name}.xml` }
}

/**
 * Where the unit file goes. systemd and launchd read their own directories; Task Scheduler keeps
 * the task itself, so its XML is kept in the home as the record of what was registered.
 */
export function serviceDir(platform: ServicePlatform, scope: ServiceScope, context: { homedir: string, env: NodeJS.ProcessEnv, hhDir: string }): string {
  if (platform === 'linux') {
    if (scope === 'system')
      return '/etc/systemd/system'
    const config = context.env.XDG_CONFIG_HOME?.trim()
    return path.join(config !== undefined && config.length > 0 ? config : path.join(context.homedir, '.config'), 'systemd', 'user')
  }
  if (platform === 'darwin')
    return scope === 'system' ? '/Library/LaunchDaemons' : path.join(context.homedir, 'Library', 'LaunchAgents')
  return path.join(context.hhDir, '.service')
}

/** A command the installer runs; injectable so a test records instead of running. */
export type ServiceRunner = (command: string, args: string[]) => { status: number | null, stdout: string, stderr: string }

const defaultRunner: ServiceRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  return { status: result.error === undefined ? result.status : 127, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error?.message ?? '') }
}

/** The manager commands each action runs, in order. */
export function managerCommands(platform: ServicePlatform, scope: ServiceScope, action: 'install' | 'uninstall' | 'status', file: string, name: string): Array<[string, string[]]> {
  if (platform === 'linux') {
    const ctl = (...args: string[]): [string, string[]] => ['systemctl', [...(scope === 'user' ? ['--user'] : []), ...args]]
    const unit = `${name}.service`
    if (action === 'install')
      return [ctl('daemon-reload'), ctl('enable', '--now', unit)]
    if (action === 'uninstall')
      return [ctl('disable', '--now', unit), ctl('daemon-reload')]
    return [ctl('is-active', unit)]
  }
  if (platform === 'darwin') {
    if (action === 'install')
      return [['launchctl', ['load', '-w', file]]]
    if (action === 'uninstall')
      return [['launchctl', ['unload', '-w', file]]]
    return [['launchctl', ['list', launchdLabel(name)]]]
  }
  if (action === 'install')
    return [['schtasks', ['/Create', '/TN', name, '/XML', file]], ['schtasks', ['/Run', '/TN', name]]]
  if (action === 'uninstall')
    return [['schtasks', ['/End', '/TN', name]], ['schtasks', ['/Delete', '/TN', name, '/F']]]
  return [['schtasks', ['/Query', '/TN', name]]]
}

export interface ServiceOptions {
  action: 'install' | 'uninstall' | 'status'
  scope: ServiceScope
  print: boolean
  platform?: NodeJS.Platform
  /** Overrides `serviceDir()` — the seam that keeps a test off the real manager's directories. */
  targetDir?: string
  run?: ServiceRunner
  /** The facts a unit is built from; read from this process when absent. */
  spec?: ServiceSpec
  out?: (text: string) => void
}

/**
 * The PATH a unit runs under: this node's own directory first (so a server's `node` is the one the
 * panel runs on), then the installing shell's — minus fnm's per-shell directories, which are gone
 * after the next reboot.
 */
export function servicePath(current: string, node: string): string {
  const separator = process.platform === 'win32' ? ';' : ':'
  const parts = current.split(separator).filter(part => part.length > 0 && !/fnm_multishells/.test(part))
  return [...new Set([path.dirname(node), ...parts])].join(separator)
}

/** Builds the spec from this process: its node, its entry, its home and project, its PATH. */
export async function currentSpec(entry: string, scope: ServiceScope): Promise<ServiceSpec> {
  const { runtimeArgs } = await import('#src/helpers/runtime')
  const { daemonLogPath, dataRoot, homeFingerprint, projectDir } = await import('#src/helpers/paths')
  const defaultHome = path.join(os.homedir(), '.home-hosted')
  const name = path.resolve(dataRoot) === path.resolve(defaultHome) ? 'home-hosted' : `home-hosted-${homeFingerprint(dataRoot).slice(0, 8)}`
  return {
    node: process.execPath,
    entry: [...runtimeArgs(), entry],
    home: dataRoot,
    project: projectDir,
    pathEnv: servicePath(process.env.PATH ?? '', process.execPath),
    logFile: daemonLogPath,
    scope,
    user: serviceUser(),
    name,
  }
}

/**
 * The account a unit should run as — the person, not whoever elevated the command.
 *
 * `sudo` and `pkexec` rewrite `USER`, `LOGNAME` and `HOME` to the target, so a panel started from a
 * root shell reads `USER=root` and `os.userInfo()` reports the **euid** — both would write
 * `User=root` for somebody who only meant to install a service. `SUDO_USER` is the instruction that
 * survives, and it is right in every ordinary case.
 *
 * It is an environment variable, though, so it can also be stale or simply wrong: a shell that
 * inherited `SUDO_USER=root` from an ancestor would collapse the unit to root. Its sibling
 * `SUDO_UID` is the fact, so the name is only trusted while the two agree — and the same for
 * `PKEXEC_USER`/`PKEXEC_UID`. A name stated alone is accepted (an elevating tool that rewrote
 * `$HOME` and set only the name is still an explicit statement about an account, and `--print` lets
 * a person see what would be written before anything runs).
 */
export function serviceUser(env: NodeJS.ProcessEnv = process.env): string {
  const own = os.userInfo().username
  const pairs: Array<[string | undefined, string | undefined]> = [
    [env.SUDO_USER, env.SUDO_UID],
    [env.PKEXEC_USER, env.PKEXEC_UID],
  ]
  for (const [name, uid] of pairs) {
    const wanted = name?.trim()
    if (wanted === undefined || wanted.length === 0)
      continue
    const asNumber = uid === undefined ? Number.NaN : Number.parseInt(uid, 10)
    // No uid beside it: nothing to check the name against, so take the statement.
    if (!Number.isInteger(asNumber) || asNumber <= 0)
      return wanted
    // Both present: they must agree with each other *and* be an account we can see, or the
    // environment is inconsistent and the process's own login is the safer answer.
    const entry = passwdEntryFor(asNumber)
    if (entry !== null && entry === wanted)
      return wanted
  }
  return own
}

/** The login name owning `uid`, or `null` when the platform cannot tell us. */
function passwdEntryFor(uid: number): string | null {
  try {
    // `/etc/passwd` is the portable answer on Linux and macOS; Windows has no such file, and there
    // the caller has no elevating tool of this shape to worry about.
    const text = fs.readFileSync('/etc/passwd', 'utf8')
    for (const line of text.split('\n')) {
      const fields = line.split(':')
      if (fields.length > 2 && Number.parseInt(fields[2] ?? '', 10) === uid)
        return fields[0] ?? null
    }
    return null
  }
  catch {
    return null
  }
}

function asPlatform(platform: NodeJS.Platform): ServicePlatform {
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32')
    return platform
  fail(`no service manager this command knows on ${platform} — run \`${invocation()} up --foreground\` under your own`)
}

/**
 * Whether the file at `file` carries this command's marker.
 *
 * A read that fails counts as **not ours**: refusing to act is always the safe direction here, and
 * `uninstall` deleting the wrong file is not recoverable. Windows is checked through `schtasks
 * /Query /XML` rather than the file, because a scheduled task lives in the Task Scheduler's own store
 * — but the same marker rides in its `<Description>`.
 */
function ownsFile(file: string, platform: ServicePlatform, run: ServiceRunner, name: string): boolean {
  try {
    if (platform === 'win32') {
      // A task lives in the Task Scheduler's own store, not in the file `install` staged, so its XML
      // is what proves ownership — and `/Query` exits non-zero for a name nobody registered, which
      // is the same "not ours" as an unmarked file.
      const result = run('schtasks', ['/Query', '/TN', name, '/XML'])
      return result.status === 0 && isServiceOurs(result.stdout, platform)
    }
    return isServiceOurs(fs.readFileSync(file, 'utf8'), platform)
  }
  catch {
    return false
  }
}

export async function runService(options: ServiceOptions, entry: string): Promise<void> {
  const platform = asPlatform(options.platform ?? process.platform)
  const out = options.out ?? ((text: string) => process.stdout.write(text))
  const run = options.run ?? defaultRunner
  const spec = options.spec ?? await currentSpec(entry, options.scope)
  const rendered = renderService(platform, spec)

  if (options.print) {
    out(rendered.text)
    return
  }

  const dir = options.targetDir ?? serviceDir(platform, options.scope, { homedir: os.homedir(), env: process.env, hhDir: (await import('#src/helpers/paths')).hhDir })
  const file = path.join(dir, rendered.fileName)
  const commands = managerCommands(platform, options.scope, options.action, file, spec.name)

  if (options.action === 'status') {
    if (!fs.existsSync(file)) {
      out(`not installed ${dim(`(no ${file}) — \`${invocation()} service install${options.scope === 'system' ? ' --system' : ''}\` adds it`)}\n`)
      process.exitCode = 1
      return
    }
    // A file at our path is not proof it is ours: `home-hosted.service` is the name a distro package
    // or a hand-written README unit uses. Reporting on one would claim a panel starts at boot when
    // that unit runs something else entirely.
    if (!ownsFile(file, platform, run, spec.name)) {
      out(`${paint('33', 'note')} ${file} exists but was not written by this command — leaving it alone\n`)
      out(`${dim('  \`service install\` refuses to replace it; remove it yourself if it is yours')}\n`)
      process.exitCode = 1
      return
    }
    out(`${green('installed')} ${file}\n`)
    for (const [command, args] of commands) {
      const result = run(command, args)
      out(`  ${dim(`${command} ${args.join(' ')}:`)} ${(result.stdout.trim() || result.stderr.trim() || `exit ${result.status}`).split('\n')[0]}\n`)
    }
    return
  }

  if (options.action === 'uninstall') {
    if (!fs.existsSync(file))
      fail(`not installed — there is no ${file}`)
    // Never delete a unit or task this command did not write. The name is one a distro package or a
    // person's own unit can use, and removing it would stop a panel this command never started.
    if (!ownsFile(file, platform, run, spec.name))
      fail(`${file} was not written by \`${invocation()} service install\` — refusing to remove it; delete it yourself if it is yours`)
    for (const [command, args] of commands) {
      const result = run(command, args)
      if (result.status !== 0)
        process.stderr.write(`${paint('33', 'note')} ${command} ${args.join(' ')}: ${result.stderr.trim() || `exit ${result.status}`}\n`)
    }
    fs.rmSync(file, { force: true })
    out(`${green('removed')} ${file}\n`)
    return
  }

  // Install. Refused over an existing one: a second install would replace a unit someone may have
  // edited, and re-registering a running service is a restart nobody asked for.
  if (fs.existsSync(file))
    fail(`already installed at ${file} — \`${invocation()} service uninstall${options.scope === 'system' ? ' --system' : ''}\` first, or edit it there`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, rendered.bytes, { mode: 0o644 })
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    fail(code === 'EACCES' || code === 'EPERM'
      ? `cannot write ${file} — a --system service needs an administrator (sudo on Linux and macOS)`
      : `cannot write ${file}: ${(error as Error).message}`)
  }
  out(`${green('wrote')} ${file}\n`)
  for (const [command, args] of commands) {
    const result = run(command, args)
    if (result.status !== 0)
      fail(`\`${command} ${args.join(' ')}\` failed: ${result.stderr.trim() || `exit ${result.status}`} — the file is in place; fix that and run it yourself`)
  }
  out(`${green('installed')} ${spec.name} — it starts at ${options.scope === 'system' ? 'boot' : 'login'} and is running now\n`)
  if (platform === 'linux' && options.scope === 'user')
    out(`${dim(`a user service stops at logout and waits for a login after a reboot — \`loginctl enable-linger ${spec.user}\` keeps it running without one`)}\n`)
  out(`${dim(`stop it with \`${platform === 'linux' ? `systemctl ${options.scope === 'user' ? '--user ' : ''}stop ${spec.name}` : platform === 'darwin' ? `launchctl unload ${file}` : `schtasks /End /TN ${spec.name}`}\` — \`down\` also works, and it stays down until the next ${options.scope === 'system' ? 'boot' : 'login'}`)}\n`)
}

export function serviceCommand(entry: string) {
  return defineCommand({
    meta: { name: 'service' },
    args: {
      action: { type: 'positional', required: false, description: 'install | uninstall | status' },
      user: { type: 'boolean', description: 'a service for this account (the default)' },
      system: { type: 'boolean', description: 'a machine-wide service, started at boot (needs an administrator)' },
      print: { type: 'boolean', description: 'with install: print the unit and install nothing' },
    },
    run: async ({ args }) => {
      const action = typeof args.action === 'string' && args.action.length > 0 ? args.action : 'status'
      if (action !== 'install' && action !== 'uninstall' && action !== 'status')
        fail(`unknown service action "${action}" — install, uninstall or status`)
      if (args.user === true && args.system === true)
        fail('pick one of --user and --system')
      if (args.print === true && action !== 'install')
        fail(`--print does nothing for \`service ${action}\` — it prints the unit \`install\` would write`)
      await runService({ action, scope: args.system === true ? 'system' : 'user', print: args.print === true }, entry)
    },
  })
}
