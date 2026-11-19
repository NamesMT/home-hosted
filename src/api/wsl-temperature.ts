import type { AppDeps } from '#src/app'
import type { WslTemperatureStatus } from '#src/shared/contracts'
import fs from 'node:fs'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { installLibreHardwareMonitor, lhmInstalled, probeWslTemperature, removeWslTemperatureScript, tempCommandFor, writeWslTemperatureScript, wslScriptPath, wslTemperatureStatus } from '#src/providers/wsl-temperature'
import { wslTemperatureSchema } from '#src/shared/contracts'
import { lazy } from '#src/shared/lazy'
import { booleanParam } from '#src/shared/query-params'

const installQuery = lazy(() => type({ 'download?': booleanParam }).onUndeclaredKey('reject'))

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
 * The last live probe, and how long an answer from it may be reused.
 *
 * `GET /api/host/temperature` is declared `read`, and its probe **spawns `host.tempCommand`** through
 * a shell. Unbounded, that made a reading route into a process-spawn amplifier: measured on a scratch
 * panel with the command set to `sleep 2; echo 42`, 20 concurrent requests from an account holding
 * only `read` all answered `200` after ~2.4 s, i.e. twenty shells ran at once, and each repeat of the
 * request cost another one. `read` is documented as "the readings" and is the scope a monitor gets, so
 * a leaked monitor credential could spawn as many processes as it had sockets — and the panel's own
 * page calls this route once on mount, so a cache costs it nothing.
 *
 * Deliberately not "only probe when the command changed": the point of the route is to show a live
 * reading, and a temperature is one number, so a short reuse window is the honest trade — the same
 * shape `TlsStore.status` uses for its own per-frame filesystem work.
 */
const PROBE_CACHE_MS = 5000

/**
 * The WSL2 temperature bridge, over the panel's own settings.
 *
 * Panel-wide (a temperature is the machine's, not a workspace's), and deliberately three small
 * routes rather than one: read the state, install it, test it. Installing writes a file and changes
 * a setting, so it is the one that can fail and has to say why.
 */
export function createWslTemperatureRoute(deps: AppDeps) {
  /**
   * One in-flight probe, shared by every concurrent caller, plus its last answer.
   *
   * A cache alone is not enough: twenty requests arriving together all miss it and all spawn. So the
   * promise is stored, not just its result — concurrent callers await the same shell.
   */
  let probing: Promise<{ celsius: number | null, error: string | null }> | null = null
  let probedAt = 0
  let last: { celsius: number | null, error: string | null } | null = null

  async function probeOnce(): Promise<{ celsius: number | null, error: string | null }> {
    const now = Date.now()
    if (last !== null && now - probedAt < PROBE_CACHE_MS)
      return last
    probing ??= probeWslTemperature(deps.panel.settings.host.tempCommand, deps.panel.settings.host.tempCommandTimeoutMs)
      .then((result) => {
        last = result
        probedAt = Date.now()
        return result
      })
      .finally(() => {
        probing = null
      })
    return probing
  }

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
        const probe = await probeOnce()
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
      validate('query', installQuery),
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
          // `EACCES`/`EPERM` on a file that already exists is a different problem from an unwritable
          // directory: an earlier helper can be owned by another Windows account, and `%ProgramData%`
          // on a 9p mount maps that to an ACL this process cannot write through. Bare "permission
          // denied" sent a reader to check the mount; naming the stale file is the actual fix.
          const code = (error as NodeJS.ErrnoException).code
          const stale = (code === 'EACCES' || code === 'EPERM') && fs.existsSync(target)
          throw new DetailedError(stale
            ? `an earlier helper at ${target} is owned by another account and cannot be overwritten. Remove it from an elevated PowerShell: Remove-Item -LiteralPath '${target}' -Force — then press this again`
            : `the helper could not be written to ${target}: ${error instanceof Error ? error.message : String(error)}`, {
            statusCode: 400,
            code: 'SCRIPT_WRITE_FAILED',
          })
        }

        // The helper only prints a number; the sensor comes from a third-party Windows binary the
        // panel does not ship. The first press says so and asks; a second press carries
        // `?download=true` and installs it. Never on the same click that did not mention a download.
        if (!lhmInstalled()) {
          if (c.req.valid('query').download !== true)
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
        // The setting is cleared either way — that is what stops the helper being used. But if the
        // file survives, saying "cleared" is a lie the next setup attempt pays for: it cannot write
        // over a helper it does not own.
        const removed = removeWslTemperatureScript(scriptPath())
        if (!removed)
          throw new DetailedError(`the setting is cleared, but the helper at ${scriptPath()} could not be deleted — it is owned by another account. Remove it from an elevated PowerShell: Remove-Item -LiteralPath '${scriptPath()}' -Force`, { statusCode: 400, code: 'SCRIPT_WRITE_FAILED' })
        return c.json(status(deps))
      },
    )
}
