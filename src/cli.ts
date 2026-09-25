import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * The command line. Everything here works before the state directories are known
 * (so `--home`/`--project` can point them somewhere), which is why the modules
 * that read those paths are imported dynamically instead of at the top.
 */

const CLI_ENTRY = fileURLToPath(import.meta.url)
const DEFAULT_PORT = 3999
const LOG_ROTATE_BYTES = 5 * 1024 * 1024

const USAGE = `home-hosted — a control panel for the processes on your home server

Usage
  home-hosted up [options]      start it in the background (detached)
  home-hosted down              stop it, and everything it supervises
  home-hosted restart [options] down, then up
  home-hosted status [--json]   is it running, where, and how to reach it
  home-hosted set-password      set the panel password without the API
  home-hosted set-token         set the API token that scripts and agents use
  home-hosted migrate           bring the config up to this release's schema
  home-hosted init              scaffold a project that keeps its state in the repo
  home-hosted ui-switch         install a UI from a release asset, a zip file or a URL
  home-hosted ui-revert         go back to the stock control panel UI

Options for up/restart
  -c, --config <file>   servers config (default: <state>/servers.config.json)
  -p, --port <port>     control panel port (default: ${DEFAULT_PORT})
      --host <bind>     local | lan | an ipv4 address (default: local)
      --open            open the panel in a browser once it is up
      --no-autostart    do not start the entries marked autostart
      --foreground      run in this process instead of detaching (systemd/docker)
      --print-config    print the effective config and exit

Options for set-token
      --generate        create a strong token and print it once
      --clear           remove the token, so it stops working

Options for migrate
      --dry-run         print what would change, write nothing
  -y, --yes             apply without asking (or set HHOSTED_MIGRATE=allow)

Options for init
      --dir <dir>       where to scaffold (default: ./my-servers)
      --name <name>     package name (default: the directory name)
      --pm <manager>    pnpm | npm | yarn | bun (default: the first one installed)
      --no-install      write the files, install nothing
  -y, --yes             take every default, ask nothing

Options for ui-switch
      --repo <owner/name>   release repo (default: NamesMT/home-hosted)
      --tag <tag>           release tag (default: this release's tag, or latest for another repo)
      --asset <name>        asset to install (exact or unambiguous match)
      --file <path|url>     install a zip from a local path or an http(s) URL
      --list                list the usable assets and install nothing
      --token <token>       GitHub token (or GITHUB_TOKEN / GH_TOKEN)
  -y, --yes                 take the only asset instead of asking

Everywhere
      --home <dir>      state directory (default: $HHOSTED_HOME or ~/.home-hosted)
      --project <dir>   base for relative entry paths (default: the current directory)
  -h, --help            this text
  -v, --version         the version

Environment
  HHOSTED_HOME          where config, secrets, logs, TLS and backups live
  HHOSTED_PROJECT       base for relative entry paths
  HHOSTED_PASSWORD      the password for a non-interactive set-password
  HHOSTED_TOKEN         the token for a non-interactive set-token
  GITHUB_TOKEN          a GitHub token for ui-switch (GH_TOKEN also works)
`

const isTty = (): boolean => process.stdout.isTTY === true
const paint = (code: string, text: string): string => (isTty() ? `\x1B[${code}m${text}\x1B[0m` : text)
const dim = (text: string): string => paint('2', text)
const bold = (text: string): string => paint('1', text)
const green = (text: string): string => paint('32', text)

function fail(message: string): never {
  process.stderr.write(`${paint('31', 'error')} ${message}\n`)
  process.exit(1)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface DirFlags {
  project?: string
  home?: string
}

/** `--home`/`--project` are handled for every command, so they are peeled off first. */
function extractDirFlags(argv: string[]): { rest: string[] } & DirFlags {
  const rest: string[] = []
  let project: string | undefined
  let home: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (name !== '--project' && name !== '--home') {
      rest.push(arg)
      continue
    }
    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1)
    if (value === undefined || value.length === 0)
      fail(`${name} needs a directory`)
    if (name === '--project')
      project = value
    else
      home = value
  }

  return { rest, project, home }
}

