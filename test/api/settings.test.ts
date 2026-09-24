import type { AppDeps } from '#src/app'
import type { ControlEndpoint } from '#src/services/control-server'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { createSettingsRoute } from '#src/api/settings'
import { SecretsStore } from '#src/config/secrets'
import { ConfigStore } from '#src/config/store'
import { errorHandler } from '#src/helpers/error'
import { AuthService } from '#src/services/auth'
import { BackupService } from '#src/services/backups'
import { NotificationService } from '#src/services/notifications'
import { TlsStore } from '#src/services/tls'
import { UiService } from '#src/services/ui'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

/**
 * The settings route only reaches for these, so the rest of `AppDeps` is left
 * out on purpose: a patch that keeps the listener where it is never rebinds.
 */
async function makeApp(): Promise<{ app: Hono, file: string, store: ConfigStore }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-settings-'))
  dirs.push(dir)

  const file = path.join(dir, 'servers.config.json')
  const store = new ConfigStore(file)
  store.load()

  const secrets = new SecretsStore(path.join(dir, '.control-secrets.json'))
  const auth = new AuthService(secrets, () => store.config.control.auth)
  const tls = new TlsStore(path.join(dir, 'tls'))
  const notifications = new NotificationService(secrets, () => store.config.notifications, () => store.config.logs)
  const backups = new BackupService({
    dataRoot: dir,
    getConfig: () => store.config.backups,
    getSources: () => ({ configPath: file, secretsPath: secrets.path, tlsDir: tls.directory, paths: [] }),
  })
  const ui = new UiService({ dataRoot: dir, stockDir: path.join(dir, 'web') })
  const endpoint: ControlEndpoint = {
    host: 'local',
    port: 3999,
    bindHost: '127.0.0.1',
    url: 'http://127.0.0.1:3999',
    protocol: 'http',
  }

  const deps = { store, auth, controlServer: { endpoint }, tls, notifications, backups, ui } as unknown as AppDeps
  // Failures are thrown, so the app needs the same error handler as the real one.
  const app = new Hono().onError(errorHandler).route('/api', createSettingsRoute(deps))
  return { app, file, store }
}

function patch(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.request('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('settings route', () => {
  it('writes every settings block a PATCH accepts', async () => {
    const { app, file, store } = await makeApp()

    const response = await patch(app, {
      logs: { keep: 7 },
      host: { diskUsedPercent: 42 },
      backups: { keep: 9 },
      notifications: { telegram: { onHost: false } },
    })

    expect(response.status).toBe(200)
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      logs: { keep: number }
      host: { diskUsedPercent: number }
      backups: { keep: number }
      notifications: { telegram: { onHost: boolean } }
    }
    expect(written.logs.keep).toBe(7)
    expect(written.host.diskUsedPercent).toBe(42)
    expect(written.backups.keep).toBe(9)
    expect(written.notifications.telegram.onHost).toBe(false)
    expect(store.config.host.diskUsedPercent).toBe(42)
    expect(store.config.backups.keep).toBe(9)
  })

  it('leaves the file alone when a block is rejected', async () => {
    const { app, file } = await makeApp()
    const before = fs.readFileSync(file, 'utf8')

    expect((await patch(app, { logs: { keep: 99 } })).status).toBe(400)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})
