import type { ChildProcess } from 'node:child_process'
import type { UpFlags } from '#src/cli/args'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { buildDaemonArgv } from '#src/cli/args'
import { bold, delay, dim, fail, firstRunPassword, green, invocation, paint } from '#src/cli/io'
import { rotateLog, tailLog } from '#src/helpers/daemon-log'
import { runtimeArgs } from '#src/helpers/runtime'
import { versionMismatchNote } from '#src/helpers/version'

/** `up` starts the panel; without `--foreground` it re-spawns itself detached. */

const DEFAULT_PORT = 3999

export const upArgs = {
  port: { type: 'string', alias: 'p', description: `control panel port (default: ${DEFAULT_PORT})` },
  host: { type: 'string', description: 'local | lan | an ipv4 address (default: local)' },
  // No `default: true`: `toUpFlags` reads "not given" as on, and `restart <id>` needs `undefined`
  // to tell "not given" from `--no-autostart`.
  autostart: { type: 'boolean', negativeDescription: 'do not start the entries marked autostart' },
  open: { type: 'boolean', description: 'open the panel in a browser once it is up' },
  foreground: { type: 'boolean', description: 'run in this process instead of detaching (systemd/docker)' },
  printConfig: { type: 'boolean', description: 'print the effective config and exit' },
} as const

interface RawUpArgs {
  port?: string
  host?: string
  autostart?: boolean
  open?: boolean
  foreground?: boolean
  printConfig?: boolean
}

/** citty only parses; the port's range and the boolean defaults are decided here. */
export function toUpFlags(args: RawUpArgs): UpFlags {
  let port: number | undefined
  if (args.port !== undefined) {
    // The whole argument must be a decimal integer. `Number.parseInt` takes a prefix, so a
    // partial parse slipped past the range check as a *valid* port: `--port 1e3` started the
    // panel on port 1 (privileged, and not what anyone typed) and `--port 8000x` on 8000.
    const raw = args.port.trim()
    port = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      fail(`invalid port: ${args.port}`)
  }

  return {
    port,
    host: args.host,
    autostart: args.autostart !== false,
    open: args.open === true,
    foreground: args.foreground === true,
    printConfig: args.printConfig === true,
  }
}

/**
 * `toUpFlags`, plus the check of `--host` that only the panel's own boot used to make.
 *
 * Async because the bind parser lives with the schemas, which a detaching `up` otherwise never
 * loads. Run before anything happens, so `up --host nope` is refused here rather than in a daemon
 * log, and `restart --host nope` before the panel is stopped.
 */
export async function checkedUpFlags(args: RawUpArgs): Promise<UpFlags> {
  const flags = toUpFlags(args)
  if (flags.host !== undefined) {
    const { parseBind } = await import('#src/shared/contracts')
    if (parseBind(flags.host) === null)
      fail(`invalid control host: ${flags.host} (expected local, lan or an ipv4 address)`)
  }
  return flags
}

/**
 * A bind value as the address it resolves to.
 *
 * Deliberately local and dependency-free: this module must stay importable without a state graph
 * (`test/cli/isolation`), and `helpers/bind.ts` caches `os.networkInterfaces()`, which a pure
 * comparison has no business triggering.
 */
function bindAddress(bind: string): string {
  return bind === 'local' ? '127.0.0.1' : bind === 'lan' ? '0.0.0.0' : bind
}

/**
 * Which `up` flags the live panel contradicts, as one sentence — or `null` when it agrees.
 *
 * `up` on a live panel reports "already running" and exits 0, which is right: the common use is
 * "make sure it is running". But it used to swallow `--port`, `--host` and `--open` on that path,
 * so `up --port 4800` against a panel on 3999 printed a success line and exited 0 having changed
 * nothing — a deploy script reading `$?` concluded the port move worked. AGENTS.md settles the
 * direction: a flag the command cannot honour is refused, and `restart --workspace` without an id
 * already exits 1 for the same reason. `--open` is refused too, because it is not "make sure it is
 * running" either — it asks for a browser, and none opens on a panel this command did not start.
 *
 * `--no-autostart` is deliberately **not** here. It is not contradicted by the live panel: it
 * expresses a wish about a boot this command is not performing, and the panel has already booted,
 * so there is nothing to honour or refuse. Refusing it would break `up --no-autostart` in a retry
 * loop, which is the one spelling a script uses to keep its hands off the entries.
 */
export function alreadyRunningConflict(flags: UpFlags, runtime: { url: string, port: number, bindHost: string }): string | null {
  const asked: string[] = []
  if (flags.port !== undefined && flags.port !== runtime.port)
    asked.push(`--port ${flags.port}`)
  // Compared through `bindHost`, never as text: the record stores the address that was bound, so a
  // panel started with `--host lan` reads `bindHost: '0.0.0.0'` and the same flag compared raw would
  // always look unhonoured — refusing the idempotent re-run this command exists for. `--host` naming
  // the live bind is the same request as `--port` naming the live port, which is already let through.
  if (flags.host !== undefined && bindAddress(flags.host) !== runtime.bindHost)
    asked.push(`--host ${flags.host}`)
  if (flags.open)
    asked.push('--open')

  if (asked.length === 0)
    return null

  const what = asked.join(' and ')
  // "so --port 4800 it was not honoured" is not English: one flag reads "was not", several "were
  // not", and the flag names are the subject either way.
  const clause = asked.length === 1 ? `${what} was not honoured` : `${what} were not honoured`
  return `home-hosted is already running at ${runtime.url} — ${clause}. Stop it and start it again with those flags, or use \`${invocation()} restart\` to move it.`
}