/** Set before any state module is imported, so it decides where state lives. */
function applyDirFlags(flags: DirFlags): void {
  if (flags.project !== undefined)
    process.env.HHOSTED_PROJECT = path.resolve(flags.project)
  if (flags.home !== undefined)
    process.env.HHOSTED_HOME = path.resolve(flags.home)
}

interface UpFlags {
  config?: string
  port?: number
  host?: string
  autostart: boolean
  open: boolean
  foreground: boolean
  printConfig: boolean
}

function parseUpFlags(argv: string[]): UpFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      'config': { type: 'string', short: 'c' },
      'port': { type: 'string', short: 'p' },
      'host': { type: 'string' },
      'no-autostart': { type: 'boolean' },
      'open': { type: 'boolean' },
      'foreground': { type: 'boolean' },
      'print-config': { type: 'boolean' },
    },
    allowPositionals: false,
  })

  let port: number | undefined
  if (values.port !== undefined) {
    port = Number.parseInt(values.port, 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      fail(`invalid port: ${values.port}`)
  }

  return {
    config: values.config,
    port,
    host: values.host,
    autostart: values['no-autostart'] !== true,
    open: values.open === true,
    foreground: values.foreground === true,
    printConfig: values['print-config'] === true,
  }
}

/** The daemon gets the same instructions, but never `--foreground`. */
function daemonFlags(flags: UpFlags): string[] {
  const args: string[] = []
  if (flags.config !== undefined)
    args.push('--config', flags.config)
  if (flags.port !== undefined)
    args.push('--port', String(flags.port))
  if (flags.host !== undefined)
    args.push('--host', flags.host)
  if (!flags.autostart)
    args.push('--no-autostart')
  if (flags.open)
    args.push('--open')
  return args
}

/**
 * How to run this CLI again in the same runtime. Under tsx that means passing the
 * resolved loader too, because the daemon's working directory is the project's,
 * not the package's.
 */
function runtimeArgs(): string[] {
  let resolved: string | null = null
  const resolveTsx = (): string => resolved ??= import.meta.resolve('tsx')

  return process.execArgv.map((arg) => {
    if (arg === 'tsx')
      return resolveTsx()
    if (arg.startsWith('--import=') && arg.slice('--import='.length) === 'tsx')
      return `--import=${resolveTsx()}`
    return arg
  })
}

/** One rotation is enough for a console log. */
function rotateLog(file: string): void {
  try {
    if (fs.statSync(file).size < LOG_ROTATE_BYTES)
      return
    fs.rmSync(`${file}.1`, { force: true })
    fs.renameSync(file, `${file}.1`)
  }
  catch {
    // no log yet
  }
}

function tailLog(file: string, lines = 15): string {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n').trimEnd()
  }
  catch {
    return ''
  }
}

