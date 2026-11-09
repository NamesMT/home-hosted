import type { WorkspaceView } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { cleanPanelHarness, makeHarness, resetPanelModules, runningServer, waitFor } from '../support/panel-harness'

beforeEach(resetPanelModules)
afterEach(cleanPanelHarness)

/** The first half of `panelService`, and why it builds the real class, is in `panel.test.ts`. */
describe('panelService', () => {
  /**
   * A save that only changes a destination's policy must publish a frame.
   *
   * The signature keyed on `id:kind:enabled:tokenSet:lastResult` only, so changing
   * `useOwnSettings`, a chat id, a URL or any toggle published nothing — the page kept showing the
   * old values until the host sample happened to move, up to one interval later.
   */
  it('publishes a frame when only a destination policy value changes', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const runtime = panel.requireWorkspace('default')
      runtime.store.updateNotifications({ destinations: [{ kind: 'webhook', id: 'hook', url: 'https://ntfy.sh/a', useOwnSettings: true }] })

      // Freeze the clock-driven parts, so the policy edit is the only thing that can move.
      const patched = panel as unknown as { options: { hostMonitor: { current: unknown, tick: () => Promise<void> } } }
      const host = patched.options.hostMonitor
      const fixed = { ...(host.current as object) }
      host.tick = async () => { host.current = fixed }

      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      const before = frames.length

      runtime.store.updateNotifications({ destinations: [{ kind: 'webhook', id: 'hook', url: 'https://ntfy.sh/a', useOwnSettings: true, onCrash: false }] })
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(frames.length, 'a policy-only edit published no frame').toBeGreaterThan(before)
      expect(frames.at(-1)?.workspaces[0]?.notifications.destinations?.[0]).toMatchObject({ id: 'hook', onCrash: false })
    }
    finally {
      await dispose()
    }
  })

  /** `orphans` was missing from the hand-picked signature, so an orphan appearing published nothing. */
  it('publishes a frame when an orphan appears or goes', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const runtime = panel.requireWorkspace('default')
      const patched = panel as unknown as { options: { hostMonitor: { current: unknown, tick: () => Promise<void> } } }
      const host = patched.options.hostMonitor
      const fixed = { ...(host.current as object) }
      host.tick = async () => { host.current = fixed }
      let orphans: Array<{ serverId: string, pid: number, startedAt: number | null }> = []
      ;(runtime.supervisor as unknown as { orphans: () => unknown }).orphans = () => orphans

      // The preceding state is published first, so the change below is not banked in the signature.
      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      await new Promise(resolve => setTimeout(resolve, 150))

      const before = frames.length
      orphans = [{ serverId: 'gone', pid: 4242, startedAt: 1 }]
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(frames.length, 'a new orphan published no frame').toBeGreaterThan(before)
      expect(frames.at(-1)?.workspaces[0]?.orphans).toEqual(orphans)

      const after = frames.length
      orphans = []
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(frames.length, 'a cleared orphan published no frame').toBeGreaterThan(after)
      expect(frames.at(-1)?.workspaces[0]?.orphans).toEqual([])
    }
    finally {
      await dispose()
    }
  })

  it('publishes a frame when a credential changes, so every tab sees it', async () => {
    const { panel, frames, secrets, dispose } = await makeHarness()

    try {
      const patched = panel as unknown as { options: { hostMonitor: { current: unknown, tick: () => Promise<void> } } }
      const host = patched.options.hostMonitor
      const fixed = { ...(host.current as object) }
      host.tick = async () => { host.current = fixed }

      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      await new Promise(resolve => setTimeout(resolve, 150))

      const before = frames.length
      secrets.setApiToken('hh_a-token-minted-in-another-tab')
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(frames.length, 'a minted token published no frame').toBeGreaterThan(before)
      expect(frames.at(-1)?.control.auth.apiTokenSet).toBe(true)
    }
    finally {
      await dispose()
    }
  })

  it('sees a hand edit through its own watchers, without a restart', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const runtime = panel.requireWorkspace('default')
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ id: 'added', command: process.execPath, args: ['-e', 'null'] }],
      }, null, 2))

      // The panel's own ConfigWatch is what has to notice, so this waits on the real
      // watch rather than calling the private handler.
      await waitFor(() => runtime.store.servers.some(server => server.id === 'added'))
      await waitFor(() => frames.some(frame => frame.workspaces.some(workspace => workspace.serverCount === 1)))
    }
    finally {
      await dispose()
    }
  })

  it('keeps running what it has when a hand edit is unreadable', async () => {
    const { panel, dispose } = await makeHarness({
      servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const runtime = panel.requireWorkspace('default')
      expect(runtime.store.servers.map(server => server.id)).toEqual(['web'])

      fs.writeFileSync(runtime.store.path, '{ this is not json')

      // A typo must never stop a server: the error is reported and the live config
      // is kept, which is the whole point of the tolerant reader.
      await waitFor(() => runtime.store.configError !== null)
      expect(runtime.store.servers.map(server => server.id)).toEqual(['web'])
      expect(panel.getState().workspaces[0]!.configError).not.toBeNull()

      // …and fixing it clears the error without a restart.
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
      }, null, 2))
      await waitFor(() => runtime.store.configError === null)
    }
    finally {
      await dispose()
    }
  })

  /** What `home-hosted setup-temp` does: write `host.tempCommand` into the panel's own file. */
  it('sees a hand edit of the global settings, and the next save keeps it', async () => {
    const { settings, frames, dispose } = await makeHarness()

    try {
      const onDisk = JSON.parse(fs.readFileSync(settings.path, 'utf8')) as Record<string, any>
      onDisk.host = { ...onDisk.host, tempCommand: 'cat /tmp/temp' }
      onDisk.control = { ...onDisk.control, label: 'edited by hand' }
      fs.writeFileSync(settings.path, JSON.stringify(onDisk, null, 2))

      await waitFor(() => settings.host.tempCommand === 'cat /tmp/temp')
      await waitFor(() => frames.some(frame => frame.control.label === 'edited by hand'))

      // A save from the panel builds on the edit instead of overwriting it.
      settings.updateBackups({ keep: 2 })
      const after = JSON.parse(fs.readFileSync(settings.path, 'utf8')) as Record<string, any>
      expect(after.host.tempCommand).toBe('cat /tmp/temp')
    }
    finally {
      await dispose()
    }
  })

  it('keeps the running global settings when a hand edit is unreadable', async () => {
    const { settings, dispose } = await makeHarness()

    try {
      settings.updateControl({ label: 'running' })
      fs.writeFileSync(settings.path, '{ not json')

      await waitFor(() => settings.configError !== null)
      expect(settings.configError).toContain('cannot parse')
      expect(settings.control.label).toBe('running')

      const onDisk = { control: { label: 'fixed' }, meta: { writtenBy: 'test', schema: CONFIG_SCHEMA } }
      fs.writeFileSync(settings.path, JSON.stringify(onDisk, null, 2))
      await waitFor(() => settings.configError === null && settings.control.label === 'fixed')
    }
    finally {
      await dispose()
    }
  })

  it('tells every client the global settings are broken, and when they are fixed', async () => {
    const { settings, frames, dispose } = await makeHarness()

    try {
      fs.writeFileSync(settings.path, '{ not json')
      await waitFor(() => frames.at(-1)?.settingsError ? true : undefined)
      expect(frames.at(-1)?.settingsError).toMatchObject({ path: settings.path })
      expect(frames.at(-1)?.settingsError?.message).toContain('cannot parse')

      const onDisk = { control: { label: 'fixed' }, meta: { writtenBy: 'test', schema: CONFIG_SCHEMA } }
      fs.writeFileSync(settings.path, JSON.stringify(onDisk, null, 2))
      await waitFor(() => frames.at(-1)?.settingsError === null ? true : undefined)
    }
    finally {
      await dispose()
    }
  })

  it('refuses a hand edit that would serve the panel through the proxy with no password', async () => {
    const { settings, dispose } = await makeHarness()

    try {
      const onDisk = JSON.parse(fs.readFileSync(settings.path, 'utf8')) as Record<string, any>
      onDisk.proxy = { ...onDisk.proxy, enabled: true, routes: [{ id: 'panel', host: 'panel.example.com', target: 'panel' }] }
      fs.writeFileSync(settings.path, JSON.stringify(onDisk, null, 2))

      await waitFor(() => settings.configError !== null)
      expect(settings.configError).toContain('not applied')
      expect(settings.proxy.enabled).toBe(false)
    }
    finally {
      await dispose()
    }
  })

  it('reloads every workspace, e.g. after a restore', async () => {
    const { panel, settings, dispose } = await makeHarness({
      servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const runtime = panel.requireWorkspace('default')
      // A write that bypasses the panel's own save path, then a load.
      const raw = JSON.parse(fs.readFileSync(runtime.store.path, 'utf8')) as { servers: unknown[] }
      raw.servers = [{ id: 'restored', command: process.execPath, args: ['-e', 'null'] }]
      fs.writeFileSync(runtime.store.path, JSON.stringify(raw, null, 2))

      panel.reloadAll()
      expect(runtime.store.servers.map(server => server.id)).toEqual(['restored'])

      // Global settings are re-read too, so a restored listener takes effect. Asserted against a
      // value written to disk *after* the store was first loaded: the previous
      // `expect(settings.control.port).toBeGreaterThan(0)` held either way, since the port defaults
      // to a valid number and nothing here wrote global settings at all — deleting
      // `settings.load()` from `reloadAll()` left it green.
      const onDisk = JSON.parse(fs.readFileSync(settings.path, 'utf8')) as { control?: { label?: string } }
      onDisk.control = { ...onDisk.control, label: 'restored-panel' }
      fs.writeFileSync(settings.path, JSON.stringify(onDisk, null, 2))

      panel.reloadAll()
      expect(settings.control.label, 'reloadAll must re-read the global settings file').toBe('restored-panel')
    }
    finally {
      await dispose()
    }
  })

  it('starts an added autostart entry only when autostart is on', async () => {
    const { panel, dispose } = await makeHarness({ autostart: true })

    try {
      const runtime = panel.requireWorkspace('default')
      const before = panel.serverViews().length
      expect(before).toBe(0)

      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'auto', autostart: true, enabled: true }],
      }, null, 2))

      // The panel's own path from a hand edit to a started process.
      const started = await waitFor(() => {
        const view = panel.serverViews()[0]
        return view !== undefined && view.status !== 'stopped' ? view : undefined
      }, 20000)
      expect(started.id).toBe('auto')
      expect(started.config.autostart).toBe(true)
    }
    finally {
      await dispose()
    }
  })

  /**
   * A hand edit that lowers `logs.keep` must delete the rotations above it, exactly as the settings
   * page does.
   *
   * Both surfaces edit the same file — the panel writes it, a person writes it — and the docs say
   * lowering `keep` deletes the rotations above the new ceiling. Only the HTTP route called
   * `prune()`; `handleConfigChange` reloaded the store and never did, so a person who lowered the
   * ceiling by editing `settings.json` (the way the same page's docs invite) kept every rotation
   * until the entry next filled a file, which on a quiet server can be days. Measured: `keep` 5 -> 2
   * in `settings.json`, `.3`…`.5` still on disk after the watcher had reloaded.
   */
  it('prunes the rotations a hand-lowered `keep` no longer covers', async () => {
    const { panel, dispose } = await makeHarness()

    try {
      const runtime = panel.requireWorkspace('default')
      const logsDir = runtime.logsDir
      fs.mkdirSync(logsDir, { recursive: true })
      for (let index = 1; index <= 5; index++)
        fs.writeFileSync(path.join(logsDir, `web.log.${index}`), '{}\n')
      fs.writeFileSync(path.join(logsDir, 'web.log'), '{}\n')

      // The ceiling as a person lowering it by hand writes it.
      fs.writeFileSync(runtime.store.settingsPath, JSON.stringify({
        $schema: './settings.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        logs: { persist: true, maxBytes: 10000, keep: 2 },
      }, null, 2))

      // What the watcher does on the next poll.
      panel.reloadAll()

      const left = fs.readdirSync(logsDir).filter(name => name.startsWith('web.log.')).sort()
      expect(left, `rotations left after a hand edit: ${left.join(', ')}`).toEqual(['web.log.1', 'web.log.2'])
    }
    finally {
      await dispose()
    }
  })

  /**
   * A restore ends with `reloadAll()`, and `store.load()` resets the byte baseline the
   * config watcher compares against. The poll that follows therefore reports "no change",
   * so the autostart pass in `handleConfigChange` never ran and a restored entry stayed
   * stopped until the panel was restarted — against the README's "autostart entries come
   * up immediately".
   */
  it('starts an autostart entry that a restore revealed, without waiting for a restart', async () => {
    const { panel, dispose } = await makeHarness({ autostart: true })

    try {
      const runtime = panel.requireWorkspace('default')
      expect(runtime.store.servers).toHaveLength(0)

      // What a restore does: write the archive's servers file, then re-read everything.
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'restored', autostart: true, enabled: true }],
      }, null, 2))
      panel.reloadAll()

      const started = await waitFor(() => {
        const view = panel.serverViews()[0]
        return view !== undefined && view.status !== 'stopped' ? view : undefined
      }, 20000)
      expect(started.id).toBe('restored')
    }
    finally {
      await dispose()
    }
  })

  /**
   * A workspace the archive created is built by `ensureWorkspace`, whose `createRuntime`
   * loads the restored servers file — so the `reloadAll()` that follows sees no *new* ids
   * and would leave its autostart entries stopped.
   */
  it('starts the autostart entries of a workspace a restore created', async () => {
    const { panel, hhDir, dispose } = await makeHarness({ autostart: true })

    try {
      // What the restore writes before it registers the workspace.
      const staging = path.join(hhDir, 'staging')
      fs.mkdirSync(staging, { recursive: true })
      fs.writeFileSync(path.join(staging, 'servers.config.json'), JSON.stringify({
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'restored', autostart: true, enabled: true }],
      }, null, 2))

      panel.ensureWorkspace({ id: 'staging', label: 'Staging' })

      const started = await waitFor(() => {
        const view = panel.requireWorkspace('staging').supervisor.views()[0]
        return view !== undefined && view.status !== 'stopped' ? view : undefined
      }, 20000)
      expect(started.id).toBe('restored')
    }
    finally {
      await dispose()
    }
  })

  it('starts nothing on its own when autostart is off', async () => {
    const { panel, dispose } = await makeHarness({ autostart: false })

    try {
      const runtime = panel.requireWorkspace('default')
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'auto', autostart: true, enabled: true }],
      }, null, 2))

      await waitFor(() => runtime.store.servers.some(server => server.id === 'auto'))
      // `--no-autostart` still means the panel starts nothing by itself.
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(panel.serverViews().every(view => view.status === 'stopped')).toBe(true)
    }
    finally {
      await dispose()
    }
  })

  it('gives every workspace its own servers file under the state root', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      // One file per workspace, always at its own path: `up` takes no override, so the file the
      // panel supervises is the file a hand edit, a restore and an offline backup all read.
      const { workspaceServersPath } = await import('#src/helpers/paths')
      for (const id of ['default', 'staging'])
        expect(panel.requireWorkspace(id).store.path).toBe(workspaceServersPath(id))
      expect(panel.requireWorkspace('default').store.path).not.toBe(panel.requireWorkspace('staging').store.path)
    }
    finally {
      await dispose()
    }
  })

  it('tears down what it started, and stops publishing', async () => {
    const { panel, frames, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      // A frame is published while the panel is live.
      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      const settled = frames.length

      await panel.dispose()

      // A disposed panel never frames again, even if a late signal arrives: the
      // watchers and timers it owns are gone, and the interval is cleared.
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(frames.length).toBe(settled)
    }
    finally {
      // The harness dispose is what releases the proxy and the temp directory.
      await dispose()
    }
  })

  it('drives host sampling from its own tick, without throwing out of the interval', async () => {
    const { panel, settings, dispose } = await makeHarness({ withProxy: true })

    try {
      // The tick is the only thing that samples host vitals, and a throw inside it
      // would be an unhandled rejection — which ends the process on Node 24.
      expect(panel.getState().host.sampledAt).toBeNull()

      settings.updateHost({ enabled: true, intervalMs: 5000 })
      const sampled = await waitFor(() => panel.getState().host.sampledAt ?? undefined, 20000)
      expect(typeof sampled).toBe('number')

      // …and the panel kept building whole frames throughout.
      const state = panel.getState()
      expect(state.workspaces).toHaveLength(1)
      expect(state.proxy).toBeDefined()
    }
    finally {
      await dispose()
    }
  })
})

describe('the state frame a UI actually reads', () => {
  it('keeps a workspace view whole across a create', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      panel.create({ id: 'media', label: 'Media' })
      const frame = await waitFor(() => frames.find(entry => entry.workspaces.some(workspace => workspace.id === 'media')))
      const view = frame.workspaces.find(workspace => workspace.id === 'media') as WorkspaceView

      expect(view.label).toBe('Media')
      expect(view.serverCount).toBe(0)
      expect(view.runningCount).toBe(0)
      expect(view.configError).toBeNull()
      // The new workspace carries the general block and no destinations until one is added.
      expect(view.notifications.defaults?.onCrash).toBe(true)
      expect(view.notifications.destinations).toEqual([])
      expect(view.logsDir).toContain('media')
    }
    finally {
      await dispose()
    }
  })
})