export async function runUp(flags: UpFlags, entry: string): Promise<void> {
  // `--print-config` reports the effective config and returns; it never detaches,
  // because there would be a daemon left with nothing to serve.
  if (flags.foreground || flags.printConfig) {
    // Imported here rather than at the top of the function: detaching does not need the daemon's
    // graph at all, and loading it costs ~1s of the parent's ~2.5s before the child even spawns.
    const { runControlPlane } = await import('#src/index')
    await runControlPlane({
      port: flags.port,
      host: flags.host,
      autostart: flags.autostart,
      open: flags.open,
      printConfig: flags.printConfig,
    })
    return
  }

  const { clearRuntime, readRuntime, runtimeIsAlive, runtimeIsGone } = await import('#src/helpers/daemon')
  const { daemonLogPath, dataRoot, ensureStateDir, projectDir } = await import('#src/helpers/paths')

  const existing = readRuntime()
  if (existing !== null && await runtimeIsAlive(existing)) {
    // A flag this path cannot honour is refused, and a refusal is one message on one stream: the
    // whole thing — where the panel is, which flag was dropped, what to run — goes to stderr, so
    // stdout stays empty and a script reading it does not see a success line for a move that did
    // not happen.
    const conflict = alreadyRunningConflict(flags, existing)
    if (conflict !== null)
      fail(conflict)

    process.stdout.write(`${green('already running')} home-hosted ${existing.version} (pid ${existing.pid}) at ${existing.url}\n`)
    const note = versionMismatchNote(existing.version)
    if (note !== null)
      process.stdout.write(`${dim(note)}\n`)
    // The user may have arrived via `npx`, which leaves no `home-hosted` on their PATH.
    process.stdout.write(`${dim(`stop it with \`${invocation()} down\``)}\n`)
    return
  }
  // Only a record with *nothing* behind its pid is deleted. A pid that merely looks recycled is left
  // for the panel this starts to overwrite, because the birth time is wall-clock-derived on Linux and
  // a clock step can make a live panel look recycled — deleting its record would orphan it.
  if (existing !== null && await runtimeIsGone(existing))
    clearRuntime()

  ensureStateDir(path.dirname(daemonLogPath))
  rotateLog(daemonLogPath)
  // `0600`: the daemon's stderr lands here, and on a first boot that carries the generated password.
  // Without a mode the file is `0644` under the usual umask, so any local account could read a
  // credential the panel otherwise keeps in a 0600 file.
  const log = fs.openSync(daemonLogPath, 'a', 0o600)

  const child = spawn(process.execPath, [...runtimeArgs(), entry, ...buildDaemonArgv(flags)], {
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

  process.stdout.write(`${green(`home-hosted ${runtime.version} is up`)} (pid ${runtime.pid})\n`)
  process.stdout.write(`  ${bold(runtime.url)}\n`)
  process.stdout.write(`  ${dim(`project ${runtime.projectDir}`)}\n`)
  process.stdout.write(`  ${dim(`state   ${runtime.dataRoot}`)}\n`)
  process.stdout.write(`  ${dim(`log     ${runtime.logFile}`)}\n`)
  const initial = await firstRunPassword()
  if (initial !== null)
    process.stdout.write(`${paint('33', 'password')} ${bold(initial)} ${dim('— the first-run password; change it in Global settings → Authentication')}\n`)
  await warnIfWslTemperatureMissing()
}

/**
 * Say once, on `up`, that this box cannot read its own temperature and that it can be fixed.
 *
 * A WSL2 guest has no sensor the kernel exposes, so the Host vitals tile reads `n/a` and looks
 * broken. Nothing tells a person why — the settings page has the button, but only if they go
 * looking. This is the one line that turns "the panel is broken" into "run one command".
 *
 * Silent when a command is already configured, and on any platform that is not WSL.
 */
async function warnIfWslTemperatureMissing(): Promise<void> {
  const { isWsl } = await import('#src/providers/wsl-temperature')
  if (!isWsl())
    return
  const { GlobalSettingsStore } = await import('#src/config/settings')
  const { globalSettingsPath } = await import('#src/helpers/paths')
  const store = new GlobalSettingsStore(globalSettingsPath)
  store.load()
  if (store.host.tempCommand.trim().length > 0)
    return
  process.stdout.write(
    `${paint('33', 'note')} WSL2 detected: the guest exposes no CPU temperature, so Host vitals shows n/a\n`
    + `  ${dim(`set it up with ${invocation()} setup-temp --wsl`)}\n`,
  )
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

export function upCommand(entry: string) {
  return defineCommand({
    meta: { name: 'up' },
    args: upArgs,
    run: async ({ args }) => {
      await runUp(await checkedUpFlags(args), entry)
    },
  })
}
