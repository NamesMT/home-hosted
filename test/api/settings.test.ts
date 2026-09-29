import type { Fixture } from './fixture'
import fs from 'node:fs'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { settingsSavedSchema, settingsViewSchema, workspaceSettingsSavedSchema, workspaceSettingsViewSchema } from '#src/shared/contracts'
import { makeFixture } from './fixture'

/**
 * Two settings surfaces now: `/api/settings` is panel-wide (listener, auth policy,
 * host vitals, backups) and `/api/settings/workspace` is one workspace's own
 * (server defaults, log retention, notifications), resolved by `?workspace=<id>`.
 */

const fixtures: Fixture[] = []

async function app(): Promise<Fixture> {
  const created = await makeFixture()
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

function patch(created: Fixture, body: Record<string, unknown>, url = '/api/settings'): Promise<Response> {
  return Promise.resolve(created.app.request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('global settings route', () => {
  it('writes the panel-wide blocks a PATCH accepts', async () => {
    const created = await app()

    const response = await patch(created, {
      host: { diskUsedPercent: 42 },
      backups: { keep: 9 },
      control: { label: 'Homelab' },
    })

    expect(response.status).toBe(200)
    const written = JSON.parse(fs.readFileSync(created.settings.path, 'utf8')) as {
      host: { diskUsedPercent: number }
      backups: { keep: number }
      control: { label: string }
    }
    expect(written.host.diskUsedPercent).toBe(42)
    expect(written.backups.keep).toBe(9)
    expect(written.control.label).toBe('Homelab')
    expect(created.settings.host.diskUsedPercent).toBe(42)
    expect(created.settings.backups.keep).toBe(9)
    expect(created.settings.control.label).toBe('Homelab')
  })

  it('leaves the file alone when a block is rejected', async () => {
    const created = await app()
    const before = fs.readFileSync(created.settings.path, 'utf8')

    expect((await patch(created, { host: { diskUsedPercent: -1 } })).status).toBe(400)
    expect(fs.readFileSync(created.settings.path, 'utf8')).toBe(before)
  })

  it('refuses a block that belongs to a workspace', async () => {
    const created = await app()
    const before = fs.readFileSync(created.settings.path, 'utf8')

    // Logs, notifications and DDNS are a workspace's; the global schema rejects them
    // rather than silently dropping a page's save.
    expect((await patch(created, { logs: { keep: 7 } })).status).toBe(400)
    expect((await patch(created, { notifications: { telegram: { onHost: false } } })).status).toBe(400)
    expect((await patch(created, { ddns: { enabled: true } })).status).toBe(400)
    expect(fs.readFileSync(created.settings.path, 'utf8')).toBe(before)
  })

  it('answers the shapes the OpenAPI document describes', async () => {
    const created = await app()

    const read = settingsViewSchema(await (await created.app.request('/api/settings')).json())
    expect(read instanceof type.errors ? read.summary : 'ok').toBe('ok')

    const saved = settingsSavedSchema(await (await patch(created, { backups: { keep: 7 } })).json())
    expect(saved instanceof type.errors ? saved.summary : 'ok').toBe('ok')
  })
})

describe('workspace settings route', () => {
  it('writes one workspace\'s own blocks, into that workspace\'s file', async () => {
    const created = await app()
    const globalBefore = fs.readFileSync(created.settings.path, 'utf8')

    const response = await patch(created, {
      logs: { keep: 7 },
      notifications: { telegram: { onHost: false } },
      defaults: { autostart: true },
    }, '/api/settings/workspace')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: 'default',
      settingsPath: created.store.settingsPath,
      logs: { keep: 7 },
      defaults: { autostart: true },
    })

    const written = JSON.parse(fs.readFileSync(created.store.settingsPath, 'utf8')) as {
      logs: { keep: number }
      defaults: { autostart: boolean }
      notifications: { telegram: { onHost: boolean } }
    }
    expect(written.logs.keep).toBe(7)
    expect(written.defaults.autostart).toBe(true)
    expect(written.notifications.telegram.onHost).toBe(false)
    expect(created.store.logs.keep).toBe(7)
    expect(created.store.notifications.telegram.onHost).toBe(false)
    // Never the panel-wide file.
    expect(fs.readFileSync(created.settings.path, 'utf8')).toBe(globalBefore)
  })

  it('leaves the workspace file alone when a block is rejected', async () => {
    const created = await app()
    const before = fs.readFileSync(created.store.settingsPath, 'utf8')

    expect((await patch(created, { logs: { keep: 99 } }, '/api/settings/workspace')).status).toBe(400)
    expect(fs.readFileSync(created.store.settingsPath, 'utf8')).toBe(before)
  })

  it('resolves the workspace it names, and 404s one that does not exist', async () => {
    const created = await makeFixture({ workspaces: [{ id: 'staging', label: 'Staging' }] })
    fixtures.push(created)

    const staging = await (await created.app.request('/api/settings/workspace?workspace=staging')).json() as { id: string }
    expect(staging.id).toBe('staging')

    const patched = await patch(created, { logs: { keep: 2 } }, '/api/settings/workspace?workspace=staging')
    expect(patched.status).toBe(200)
    expect(created.workspaces.get('staging')!.store.logs.keep).toBe(2)
    expect(created.store.logs.keep).toBe(3)

    const unknown = await created.app.request('/api/settings/workspace?workspace=ghost')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'UNKNOWN_WORKSPACE' })
  })

  it('answers the shapes the OpenAPI document describes', async () => {
    const created = await app()

    const read = workspaceSettingsViewSchema(await (await created.app.request('/api/settings/workspace')).json())
    expect(read instanceof type.errors ? read.summary : 'ok').toBe('ok')

    const saved = workspaceSettingsSavedSchema(await (await patch(created, { logs: { keep: 7 } }, '/api/settings/workspace')).json())
    expect(saved instanceof type.errors ? saved.summary : 'ok').toBe('ok')
  })
})