async function up(argv: string[]): Promise<void> {
  const flags = parseUpFlags(argv)
  const { runControlPlane } = await import('#src/index')

  if (flags.foreground) {
    await runControlPlane({
      configPath: flags.config,
      port: flags.port,
      host: flags.host,
      autostart: flags.autostart,
      open: flags.open,
      printConfig: flags.printConfig,
    })
    return
  }

  const { clearRuntime, isProcessAlive, readRuntime } = await import('#src/helpers/daemon')
  const { daemonLogPath, dataRoot, projectDir } = await import('#src/helpers/paths')

  const existing = readRuntime()
  if (existing !== null && isProcessAlive(existing.pid)) {
    process.stdout.write(`${green('already running')} (pid ${existing.pid}) at ${existing.url}\n`)
    process.stdout.write(`${dim('stop it with `home-hosted down`')}\n`)
    return
  }
  if (existing !== null)
    clearRuntime()

  fs.mkdirSync(path.dirname(daemonLogPath), { recursive: true })
  rotateLog(daemonLogPath)
  const log = fs.openSync(daemonLogPath, 'a')

  const child = spawn(process.execPath, [...runtimeArgs(), CLI_ENTRY, 'up', '--foreground', ...daemonFlags(flags)], {
    detached: true,
    cwd: projectDir,
    env: { ...process.env, HHOSTED_HOME: dataRoot, HHOSTED_PROJECT: projectDir },
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  child.unref()
  fs.closeSync(log)

  const runtime = await waitForStartup(child)
  if (runtime === null) {
    const output = tailLog(daemonLogPath)
    process.stderr.write(`${paint('31', 'error')} the control panel did not start\n`)
    if (output.length > 0)
      process.stderr.write(`${dim(`${daemonLogPath}:`)}\n${output}\n`)
    process.exit(1)
  }

  process.stdout.write(`${green('home-hosted is up')} (pid ${runtime.pid})\n`)
  process.stdout.write(`  ${bold(runtime.url)}\n`)
  process.stdout.write(`  ${dim(`project ${runtime.projectDir}`)}\n`)
  process.stdout.write(`  ${dim(`state   ${runtime.dataRoot}`)}\n`)
  process.stdout.write(`  ${dim(`log     ${runtime.logFile}`)}\n`)
}

async function waitForStartup(child: ChildProcess, timeoutMs = 20000) {
  const { readRuntime } = await import('#src/helpers/daemon')
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      return null

    const runtime = readRuntime()
    if (runtime !== null && runtime.pid === child.pid)
      return runtime

    if (Date.now() > deadline)
      return null
    await delay(150)
  }
}

async function down(): Promise<void> {
  const { clearRuntime, isProcessAlive, readRuntime, requestShutdown } = await import('#src/helpers/daemon')

  const runtime = readRuntime()
  if (runtime === null) {
    process.stdout.write('home-hosted is not running\n')
    return
  }
  if (!isProcessAlive(runtime.pid)) {
    clearRuntime()
    process.stdout.write('home-hosted is not running (removed a stale run.json)\n')
    return
  }

  process.stdout.write(`stopping pid ${runtime.pid}…\n`)
  // The panel's own endpoint stops supervised servers cleanly on every platform;
  // a signal is the fallback for a wedged or unreachable process.
  if (!(await requestShutdown(runtime)))
    signal(runtime.pid, 'SIGTERM')

  if (await waitForExit(runtime.pid, 20000)) {
    clearRuntime()
    process.stdout.write(`${green('stopped')}\n`)
    return
  }

  process.stdout.write(`${dim('it did not stop in time — forcing')}\n`)
  forceStop(runtime.pid)
  await waitForExit(runtime.pid, 5000)
  clearRuntime()
  process.stdout.write(`${green('stopped')} (forced)\n`)
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const { isProcessAlive } = await import('#src/helpers/daemon')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid))
      return true
    await delay(200)
  }
  return !isProcessAlive(pid)
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  }
  catch {
    // already gone
  }
}

/** Windows cannot deliver a graceful signal, so the whole tree is killed. */
function forceStop(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  signal(pid, 'SIGKILL')
}

async function restart(argv: string[]): Promise<void> {
  await down()
  await up(argv)
}

