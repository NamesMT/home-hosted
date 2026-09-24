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
  home-hosted ui-revert         go back to the stock control panel UI

Options for up/restart
  -c, --config <file>   servers config (default: <state>/servers.config.json)
  -p, --port <port>     control panel port (default: ${DEFAULT_PORT})
      --host <bind>     local | lan | an ipv4 address (default: local)
      --open            open the panel in a browser once it is up
      --no-autostart    do not start the entries marked autostart
      --foreground      run in this process instead of detaching (systemd/docker)
      --print-config    print the effective config and exit

Everywhere
      --home <dir>      state directory (default: $HHOSTED_HOME or ~/.home-hosted)
      --project <dir>   base for relative entry paths (default: the current directory)
  -h, --help            this text
  -v, --version         the version

Environment
  HHOSTED_HOME          where config, secrets, logs, TLS and backups live
  HHOSTED_PROJECT       base for relative entry paths
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
