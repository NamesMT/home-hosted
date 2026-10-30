import type { AppDeps } from '#src/app'
import type { WslTemperatureStatus } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { installLibreHardwareMonitor, lhmInstalled, probeWslTemperature, removeWslTemperatureScript, tempCommandFor, writeWslTemperatureScript, wslScriptPath, wslTemperatureStatus } from '#src/providers/wsl-temperature'
import { wslTemperatureSchema } from '#src/shared/contracts'

/**
 * The helper's location, or null when the Windows drive is not mounted.
 *
 * It lives on the *Windows* side: `powershell.exe` cannot read the guest's Linux home, so a script
 * written there is invisible to it.
 */
function scriptPath(): string | null {
  return wslScriptPath()
}

function status(deps: AppDeps): WslTemperatureStatus {
  return wslTemperatureStatus(scriptPath(), deps.panel.settings.host.tempCommand)
}

/**
 * The WSL2 temperature bridge, over the panel's own settings.
 *
 * Panel-wide (a temperature is the machine's, not a workspace's), and deliberately three small
 * routes rather than one: read the state, install it, test it. Installing writes a file and changes
 * a setting, so it is the one that can fail and has to say why.
 */
export function createWslTemperatureRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/host/temperature',
      describeRoute({
        tags: ['panel'],
        summary: 'Whether the WSL temperature bridge is set up, and what it last read',
        responses: { 200: { description: 'The bridge state', content: jsonBody(wslTemperatureSchema) } },
      }),
      async (c) => {
        const current = status(deps)
        // Probe only when the command is configured, so the page can show a live reading — a setup
        // that was never saved must not spawn a PowerShell on every page load.
        if (!current.configured)
          return c.json(current)
        const probe = await probeWslTemperature(deps.panel.settings.host.tempCommand, deps.panel.settings.host.tempCommandTimeoutMs)
        return c.json({ ...current, lastReadingCelsius: probe.celsius, lastError: probe.error })
      },
    )

    .post(
      '/host/temperature',
      describeRoute({
        tags: ['panel'],
        summary: 'Write the WSL helper script and point the temperature command at it',
        responses: { 200: { description: 'Set up', content: jsonBody(wslTemperatureSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      async (c) => {
        const current = status(deps)
        if (!current.supported) {
          throw new DetailedError('this is not a WSL2 guest, so there is no host sensor to bridge to', {
            statusCode: 400,
            code: 'NOT_WSL',
          })
        }
        const target = scriptPath()
        if (target === null)
          throw new DetailedError('the Windows drive is not mounted at /mnt/c, so the helper cannot be written where powershell.exe can read it', { statusCode: 400, code: 'WINDOWS_DRIVE_MISSING' })
        try {
          writeWslTemperatureScript(target)
        }
        catch (error) {
          throw new DetailedError(`the helper could not be written to ${target}: ${error instanceof Error ? error.message : String(error)}`, {
            statusCode: 400,
            code: 'SCRIPT_WRITE_FAILED',
          })
        }

        // The helper only prints a number; the sensor comes from a third-party Windows binary the
        // panel does not ship. The first press says so and asks; a second press carries
        // `?download=true` and installs it. Never on the same click that did not mention a download.
        if (!lhmInstalled()) {
          if (c.req.query('download') !== 'true')
            return c.json({ ...status(deps), needsDownload: true })
          const install = await installLibreHardwareMonitor()
          if (install.error !== null)
            throw new DetailedError(`LibreHardwareMonitor could not be installed: ${install.error}`, { statusCode: 400, code: 'LIBRARY_INSTALL_FAILED' })
        }
        // The command is what the panel will run; saving it here is the whole point, so the person
        // does not have to copy a path out of a log.
        const command = tempCommandFor(target)
        // Probe **before** saving: a command that cannot work must not reach the config, or the panel
        // runs a failing PowerShell every sample while the page says a source is configured. The
        // helper file stays on disk — it is what the person re-runs after installing the library.
        const probe = await probeWslTemperature(command, 5000)
        if (probe.celsius === null) {
          return c.json({
            ...status(deps),
            lastReadingCelsius: null,
            lastError: probe.error ?? 'the helper did not answer',
          })
        }
        deps.panel.settings.updateHost({ tempCommand: command, tempCommandTimeoutMs: 5000 })
        return c.json({ ...status(deps), lastReadingCelsius: probe.celsius, lastError: null })
      },
    )

    .delete(
      '/host/temperature',
      describeRoute({
        tags: ['panel'],
        summary: 'Stop using the helper and delete it',
        responses: { 200: { description: 'Cleared', content: jsonBody(wslTemperatureSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      async (c) => {
        deps.panel.settings.updateHost({ tempCommand: '' })
        removeWslTemperatureScript(scriptPath())
        return c.json(status(deps))
      },
    )
}