async function status(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' } },
    allowPositionals: false,
  })
  const { isProcessAlive, probeRuntime, readRuntime } = await import('#src/helpers/daemon')
  const { UiService } = await import('#src/services/ui')
  const { dataRoot } = await import('#src/helpers/paths')
  const runtime = readRuntime()

  if (runtime === null) {
    if (values.json)
      process.stdout.write(`${JSON.stringify({ running: false }, null, 2)}\n`)
    else
      process.stdout.write('home-hosted is not running\n')
    process.exitCode = 1
    return
  }

  const running = isProcessAlive(runtime.pid)
  const probe = running ? await probeRuntime(runtime) : { reachable: false, degraded: false }

  if (values.json) {
    // The token is what authorises a local shutdown; a script only needs the rest.
    const { token: _token, ...safe } = runtime
    process.stdout.write(`${JSON.stringify({ running, answering: probe.reachable, degraded: probe.degraded, ...safe }, null, 2)}\n`)
    if (!running)
      process.exitCode = 1
    return
  }

  const uptime = formatDuration(Date.now() - runtime.startedAt)
  const state = !running
    ? paint('31', 'stale (the process is gone)')
    : probe.degraded
      ? paint('33', 'running — a server needs attention')
      : probe.reachable ? green('running') : paint('33', 'running, but not answering')

  const ui = new UiService({ dataRoot })
  const rows: Array<[string, string]> = [
    ['status', state],
    ['pid', running ? `${runtime.pid} · up ${uptime}` : String(runtime.pid)],
    ['url', `${runtime.url} ${dim(`(${runtime.protocol})`)}`],
    ['version', runtime.version],
    ['project', runtime.projectDir],
    ['state', runtime.dataRoot],
    ['config', runtime.configPath],
    ['log', runtime.logFile],
    ['ui', ui.custom ? `custom — ${ui.status().meta?.name ?? 'installed'} (revert with \`home-hosted ui-revert\`)` : 'stock'],
  ]

  process.stdout.write(`${bold(`home-hosted ${runtime.version}`)}\n`)
  for (const [label, value] of rows)
    process.stdout.write(`  ${dim(label.padEnd(8))} ${value}\n`)
  if (!running)
    process.exitCode = 1
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** A plain y/N question, for decisions that are not secrets. */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** Reads a line with echo suppressed, so the password never lands in scrollback. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const onData = (): void => {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(question)
    }

    process.stdin.on('data', onData)
    rl.question(question, (answer) => {
      process.stdin.off('data', onData)
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

/**
 * Brings `servers.config.json` up to the schema this release understands.
 *
 * Deliberately loud and deliberate: it prints every step first, backs the file up
 * before writing, refuses to write a config it cannot read, and never runs on its
 * own — a detached daemon cannot prompt, so consent comes from `--yes`, from
 * `HHOSTED_MIGRATE=allow`, or from a person at a terminal.
 */
async function migrateConfig(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'config': { type: 'string', short: 'c' },
      'dry-run': { type: 'boolean' },
      'yes': { type: 'boolean', short: 'y' },
    },
    allowPositionals: false,
  })

  const { defaultConfigPath } = await import('#src/helpers/paths')
  const { applyConfigMigrations, CONFIG_SCHEMA, planConfigMigrations } = await import('#src/config/migrations')
  const { parseConfig, stampConfig } = await import('#src/config/parse')
  const { writeFileAtomic } = await import('#src/helpers/atomic')
  const { appVersion } = await import('#src/helpers/version')

  const file = values.config ?? defaultConfigPath
  if (!fs.existsSync(file))
    fail(`no config at ${file} — nothing to migrate`)

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  }
  catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const meta = typeof raw.meta === 'object' && raw.meta !== null ? raw.meta as { schema?: number, writtenBy?: string } : {}
  const from = typeof meta.schema === 'number' ? meta.schema : CONFIG_SCHEMA
  const plan = planConfigMigrations(from)

  if (plan.tooNew) {
    fail(`${file} was written by home-hosted ${meta.writtenBy ?? 'a newer release'} (config schema ${from});\n  this release understands schema ${plan.to}. Install that version, or edit the file yourself.`)
  }

  const stamped = stampConfig(raw)
  const upToDate = plan.steps.length === 0
  if (upToDate && values['dry-run'] !== true && JSON.stringify(stamped) !== JSON.stringify(raw)) {
    writeFileAtomic(file, `${JSON.stringify(stamped, null, 2)}\n`)
    process.stdout.write(`${green('config stamped')} in ${file} — written by home-hosted ${appVersion()}, schema ${plan.to}\n`)
    return
  }

  if (upToDate) {
    process.stdout.write(`config schema ${from} is already what home-hosted ${appVersion()} understands — nothing to migrate\n`)
    return
  }

  process.stdout.write(`migrating ${file}: config schema ${from} → ${plan.to}\n`)
  for (const [index, step] of plan.steps.entries())
    process.stdout.write(`  ${index + 1}. ${step.describe}\n`)

  if (values['dry-run'] === true) {
    process.stdout.write(`${dim(`nothing was written (--dry-run, ${plan.steps.length} step(s) pending)`)}\n`)
    return
  }

  const consented = values.yes === true || (process.env.HHOSTED_MIGRATE ?? '').toLowerCase() === 'allow'
  if (!consented) {
    if (process.stdin.isTTY !== true) {
      fail(`this config needs ${plan.steps.length} migration(s) and this session cannot ask.\n  re-run with --yes, or set HHOSTED_MIGRATE=allow for unattended runs`)
    }
    const answer = await prompt(`Apply ${plan.steps.length} migration(s) to ${path.basename(file)}? [y/N] `)
    if (!/^yes$|^y$/i.test(answer.trim())) {
      process.stdout.write('cancelled — nothing was written\n')
      return
    }
  }

  const { config, applied } = applyConfigMigrations(raw, from)
  const parsed = parseConfig(config)
  if (parsed.config === null) {
    fail(`the migration produced a config this release cannot read:\n  ${parsed.errors.join('\n  ')}`)
  }

  const backup = `${file}.bak`
  fs.copyFileSync(file, backup)
  writeFileAtomic(file, `${JSON.stringify(stampConfig(config), null, 2)}\n`)
  process.stdout.write(`${green(`migrated to schema ${plan.to}`)} (${applied.length} step(s)) in ${file}\n`)
  process.stdout.write(`  ${dim(`previous file kept at ${backup}`)}\n`)
  for (const key of parsed.unknownKeys)
    process.stdout.write(`  ${dim(`still ignoring an unrecognized key: ${key}`)}\n`)
}

