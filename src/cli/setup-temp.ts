import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green } from '#src/cli/io'
import { GlobalSettingsStore } from '#src/config/settings'
import { globalSettingsPath } from '#src/helpers/paths'
import { probeWslTemperature, tempCommandFor, windowsScriptPath, writeWslTemperatureScript, wslScriptPath } from '#src/providers/wsl-temperature'

/**
 * `setup-temp` — teach the panel how to read this machine's CPU temperature.
 *
 * Generic on purpose: `--wsl` is one *source*, and the next machine that needs a bridge (a VM
 * forwarding a sensor, a board behind a vendor daemon) is another flag beside it rather than a
 * second command. With no flag the command reports what the panel can already read and what the
 * options are, which is the useful thing to type when the tile says `n/a`.
 */

export const setupTempArgs = {
  wsl: { type: 'boolean', description: 'read the temperature through the Windows host (WSL2)', default: false },
  clear: { type: 'boolean', description: 'stop using a configured command and delete its helper', default: false },
} as const

/** The temperature sources `setup-temp` can install. One today; a flag each as more appear. */
export type TemperatureSource = 'wsl'

/** Which source a flag names, or null when the invocation asks for no change. */
export function sourceFromFlags(flags: { wsl?: boolean, clear?: boolean }): TemperatureSource | null {
  if (flags.clear === true)
    return null
  if (flags.wsl === true)
    return 'wsl'
  return null
}

export async function runSetupTemp(flags: { wsl?: boolean, clear?: boolean }): Promise<void> {
  const store = new GlobalSettingsStore(globalSettingsPath)
  store.load()
  const host = store.host
  const configured = host.tempCommand.trim().length > 0

  if (flags.clear === true) {
    if (!configured) {
      process.stdout.write('no temperature command is set — nothing to clear\n')
      return
    }
    store.updateHost({ tempCommand: '' })
    process.stdout.write(`${green('temperature command cleared')} — the tile uses the built-in probe again\n`)
    return
  }

  const source = sourceFromFlags(flags)
  if (source === null) {
    // No flag: say what is going on, so this is the one command a confused person types.
    if (configured) {
      process.stdout.write(`${green('a temperature command is set')}: ${bold(host.tempCommand)}\n`)
      const probe = await probeWslTemperature(host.tempCommand, host.tempCommandTimeoutMs)
      process.stdout.write(probe.celsius === null
        ? `  ${dim(`it did not answer: ${probe.error ?? 'unknown reason'}`)}\n`
        : `  last reading: ${green(`${probe.celsius}°C`)}\n`)
      return
    }
    process.stdout.write('the panel reads the temperature from the kernel when the machine exposes a sensor.\n')
    process.stdout.write(`this machine: ${host.tempCelsius > 0 ? `threshold ${host.tempCelsius}°C` : 'no temperature alert'}\n`)
    process.stdout.write(`\n${dim('if the Host vitals tile says n/a, set a source up:')}\n`)
    process.stdout.write(`  ${bold('setup-temp --wsl')}   read it through the Windows host (WSL2)\n`)
    return
  }

  if (source === 'wsl') {
    const { isWsl } = await import('#src/providers/wsl-temperature')
    if (!isWsl()) {
      fail('--wsl is for a WSL2 guest, and this is not one. Run `setup-temp` with no flag to see the options')
    }
    const scriptPath = wslScriptPath()
    if (scriptPath === null) {
      fail('the Windows drive is not mounted, so the helper cannot be written where powershell.exe can read it')
    }
    writeWslTemperatureScript(scriptPath)
    const command = tempCommandFor(scriptPath)
    store.updateHost({ tempCommand: command, tempCommandTimeoutMs: 5000 })
    process.stdout.write(`${green('WSL temperature bridge set up')}\n`)
    process.stdout.write(`  helper  ${dim(`${scriptPath}  (${windowsScriptPath(scriptPath)} on Windows)`)}\n`)
    process.stdout.write(`  command ${bold(command)}\n`)

    // Say whether it actually works, rather than leaving a person to find out from a tile.
    const probe = await probeWslTemperature(command, 5000)
    if (probe.celsius === null) {
      process.stdout.write(`${dim('\nit did not answer yet')}: ${probe.error ?? 'unknown reason'}\n`)
      process.stdout.write(`${dim('install LibreHardwareMonitor in C:\\Tools\\LibreHardwareMonitor on Windows, then re-run this command')}\n`)
      return
    }
    process.stdout.write(`  reading ${green(`${probe.celsius}°C`)}\n`)
  }
}

export const setupTempCommand = defineCommand({
  meta: { name: 'setup-temp' },
  args: setupTempArgs,
  async run({ args }) {
    await runSetupTemp({ wsl: args.wsl === true, clear: args.clear === true })
  },
})
