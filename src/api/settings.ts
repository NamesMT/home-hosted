import type { AppDeps } from '#src/app'
import type { SettingsPatch } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { ConfigError } from '#src/config/store'
import { displayHost } from '#src/helpers/bind'
import { afterResponse } from '#src/helpers/deferred'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { ERROR_RESPONSES } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { checkExposure } from '#src/services/exposure'
import { buildBackupsView, buildControlView } from '#src/services/state'
import { settingsPatchSchema } from '#src/shared/contracts'

/** Uploads are buffered in memory by `parseBody`, so they get a hard ceiling. */
const MAX_UI_UPLOAD_BYTES = 128 * 1024 * 1024

/** The archive's name is only a label, so it never reaches the filesystem. */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/\.zip$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'custom-ui'
}

export function createSettingsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get('/settings', c => c.json({
      control: buildControlView(deps.store, deps.auth, deps.controlServer.endpoint, deps.tls),
      defaults: deps.store.defaults,
      logs: deps.store.config.logs,
      notifications: { telegram: deps.notifications.status() },
      host: deps.store.config.host,
      backups: buildBackupsView(deps.store, deps.backups),
      ui: deps.ui.status(),
    }))

    .patch('/settings', describeRoute({
      tags: ['panel'],
      summary: 'Edit the panel, server defaults, logs, notifications, host and backups',
      responses: { 200: { description: 'Saved; the listener may be moving' }, 400: ERROR_RESPONSES[400] },
    }), validate('json', settingsPatchSchema), async (c) => {
      const patch: SettingsPatch = c.req.valid('json')
      const current = deps.store.config.control

      // Refuse an exposure that is not backed by a password before writing anything.
      const exposure = checkExposure(
        {
          ...current,
          host: patch.control?.host ?? current.host,
          auth: { ...current.auth, enabled: patch.control?.auth?.enabled ?? current.auth.enabled },
        },
        deps.auth.passwordSet,
        deps.auth.usingDefaultPassword,
      )
      if (exposure.blockedReason !== null)
        throw new DetailedError(exposure.blockedReason, { statusCode: 400, code: 'EXPOSURE_BLOCKED' })

      const previous = { trustProxy: current.auth.trustProxy, tlsEnabled: current.tls.enabled }
      try {
        if (patch.defaults !== undefined)
          deps.store.updateDefaults(patch.defaults)
        if (patch.logs !== undefined)
          deps.store.updateLogs(patch.logs)
        if (patch.notifications !== undefined)
          deps.store.updateNotifications(patch.notifications)
        if (patch.host !== undefined)
          deps.store.updateHost(patch.host)
        if (patch.backups !== undefined)
          deps.store.updateBackups(patch.backups)
        if (patch.control !== undefined)
          deps.store.updateControl(patch.control)
      }
      catch (error) {
        if (error instanceof ConfigError)
          throw new DetailedError(error.message, { statusCode: 400, code: 'INVALID_SETTINGS' })
        throw error
      }

      const next = deps.store.config.control
      const endpointChanged = next.host !== deps.controlServer.endpoint.host || next.port !== deps.controlServer.endpoint.port
      const proxyChanged = next.auth.trustProxy !== previous.trustProxy
      const tlsChanged = next.tls.enabled !== previous.tlsEnabled
      let targetUrl: string | null = null

      if (endpointChanged || proxyChanged || tlsChanged) {
      // Moving the listener kills the connection serving this very response, so
      // it happens after the response is written. A failure reverts the config
      // and shows up as `restartRequired` in the next state frame.
        const nextProtocol = tlsChanged ? (next.tls.enabled ? 'https' : 'http') : deps.controlServer.endpoint.protocol
        targetUrl = `${nextProtocol}://${displayHost(next.host)}:${next.port}`

        afterResponse(async () => {
          const result = endpointChanged
            ? await deps.controlServer.rebind({ host: next.host, port: next.port })
            : await deps.controlServer.restart()

          if (result.ok) {
            logger.info(`control panel listening on ${deps.controlServer.endpoint.url}`)
            return
          }

          logger.error(`could not move the control panel: ${result.error ?? 'unknown error'}`)
          deps.store.updateControl({
            host: deps.controlServer.endpoint.host,
            port: deps.controlServer.endpoint.port,
            ...(proxyChanged ? { auth: { trustProxy: previous.trustProxy } } : {}),
            ...(tlsChanged ? { tls: { enabled: previous.tlsEnabled } } : {}),
          })
        }, error => logger.error('control panel move failed', error))
      }

      return c.json({
      // `control` describes the listener that is live *right now*; `targetUrl`
      // is where it is about to be, which is what the client should open.
        control: buildControlView(deps.store, deps.auth, deps.controlServer.endpoint, deps.tls),
        defaults: deps.store.defaults,
        logs: deps.store.config.logs,
        notifications: { telegram: deps.notifications.status() },
        host: deps.store.config.host,
        backups: buildBackupsView(deps.store, deps.backups),
        ui: deps.ui.status(),
        rebinding: endpointChanged || proxyChanged || tlsChanged,
        targetUrl,
      })
    })

  /**
   * Replace the panel's UI with an uploaded static build. The archive is validated
   * and staged before it is swapped in, so a bad upload changes nothing.
   */
    .post('/settings/ui', describeRoute({
      tags: ['panel'],
      summary: 'Replace the panel UI with an uploaded static build',
      responses: { 200: { description: 'Installed' }, 400: ERROR_RESPONSES[400], 413: { description: 'Too large' } },
    }), async (c) => {
      const declared = Number.parseInt(c.req.header('content-length') ?? '0', 10)
      if (Number.isFinite(declared) && declared > MAX_UI_UPLOAD_BYTES)
        throw new DetailedError(`the upload is larger than ${Math.round(MAX_UI_UPLOAD_BYTES / 1024 / 1024)}MB`, { statusCode: 413, code: 'UPLOAD_TOO_LARGE' })

      const body = await c.req.parseBody()
      const file = body.file
      if (!(file instanceof File))
        throw new DetailedError('expected a `file` field with the UI archive', { statusCode: 400, code: 'MISSING_FILE' })
      if (file.size > MAX_UI_UPLOAD_BYTES)
        throw new DetailedError(`the upload is larger than ${Math.round(MAX_UI_UPLOAD_BYTES / 1024 / 1024)}MB`, { statusCode: 413, code: 'UPLOAD_TOO_LARGE' })

      const staging = path.join(path.dirname(deps.ui.directory), `.ui-upload-${Date.now()}.zip`)
      try {
        await fs.promises.writeFile(staging, Buffer.from(await file.arrayBuffer()))
        const result = await deps.ui.install(staging, sanitizeName(file.name))
        if (!result.ok)
          throw new DetailedError(result.error, { statusCode: 400, code: 'INVALID_UI' })

        logger.info(`UI replaced with ${result.meta.name} (${result.meta.files} files)`)
        return c.json({ ok: true, meta: result.meta, ui: deps.ui.status() })
      }
      finally {
        fs.rmSync(staging, { force: true })
      }
    })

    /** Back to the stock UI. */
    .delete('/settings/ui', describeRoute({
      tags: ['panel'],
      summary: 'Go back to the stock UI',
      responses: { 200: { description: 'Reverted' } },
    }), (c) => {
      const removed = deps.ui.revert()
      logger.info(removed ? 'custom UI removed — the stock panel is back' : 'no custom UI was installed')
      return c.json({ ok: true, removed, ui: deps.ui.status() })
    })
}