/** Asks a yes/no question with a default, so an empty answer is a real answer. */
async function confirm(question: string, fallback: boolean): Promise<boolean> {
  const answer = (await prompt(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  if (answer.length === 0)
    return fallback
  return answer === 'y' || answer === 'yes'
}

function which(command: string): boolean {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
  return probe.status === 0
}

/**
 * Scaffolds a project that keeps its whole setup — state, data and the server
 * definitions — inside its own directory. Interactive by nature, but `--yes`
 * takes every default so an agent or a CI job can run it unattended.
 */
async function initProject(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dir': { type: 'string' },
      'name': { type: 'string' },
      'pm': { type: 'string' },
      'no-install': { type: 'boolean' },
      'yes': { type: 'boolean', short: 'y' },
    },
    allowPositionals: false,
  })

  const { detectPackageManager, installArgs, PACKAGE_MANAGERS, runCommand, scaffold } = await import('#src/services/init')
  const assumeYes = values.yes === true
  if (!assumeYes && process.stdin.isTTY !== true) {
    fail('init needs a terminal to ask in.\n  take the defaults with: home-hosted init --yes [--dir <dir>]')
  }

  const defaultDir = values.dir ?? './my-servers'
  const dir = assumeYes ? defaultDir : (await prompt(`Project directory (${defaultDir}) `)).trim() || defaultDir
  const defaultName = path.basename(path.resolve(dir))
  const name = values.name ?? (assumeYes ? defaultName : (await prompt(`Package name (${defaultName}) `)).trim() || defaultName)

  let pm = values.pm
  if (pm !== undefined && !(PACKAGE_MANAGERS as string[]).includes(pm))
    fail(`unknown package manager: ${pm} (expected one of ${PACKAGE_MANAGERS.join(', ')})`)
  const detected = detectPackageManager(which)
  if (pm === undefined)
    pm = assumeYes ? detected : (await prompt(`Package manager (${detected}) `)).trim() || detected

  const install = values['no-install'] === true
    ? false
    : assumeYes || (await confirm('Install the dependencies now?', true))
  const git = assumeYes ? which('git') : which('git') && (await confirm('Initialize a git repository?', true))

  try {
    const result = scaffold({ dir: dir!, name, pm: pm as never, install, git })
    process.stdout.write(`${green('project created')} in ${result.dir}\n`)
    for (const file of result.files)
      process.stdout.write(`  ${dim(file)}\n`)
  }
  catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const target = path.resolve(dir!)
  if (git) {
    spawnSync('git', ['init', '-q'], { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' })
    process.stdout.write(`  ${dim('git repository initialized')}\n`)
  }

  if (install) {
    process.stdout.write(`${dim(`installing with ${pm}…`)}\n`)
    const result = spawnSync(pm as string, installArgs(pm as never), {
      cwd: target,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) {
      process.stdout.write(`${paint('33', 'install failed')} — run it yourself in ${target}\n`)
    }
  }

  // A path inside the working directory reads better relative; anything else absolute.
  const relative = path.relative(process.cwd(), target)
  const where = relative.length === 0 || relative.startsWith('..') ? target : relative
  const cd = relative.length === 0 ? '' : `cd ${where} && `
  process.stdout.write(`\nNext:\n`)
  process.stdout.write(`  ${bold(`${cd}${runCommand(pm as never, 'up')}`)}     start the panel (default password \`hh\`)\n`)
  process.stdout.write(`  ${dim('then change that password under Settings → Authentication, and add your servers')}\n`)
  process.stdout.write(`  ${dim(`${runCommand(pm as never, 'set-token')} --generate    for scripts and agents`)}\n`)
}

/** Drops a user-installed UI so the stock panel serves again. */
async function uiRevert(): Promise<void> {
  const { UiService } = await import('#src/services/ui')
  const { dataRoot } = await import('#src/helpers/paths')
  const ui = new UiService({ dataRoot })

  if (!ui.custom) {
    process.stdout.write('no custom UI is installed — the stock panel is already in use\n')
    return
  }
  ui.revert()
  process.stdout.write(`${green('custom UI removed')} — the stock panel is back; refresh the browser\n`)
}

async function setPassword(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { clear: { type: 'boolean' } },
    allowPositionals: false,
  })
  const { defaultSecretsPath } = await import('#src/helpers/paths')
  const { SecretsStore } = await import('#src/config/secrets')
  const store = new SecretsStore(defaultSecretsPath)

  if (values.clear === true) {
    store.clearPassword()
    process.stdout.write(`cleared the control panel password in ${defaultSecretsPath}\n`)
    process.stdout.write(`${dim('authentication stays disabled until you enable it again in the settings page')}\n`)
    return
  }

  const interactive = process.stdin.isTTY === true
  let password = process.env.HHOSTED_PASSWORD

  if (password === undefined && interactive) {
    password = await promptHidden('New control panel password: ')
    const again = await promptHidden('Repeat it: ')
    if (password !== again)
      fail('the passwords do not match')
  }

  if (password === undefined || password.length === 0) {
    fail('no password given: run interactively, or set HHOSTED_PASSWORD for a non-interactive run')
  }

  store.setPassword(password)
  process.stdout.write(`${green('password stored')} in ${defaultSecretsPath} (mode 0600)\n`)
  if (password.length < 8)
    process.stdout.write(`${dim(`"${password}" is short — easy to guess if the panel is reachable beyond loopback`)}\n`)
  process.stdout.write(`${dim('restart the panel for it to take effect: home-hosted restart')}\n`)
}

