import type { AppDeps } from '#src/app'
import type { WslTemperatureStatus } from '#src/shared/contracts'
import fs from 'node:fs'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { probeWslTemperature, tempCommandFor, writeWslTemperatureScript, wslScriptPath, wslTemperatureStatus } from '#src/providers/wsl-temperature'
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
        // The command is what the panel will run; saving it here is the whole point, so the person
        // does not have to copy a path out of a log.
        const command = tempCommandFor(target)
        deps.panel.settings.updateHost({ tempCommand: command, tempCommandTimeoutMs: 5000 })
        // Answer with the reading, not just "configured": a setup that cannot say whether it works
        // leaves a person to discover it from a tile that may not have sampled yet.
        const probe = await probeWslTemperature(command, 5000)
        return c.json({ ...status(deps), lastReadingCelsius: probe.celsius, lastError: probe.error })
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
        const target = scriptPath()
        deps.panel.settings.updateHost({ tempCommand: '' })
        // Deleting is best-effort: a file someone already removed is the outcome they wanted.
        try {
          if (target !== null)
            fs.rmSync(target, { force: true })
        }
        catch {
          // Left behind; the command is cleared, which is what stops it being used.
        }
        return c.json(status(deps))
      },
    )
}
