import type { ChildProcess } from 'node:child_process'
import type { UpFlags } from '#src/cli/args'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { buildDaemonArgv } from '#src/cli/args'
import { bold, delay, dim, fail, green, invocation, paint } from '#src/cli/io'
import { rotateLog, tailLog } from '#src/helpers/daemon-log'
import { runtimeArgs } from '#src/helpers/runtime'
import { versionMismatchNote } from '#src/helpers/version'

/** `up` starts the panel; without `--foreground` it re-spawns itself detached. */

const DEFAULT_PORT = 3999

export const upArgs = {
  port: { type: 'string', alias: 'p', description: `control panel port (default: ${DEFAULT_PORT})` },
  host: { type: 'string', description: 'local | lan | an ipv4 address (default: local)' },
  autostart: { type: 'boolean', default: true, negativeDescription: 'do not start the entries marked autostart' },
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
  const { daemonLogPath, dataRoot, projectDir } = await import('#src/helpers/paths')

  const existing = readRuntime()
  if (existing !== null && await runtimeIsAlive(existing)) {
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

  fs.mkdirSync(path.dirname(daemonLogPath), { recursive: true })
  rotateLog(daemonLogPath)
  const log = fs.openSync(daemonLogPath, 'a')

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
      await runUp(toUpFlags(args), entry)
    },
  })
}