/**
 * The bearer credential for scripts and agents. Unlike a session it survives a
 * restart, so an agent can set it up once and then just send the header.
 */
async function setToken(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { generate: { type: 'boolean' }, clear: { type: 'boolean' } },
    allowPositionals: false,
  })
  if (values.generate === true && values.clear === true)
    fail('use either --generate or --clear, not both')

  const { defaultSecretsPath } = await import('#src/helpers/paths')
  const { generateApiToken, SecretsStore } = await import('#src/config/secrets')
  const store = new SecretsStore(defaultSecretsPath)

  if (values.clear === true) {
    if (!store.apiTokenSet) {
      process.stdout.write('no API token is set — nothing to clear\n')
      return
    }
    store.clearApiToken()
    process.stdout.write(`${green('API token cleared')} in ${defaultSecretsPath} — it stops working immediately\n`)
    return
  }

  let token: string | null = process.env.HHOSTED_TOKEN ?? null
  if (values.generate === true)
    token = generateApiToken()
  else if (token === null && process.stdin.isTTY === true)
    token = await promptHidden('API token: ')
  if (token !== null)
    token = token.trim()
  if (token === null || token.length === 0) {
    fail('no token given: run `home-hosted set-token --generate`, set HHOSTED_TOKEN, or paste one interactively')
  }

  store.setApiToken(token)
  const generated = values.generate === true
  process.stdout.write(`${green(generated ? 'token generated' : 'token stored')} in ${defaultSecretsPath} (mode 0600)\n`)
  if (generated) {
    process.stdout.write(`  ${bold(token)}\n`)
    process.stdout.write(`${dim('  shown once — only its SHA-256 is kept on disk, so copy it now')}\n`)
  }
  else {
    process.stdout.write(`${dim(`  stored as ${token.slice(0, 8)}… — the file keeps only its hash`)}\n`)
  }

  const { readRuntime } = await import('#src/helpers/daemon')
  // Only the panel that owns *this* state directory is worth asking: guessing a
  // port would probe someone else's panel and call the mismatch a failure.
  const runtime = readRuntime()
  const base = (runtime?.url ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/+$/, '')

  if (runtime !== null) {
    const verified = await verifyToken(base, token)
    if (verified === true)
      process.stdout.write(`${dim(`verified: ${base}/api/auth/session accepted it`)}\n`)
    else if (verified === false)
      process.stdout.write(`${dim(`the panel at ${base} did not accept it — is it running with this state directory?`)}\n`)
  }

  process.stdout.write(`Use it from a script or an agent:\n`)
  process.stdout.write(`  ${bold(`curl -H "Authorization: Bearer ${generated ? token : '<token>'}" ${base}/api/state`)}\n`)
  process.stdout.write(`${dim('It needs no restart, outlives sessions, and holds the same access as a signed-in browser.')}\n`)
  process.stdout.write(`${dim('Remove it any time with: home-hosted set-token --clear')}\n`)
  if (store.usingDefaultPassword)
    process.stdout.write(`${dim('The panel password is still the default — change it before the panel is reachable beyond loopback.')}\n`)
}

