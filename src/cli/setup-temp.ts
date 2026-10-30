import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, prompt } from '#src/cli/io'
import { GlobalSettingsStore } from '#src/config/settings'
import { globalSettingsPath } from '#src/helpers/paths'
import { installLibreHardwareMonitor, lhmDirectoryWindows, lhmInstalled, probeWslTemperature, removeWslTemperatureScript, tempCommandFor, windowsScriptPath, writeWslTemperatureScript, wslScriptPath } from '#src/providers/wsl-temperature'

/**
 * `setup-temp` — teach the panel how to read this machine's CPU temperature.
 *
 * `--wsl` is one *source*; the next bridge is another flag beside it, not a second command.
 */

export const setupTempArgs = {
  wsl: { type: 'boolean', description: 'read the temperature through the Windows host (WSL2)', default: false },
  clear: { type: 'boolean', description: 'stop using a configured command and delete its helper', default: false },
  // No `default`: citty leaves it `undefined` when absent and `false` for `--no-download`, which is
  // what lets one flag express the three outcomes — ask, install, refuse — instead of needing a
  // second flag to say "no".
  download: { type: 'boolean', description: 'download LibreHardwareMonitor without asking; --no-download never does (for a script)' },
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

/**
 * The refusal for a flag set that cannot mean what it says, or `null`.
 *
 * `download` is a **modifier of `--wsl`**, not a command of its own: only the WSL2 branch fetches
 * anything, and the no-flag branch ends before a source is chosen. Left unreachable it was silently
 * dropped — `setup-temp --download` exited 0 having done nothing, which a script reads as
 * "installed" — so the flag is refused instead, naming the one it belongs to.
 *
 * `--clear` is the opposite request, so pairing it with either is refused rather than letting one
 * quietly win.
 */
export function flagProblem(flags: { wsl?: boolean, clear?: boolean, download?: boolean }): string | null {
  const download = flags.download === undefined ? null : flags.download === true ? '--download' : '--no-download'
  if (flags.clear === true) {
    if (download !== null)
      return `\`--clear\` and \`${download}\` ask for opposite things — clear the source, or set one up, not both`
    if (flags.wsl === true)
      return '`--clear` and `--wsl` ask for opposite things — clear the source, or set one up, not both'
    return null
  }
  if (download !== null && flags.wsl !== true)
    return `\`${download}\` only means something with \`--wsl\` — pass \`setup-temp --wsl ${download}\`, or drop it to read the state`
  return null
}

export async function runSetupTemp(flags: { wsl?: boolean, clear?: boolean, download?: boolean }): Promise<void> {
  // Before any read: a flag this command cannot honour is a mistake in the invocation, not a
  // property of the machine's config.
  const problem = flagProblem(flags)
  if (problem !== null)
    fail(problem)

  const store = new GlobalSettingsStore(globalSettingsPath)
  store.load()
  const host = store.host
  const configured = host.tempCommand.trim().length > 0

  if (flags.clear === true) {
    // `--clear` promises to delete the helper as well as the setting, and it used to clear the
    // command only: measured, the file outlived every `--clear`. A stale helper is also the one
    // thing left when the command is already empty, so it is removed on both paths.
    const helper = wslScriptPath()
    const hadHelper = helper !== null && fs.existsSync(helper)
    if (configured)
      store.updateHost({ tempCommand: '' })
    removeWslTemperatureScript(helper)
    if (!configured && !hadHelper) {
      process.stdout.write('no temperature command is set — nothing to clear\n')
      return
    }
    if (!configured) {
      process.stdout.write(`no temperature command is set — removed the leftover helper at ${dim(helper!)}\n`)
      return
    }
    process.stdout.write(`${green('temperature command cleared')} — the tile uses the built-in probe again\n`)
    if (hadHelper)
      process.stdout.write(`  ${dim(`helper ${helper!} deleted`)}\n`)
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
    // The helper only prints a number; the sensor comes from LibreHardwareMonitor, a third-party
    // Windows binary the panel does not ship. Offer to fetch it — someone who just typed this
    // command has no way to know a library is missing, and the tile only ever says `n/a`.
    if (!lhmInstalled())
      await offerLibreHardwareMonitor(flags)

    writeWslTemperatureScript(scriptPath)
    const command = tempCommandFor(scriptPath)
    process.stdout.write(`  helper  ${dim(`${scriptPath}  (${windowsScriptPath(scriptPath)} on Windows)`)}\n`)

    // Probe **before** saving. A command that cannot work must not reach the config: the panel would
    // run a failing PowerShell on every sample, and the tile would stay `n/a` while the settings page
    // claimed a source was configured — the one state a person has no way to diagnose.
    const probe = await probeWslTemperature(command, 5000)
    if (probe.celsius === null) {
      process.stdout.write(`${fail('not set up')} — the helper did not answer: ${probe.error ?? 'unknown reason'}\n`)
      process.stdout.write(`${dim(`the script is at ${scriptPath}; the config was left unchanged`)}\n`)
      return
    }

    store.updateHost({ tempCommand: command, tempCommandTimeoutMs: 5000 })
    process.stdout.write(`${green('WSL temperature bridge set up')}\n`)
    process.stdout.write(`  command ${bold(command)}\n`)
    process.stdout.write(`  reading ${green(`${probe.celsius}°C`)}\n`)
  }
}

/**
 * Offer the ~6 MB download. A prompt, never a silent fetch: installing software nobody asked for is
 * not a setup command's job, and a non-interactive stdin answers no.
 */
async function offerLibreHardwareMonitor(flags: { download?: boolean }): Promise<void> {
  const where = lhmDirectoryWindows() ?? 'C:\\ProgramData\\home-hosted\\LibreHardwareMonitor'

  // `undefined` (absent): ask. `true` (`--download`): install. `false` (`--no-download`): refuse.
  if (flags.download !== true) {
    if (flags.download === false) {
      process.stdout.write(`${dim(`LibreHardwareMonitor is not installed; install it into ${where}, or pass --download`)}\n`)
      return
    }
    const answer = await prompt(`LibreHardwareMonitor is required to read the sensor. Download it now (~6 MB)? [y/N] `)
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      process.stdout.write(`${dim(`left it alone — install it into ${where} and re-run this command`)}\n`)
      return
    }
  }

  const result = await installLibreHardwareMonitor({ onProgress: message => process.stdout.write(`  ${dim(message)}\n`) })
  if (result.error !== null) {
    process.stdout.write(`${fail('the download did not install')} — ${result.error}\n`)
    return
  }
  process.stdout.write(`  library ${green('installed')} in ${result.dir}\n`)
}

export const setupTempCommand = defineCommand({
  meta: { name: 'setup-temp' },
  args: setupTempArgs,
  async run({ args }) {
    await runSetupTemp({ wsl: args.wsl === true, clear: args.clear === true, download: args.download })
  },
})