/** Asks the live panel whether it accepts the token, without failing when it cannot. */
async function verifyToken(base: string, token: string): Promise<boolean | null> {
  // An https endpoint is usually TLS this project generated itself, which a plain
  // fetch refuses; the liveness probe in `helpers/daemon` is the one that knows how.
  if (!base.startsWith('http://'))
    return null
  try {
    const response = await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok)
      return false
    const body = await response.json() as { authenticated?: boolean }
    return body.authenticated === true
  }
  catch {
    return null
  }
}

function version(): void {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
  process.stdout.write(`${manifest.version ?? '0.0.0'}\n`)
}

async function main(): Promise<void> {
  const { rest, ...dirFlags } = extractDirFlags(process.argv.slice(2))
  const [command = '', ...args] = rest

  if (command === '' && rest.length === 0) {
    applyDirFlags(dirFlags)
    await up([])
    return
  }

  switch (command) {
    case 'up':
      applyDirFlags(dirFlags)
      await up(args)
      return
    case 'down':
      applyDirFlags(dirFlags)
      await down()
      return
    case 'restart':
      applyDirFlags(dirFlags)
      await restart(args)
      return
    case 'status':
      applyDirFlags(dirFlags)
      await status(args)
      return
    case 'set-password':
      applyDirFlags(dirFlags)
      await setPassword(args)
      return
    case 'set-token':
      applyDirFlags(dirFlags)
      await setToken(args)
      return
    case 'migrate':
      applyDirFlags(dirFlags)
      await migrateConfig(args)
      return
    case 'init':
      applyDirFlags(dirFlags)
      await initProject(args)
      return
    case 'ui-switch': {
      applyDirFlags(dirFlags)
      // `--home` must be in the environment before anything reads `dataRoot`, so
      // the command is imported here rather than at the top (as every `#src` import is).
      const { uiSwitch } = await import('#src/cli/ui-switch')
      await uiSwitch(args, {
        write: text => process.stdout.write(text),
        prompt,
        style: { bold, dim, green },
      })
      return
    }
    case 'ui-revert':
      applyDirFlags(dirFlags)
      await uiRevert()
      return
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return
    case 'version':
    case '--version':
    case '-v':
      version()
      return
    default:
      if (command.startsWith('-')) {
        // `home-hosted -p 4000` reads as `up`, the way a one-shot CLI should.
        applyDirFlags(dirFlags)
        await up(rest)
        return
      }
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      process.exit(1)
  }
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
