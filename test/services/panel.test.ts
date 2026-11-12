import type { NotificationEvent } from '#src/services/notifications'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { cleanPanelHarness, makeHarness, portAcceptsOn, resetPanelModules, twoWorkspacePortFixture, waitFor } from '../support/panel-harness'

beforeEach(resetPanelModules)
afterEach(cleanPanelHarness)

/**
 * The real `PanelService`, not a stand-in.
 *
 * Every route suite runs against `test/api/fixture.ts`, which re-implements this
 * class's surface over its own stores — deliberately, because the routes are what
 * those tests are about. That leaves the wiring here uncovered: which service each
 * workspace gets, that a create really lands in the registry, that a hand edit
 * reaches the supervisor, that a broken config is reported without stopping
 * anything, and that dispose tears down what the constructor started.
 *
 * `PanelService` builds every path from the module constants in
 * `#src/helpers/paths.ts`, so each case sets `HHOSTED_HOME` to its own temp
 * directory and re-imports the graph — never the developer's real home. The same
 * trick `test/config/layout.test.ts` uses.
 */

describe('panelService', () => {
  it('builds one isolated runtime per registered workspace', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      expect(panel.workspaces().map(runtime => runtime.id)).toEqual(['default', 'staging'])

      // A workspace is the ownership boundary: same-named things inside two
      // workspaces must not share a file, a store or a supervisor.
      const [first, second] = panel.workspaces()
      expect(first!.store.path).not.toBe(second!.store.path)
      expect(first!.secrets.path).not.toBe(second!.secrets.path)
      expect(first!.logsDir).not.toBe(second!.logsDir)
      expect(second!.logsDir.startsWith(second!.store.path)).toBe(false)
      expect(first!.supervisor).not.toBe(second!.supervisor)
      // A notification cooldown is keyed by `serverId:reason`, with no workspace in the key — which
      // is only safe because each workspace owns its own service. Prove it behaviourally: one
      // workspace's flapping `api` must not silence the other's, which is exactly what a shared
      // service would do. Telegram is switched on for both, or `shouldNotify` answers false for
      // every event and the assertion below would hold vacuously.
      expect(first!.notifications).not.toBe(second!.notifications)
      for (const runtime of [first!, second!])
        runtime.store.updateNotifications({ destinations: [{ kind: 'telegram', id: 'tg', enabled: true, chatId: '1', cooldownMs: 60_000 }] })
      const flap: NotificationEvent = { serverId: 'api', label: 'api', reason: 'crash', detail: 'boom' }
      const now = 1_000_000
      first!.notifications.markSent(flap, now)
      expect(first!.notifications.shouldNotify(flap, now + 1), 'the same workspace is cooled down').toBe(false)
      expect(second!.notifications.shouldNotify(flap, now + 1), 'another workspace must not be').toBe(true)

      // Each keeps its own label and view.
      expect(panel.workspace('staging')?.label).toBe('Staging')
      expect(panel.workspace('ghost')).toBeUndefined()
    }
    finally {
      await dispose()
    }
  })

  it('resolves the default workspace lazily, and refuses an unknown id', async () => {
    const { panel, registry, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      expect(panel.defaultId()).toBe('default')
      expect(panel.requireWorkspace().id).toBe('default')
      expect(panel.requireWorkspace('staging').id).toBe('staging')
      // An empty id means the default, never another workspace.
      expect(panel.requireWorkspace('').id).toBe('default')
      expect(() => panel.requireWorkspace('nope')).toThrow(/unknown workspace/)

      // When the registry's default is gone, the first remaining runtime answers —
      // rather than an id nothing can resolve.
      registry.remove('default')
      expect(panel.defaultId()).toBe('staging')
    }
    finally {
      await dispose()
    }
  })

  it('creates and renames a workspace through the registry, not beside it', async () => {
    const { panel, registry, dispose } = await makeHarness()

    try {
      const created = panel.create({ id: 'media', label: 'Media' })
      expect(created.id).toBe('media')
      expect(panel.workspace('media')).toBeDefined()
      // The registry is the durable record; the runtime follows it.
      expect(registry.all().map(entry => entry.id)).toContain('media')
      expect(fs.readFileSync(registry.path, 'utf8')).toContain('"media"')

      // Its directory and seeded config exist, so a restart finds the same shape.
      const runtime = panel.workspace('media')!
      expect(fs.existsSync(runtime.store.path)).toBe(true)
      expect(runtime.store.servers).toEqual([])

      const renamed = panel.rename('media', 'Media Server')
      expect(renamed.label).toBe('Media Server')
      expect(panel.workspace('media')?.label).toBe('Media Server')
      expect(registry.get('media')?.label).toBe('Media Server')

      expect(() => panel.rename('ghost', 'x')).toThrow(/unknown workspace/)
    }
    finally {
      await dispose()
    }
  })

  it('registers a new workspace only once its directory exists', async () => {
    const { panel, registry, hhDir, dispose } = await makeHarness()

    try {
      // A file where the directory should go: the filesystem refuses the mkdir.
      const blocker = path.join(hhDir, 'blocked')
      fs.writeFileSync(blocker, 'not a directory')
      expect(() => panel.create({ id: 'blocked', label: 'Blocked' })).toThrow()
      expect(registry.has('blocked')).toBe(false)
      expect(fs.readFileSync(registry.path, 'utf8')).not.toContain('"blocked"')
      expect(panel.workspace('blocked')).toBeUndefined()
      // It was not ours to remove.
      expect(fs.readFileSync(blocker, 'utf8')).toBe('not a directory')

      // An id no filesystem can carry is refused before anything is made.
      expect(() => panel.create({ id: 'a'.repeat(300) })).toThrow(/at most 40/)
      expect(() => panel.create({ id: 'nul' })).toThrow(/Windows device name/)
      expect(registry.all().map(entry => entry.id)).toEqual(['default'])
    }
    finally {
      await dispose()
    }
  })

  it('removes a workspace with its directory, and never the last one', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const dir = path.dirname(panel.requireWorkspace('staging').store.path)
      expect(fs.existsSync(dir)).toBe(true)

      await panel.remove('staging')
      expect(panel.workspace('staging')).toBeUndefined()
      expect(panel.workspaces().map(runtime => runtime.id)).toEqual(['default'])
      // The directory goes with it: a re-created id must not inherit its state.
      expect(fs.existsSync(dir)).toBe(false)

      // One workspace is the floor — the panel would have nowhere to put anything.
      await expect(panel.remove('default')).rejects.toThrow(/only workspace/)
    }
    finally {
      await dispose()
    }
  })

  it('never lets two concurrent removals leave the panel with no workspace', async () => {
    const { panel, registry, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      // Each removal has a server to stop, so both are suspended in an await at the same time.
      for (const id of ['default', 'staging']) {
        const runtime = panel.requireWorkspace(id)
        fs.writeFileSync(runtime.store.path, JSON.stringify({ $schema: './servers.config.schema.json', meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }] }, null, 2))
        runtime.store.reloadFromDisk()
        vi.spyOn(runtime.supervisor, 'stop').mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          return { ok: true }
        })
      }

      const results = await Promise.allSettled([panel.remove('default'), panel.remove('staging')])
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(panel.workspaces()).toHaveLength(1)
      expect(registry.all()).toHaveLength(1)
      expect(registry.all()[0]!.id).toBe(panel.workspaces()[0]!.id)
    }
    finally {
      await dispose()
    }
  })

  it('takes no new work while a workspace is being removed, and stops its persistent entries', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const runtime = panel.requireWorkspace('staging')
      fs.writeFileSync(runtime.store.path, JSON.stringify({ $schema: './servers.config.schema.json', meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }] }, null, 2))
      runtime.store.reloadFromDisk()
      let release!: () => void
      vi.spyOn(runtime.supervisor, 'stop').mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { ok: true }
      })
      const disposeSpy = vi.spyOn(runtime.supervisor, 'dispose')

      const removal = panel.remove('staging')
      await waitFor(() => release !== undefined)
      // Mid-removal: a request for this workspace is refused, so nothing new can start in it.
      expect(() => panel.requireWorkspace('staging')).toThrow(/being removed/)
      release()
      await removal

      expect(disposeSpy).toHaveBeenCalledWith({ withPersistent: true })
    }
    finally {
      await dispose()
    }
  })

  it('leaves the workspace intact when the registry refuses the removal', async () => {
    const { panel, registry, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const runtime = panel.requireWorkspace('staging')
      const dir = path.dirname(runtime.store.path)
      const removeSpy = vi.spyOn(registry, 'remove').mockImplementation(() => {
        throw new Error('disk full')
      })

      await expect(panel.remove('staging')).rejects.toThrow(/disk full/)
      expect(panel.workspace('staging')).toBe(runtime)
      expect(fs.existsSync(dir)).toBe(true)
      expect(runtime.watches.length).toBeGreaterThan(0)
      // The watchers still run: a hand edit is still picked up.
      fs.writeFileSync(runtime.store.path, JSON.stringify({ $schema: './servers.config.schema.json', meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers: [{ id: 'after', command: process.execPath, args: ['-e', 'null'] }] }, null, 2))
      await waitFor(() => runtime.store.servers.some(server => server.id === 'after'))

      // And the reservation is released, so a retry can go through.
      removeSpy.mockRestore()
      await panel.remove('staging')
      expect(panel.workspace('staging')).toBeUndefined()
    }
    finally {
      await dispose()
    }
  })

  /**
   * A workspace is not removed while one of its processes survived the stop.
   *
   * `stopEntry` keeps a persistent entry's nanny state **on purpose** when its pid outlived SIGKILL —
   * "its pid is in the state file" is how a later boot reaches a child the stop could not forward. That
   * file sits under `workspaceDir(id)`, which removal deletes recursively, so removing anyway leaves the
   * process running with nothing that knows its name. The loop used to log the failure and continue.
   */
  it('refuses to remove a workspace whose process survived the stop', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const runtime = panel.requireWorkspace('staging')
      const dir = path.dirname(runtime.store.path)
      expect(fs.existsSync(dir)).toBe(true)

      // `makeHarness` seeds `servers` into the *default* workspace, so the removal loop would find
      // nothing to stop here. Write this workspace's own file, then reload the store it already built.
      const stuck = { id: 'stuck', command: process.execPath, args: ['-e', 'null'] }
      fs.writeFileSync(runtime.store.path, JSON.stringify({ $schema: './servers.config.schema.json', meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers: [stuck] }, null, 2))
      runtime.store.reloadFromDisk()
      expect(runtime.store.servers, 'the workspace must have a server to stop').toHaveLength(1)

      // Exactly what `stopEntry` returns for a pid that outlived SIGKILL.
      vi.spyOn(runtime.supervisor, 'stop').mockResolvedValue({ ok: false, error: 'pid 4242 survived the stop' })

      await expect(panel.remove('staging')).rejects.toThrow(/survived the stop/)
      // Nothing was removed: the workspace is still registered and its directory is intact, which is
      // what keeps the surviving process findable.
      expect(panel.workspace('staging')).toBeDefined()
      expect(fs.existsSync(dir), 'the state file that finds the process must survive').toBe(true)
    }
    finally {
      await dispose()
    }
  })

  it('resolves a server by its (workspace, server) pair, never by id alone', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
      servers: [{ id: 'shared', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const found = panel.findServer('default', 'shared')
      expect(found?.config.id).toBe('shared')
      expect(found?.workspace.id).toBe('default')

      // The same id in a workspace that has no such entry is a miss, not a borrow.
      expect(panel.findServer('staging', 'shared')).toBeNull()
      expect(panel.findServer('ghost', 'shared')).toBeNull()
      expect(panel.findServer('default', 'ghost')).toBeNull()
    }
    finally {
      await dispose()
    }
  })

  /**
   * A port held by another workspace's server is this panel's server, not a stranger to free.
   *
   * `Supervisor.supervisedPids()` only walks its own entries, so a sibling workspace's pid looked
   * foreign to every consumer of the split. Measured on a real panel with two workspaces, a
   * `free-port` on `staging` terminated `default`'s server on the shared port and answered
   * `{"ok":true,"terminated":[<default's pid>],"free":true}` while that workspace's entry restarted
   * under a new pid; `follow` then adopted the sibling's process, so both workspaces reported the
   * same pid as running and stopping one left the other claiming it. One guard, because both halves
   * are the same split — the two assertions are kept apart so a fix to one cannot hide the other.
   */
  it('never frees a port held by another workspace', async () => {
    const { owner, borrower, ownerPid, port, dispose } = await twoWorkspacePortFixture({ policy: 'block' })

    try {
      const freed = await borrower.freePort('borrower')
      expect(freed.ok, 'freeing a sibling workspace\'s port is a refusal, not a success').toBe(false)
      expect(freed.terminated).toEqual([])
      expect(freed.error).toContain('which this panel supervises')
      // And it says *where* to go: the holder is on a page this workspace's UI cannot show.
      expect(freed.error).toContain('default/owner')

      // The owner is untouched: still the same process, still serving.
      const ownerView = owner.views().find(view => view.id === 'owner')!
      expect(ownerView.status).toBe('running')
      expect(ownerView.pid).toBe(ownerPid)
      expect(await portAcceptsOn(port), 'the sibling must still be serving its port').toBe(true)
    }
    finally {
      await dispose()
    }
  })

  it('never adopts another workspace\'s process, even under `follow`', async () => {
    const { owner, borrower, ownerPid, dispose } = await twoWorkspacePortFixture({ policy: 'follow' })

    try {
      const started = await borrower.start('borrower')
      expect(started.ok, 'a sibling workspace\'s process must not be adopted as this entry').toBe(false)
      // And no second claim on the pid: the borrower stays down while the owner keeps it.
      expect(borrower.views().find(view => view.id === 'borrower')!.pid).toBeNull()
      expect(owner.views().find(view => view.id === 'owner')!.pid).toBe(ownerPid)
    }
    finally {
      await dispose()
    }
  })

  it('lists every workspace DDNS account, with the credentials that belong to it', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const defaults = panel.requireWorkspace('default')
      const staging = panel.requireWorkspace('staging')

      // One account that can answer a challenge (Cloudflare) and one that cannot
      // (No-IP): the proxy page reads this to decide what it may offer, so both
      // flags matter.
      defaults.store.updateDdns({ accounts: [{ id: 'cf', provider: 'cloudflare', label: 'Cloudflare' }] })
      staging.store.updateDdns({ accounts: [{ id: 'noip', provider: 'noip', label: 'No-IP' }] })

      const accounts = panel.listDnsAccounts()
      expect(accounts).toEqual([
        { workspace: 'default', account: 'cf', provider: 'cloudflare', label: 'Cloudflare', writesTxt: true, hasCredentials: false },
        { workspace: 'staging', account: 'noip', provider: 'noip', label: 'No-IP', writesTxt: false, hasCredentials: false },
      ])

      // Credentials live with the workspace that owns the account, and the flag
      // follows them.
      defaults.secrets.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'secret-token' })
      expect(panel.listDnsAccounts()[0]!.hasCredentials).toBe(true)
      expect(panel.findDnsAccount('default', 'cf')?.credentials).toEqual({ apiToken: 'secret-token' })
      // The pair is the key: the same account id in another workspace is not it.
      expect(panel.findDnsAccount('staging', 'cf')).toBeNull()
      expect(panel.findDnsAccount('ghost', 'cf')).toBeNull()
      expect(panel.findDnsAccount('default', 'ghost')).toBeNull()
    }
    finally {
      await dispose()
    }
  })

  it('scopes server views to one workspace, or flattens them all', async () => {
    const { panel, dispose } = await makeHarness()

    try {
      expect(panel.serverViews()).toEqual([])
      expect(panel.serverViews('default')).toEqual([])
      // An unknown workspace is empty, not everything.
      expect(panel.serverViews('ghost')).toEqual([])
    }
    finally {
      await dispose()
    }
  })

  it('frames the whole panel in one state object', async () => {
    const { panel, hhDir, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const state = panel.getState()
      expect(state.control.port).toBe(3999)
      expect(state.workspaces.map(workspace => workspace.id)).toEqual(['default', 'staging'])
      expect(state.dataRoot).toBe(path.join(hhDir, '..').replace(/\/$/, ''))
      expect(state.projectDir.length).toBeGreaterThan(0)
      expect(typeof state.version).toBe('string')

      // A panel with no proxy says nothing about one: the field is additive, and an
      // older UI must not be handed a half-built proxy view.
      expect(state.proxy).toBeUndefined()
    }
    finally {
      await dispose()
    }
  })

  it('carries the proxy in the frame when the panel has one', async () => {
    const { panel, dispose } = await makeHarness({ withProxy: true })

    try {
      const state = panel.getState()
      expect(state.proxy).toBeDefined()
      expect(state.proxy?.status.state).toBe('off')
      // Not installed, so the engine says so rather than pretending.
      expect(state.proxy?.engine.installed).toBe(false)
      expect(state.proxy?.routes).toEqual([])
    }
    finally {
      await dispose()
    }
  })

  it('reports the sources a backup is built from', async () => {
    const { panel, hhDir, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
      servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const sources = panel.backupSources()
      expect(sources.globalSecretsPath).toContain('.control-secrets.json')
      expect(sources.globalSettingsPath).toContain('settings.json')
      expect(sources.tlsDir).toContain('.tls')
      expect(sources.includePaths).toEqual(panel.settings.backups.includePaths)

      // One source per workspace, each naming its own files — and the servers it
      // declares, so the restore plan can list them.
      expect(sources.workspaces.map(workspace => workspace.id)).toEqual(['default', 'staging'])
      const first = sources.workspaces[0]!
      expect(first.serversPath).toBe(panel.requireWorkspace('default').store.path)
      expect(first.settingsPath).toBe(panel.requireWorkspace('default').store.settingsPath)
      expect(first.secretsPath).toBe(panel.requireWorkspace('default').secrets.path)
      expect(first.servers.map(server => server.id)).toEqual(['web'])
      expect(sources.workspaces[1]!.servers).toEqual([])

      // The global leaves really exist under $HHOSTED_HOME/.hh.
      expect(fs.existsSync(sources.globalSecretsPath)).toBe(false)
      expect(path.dirname(sources.globalSettingsPath)).toBe(hhDir)
    }
    finally {
      await dispose()
    }
  })

  it('publishes one frame per turn, and only when something actually changed', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      const first = frames.length

      // Two signals in the same turn coalesce into at most one more frame.
      panel.notifyStateChange()
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(frames.length).toBeLessThanOrEqual(first + 1)

      // A repeat of the same state is not news: the signature gate drops it.
      const settled = frames.length
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(frames.length).toBe(settled)
    }
    finally {
      await dispose()
    }
  })

  /**
   * Switching host sampling off publishes a frame.
   *
   * `host.enabled` is not a decoration on the wire: four surfaces in both UIs render it as their
   * whole empty state (`HostVitals`' head says "sampling off", `HostVitalsPanel` swaps the dial
   * grid for one, `HostRail` and `InstrumentCluster` each fall back to it). `stateSignature` named
   * only `sampledAt` and `alerts` for the host block, and the disabled branch of `HostMonitor.tick`
   * writes neither — it keeps the last sample and flips `enabled`. So the transition published
   * **nothing at all**, and a second tab kept drawing live dials for a panel that had stopped
   * measuring: the same stale-view defect this function has already been fixed twice for
   * (`ui` above, a destination's policy below), each time by adding the one field that was missing.
   *
   * Driving the real monitor rather than patching its view: the disabled branch is where the field
   * is written, so a hand-set `enabled` would only prove the signature covers a field, not that the
   * transition reaches a client.
   */
  /**
   * Switching host sampling off publishes a frame.
   *
   * `host.enabled` is not decoration on the wire: four surfaces in both UIs render it as their whole
   * empty state — `HostVitals`' head reads "sampling off", `HostVitalsPanel` swaps its dial grid for
   * one, and `HostRail`/`InstrumentCluster` each fall back to it. `stateSignature` named only
   * `sampledAt` and `alerts` for the host block, and the disabled branch of `HostMonitor.tick` writes
   * neither: it keeps the last sample and flips `enabled`. Measured on the real service — sample,
   * publish, disable, tick, `notifyStateChange()` — the frame count stayed at 2 and both frames still
   * read `enabled: true`, so a second tab kept drawing live dials for a panel that had stopped
   * measuring. It is the same stale-view defect this function has been fixed for twice before (`ui`
   * below, a destination's policy after it), and each time the fix was one more hand-picked field.
   *
   * The sample's own frame is published *before* the switch, deliberately: a test that skipped that
   * pass would leave the sample "banked" in the signature and the switch would publish a frame for
   * the wrong reason — which is exactly how the first version of this test went green.
   */
  it('carries a switch of host sampling into a published frame', async () => {
    const { panel, settings, frames, dispose } = await makeHarness()
    const hostMonitor = (panel as unknown as {
      options: { hostMonitor: { tick: (now?: number) => Promise<void> } }
    }).options.hostMonitor
    const realTick = hostMonitor.tick.bind(hostMonitor)
    /*
     * The panel's own timer ticks `HostMonitor` on the *real* clock every second, so a simulated
     * tick 20 s ahead would be followed a second later by a real one that samples again, and the
     * fixture rather than the code would be what moved `sampledAt`. Only the ticks below get through.
     */
    let allowed = false
    hostMonitor.tick = async (now?: number) => {
      if (allowed)
        await realTick(now)
    }

    try {
      // A real sample, then its frame — so what is left to report is the switch alone. Past the
      // 15 s default interval, or the tick skips and there is no sample to go stale.
      allowed = true
      await realTick(20_000)
      allowed = false
      panel.notifyStateChange()
      await waitFor(() => frames.some(frame => frame.host.sampledAt !== null))
      const sampled = frames.at(-1)!
      const sampledAt = sampled.host.sampledAt
      expect(sampled.host.enabled, 'the sample itself should report sampling on').toBe(true)

      settings.updateHost({ enabled: false })
      allowed = true
      await realTick(20_000)
      allowed = false
      expect(panel.getState().host.enabled, 'the monitor did not record the switch').toBe(false)

      // The routes publish through this door. The client has to be told.
      const before = frames.length
      panel.notifyStateChange()
      await waitFor(() => frames.length > before)

      const last = frames.at(-1)!
      expect(last.host.enabled, 'a switched-off sampler was published as sampling').toBe(false)
      // The last reading stays on the frame with its timestamp, so a surface can say how old it is
      // rather than imply it is current.
      expect(last.host.sampledAt).toBe(sampledAt)
    }
    finally {
      await dispose()
    }
  })

  /**
   * `ui` is part of the state frame — Global Settings → Interface reads which UI is installed
   * straight from it — but it was missing from `stateSignature`, the gate that decides whether
   * a frame is published at all. A UI upload or revert therefore published nothing on its own;
   * it surfaced only when something *else* moved, which the host sample eventually does.
   *
   * Asserting on the published frames rather than their count: the host sample is in the
   * signature too, so a count can move for reasons that have nothing to do with `ui`.
   */
  it('carries the served UI change into a published frame', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const patched = panel as unknown as { options: { ui: { status: () => unknown } } }
      let custom = false
      patched.options.ui.status = () => (custom
        ? { custom: true, dir: '/tmp/custom-ui', meta: { name: 'mine', version: '1.0.0' } }
        : { custom: false, dir: '/tmp/stock-ui', meta: null })

      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      expect(frames.at(-1)?.ui).toMatchObject({ custom: false })

      // Freeze what the signature already tracks, so the only thing that can make this frame
      // new is `ui` itself.
      const host = (patched as unknown as { options: { hostMonitor: { current: unknown, tick: () => Promise<void> } } }).options.hostMonitor
      const fixed = { ...(host.current as object) }
      host.tick = async () => { host.current = fixed }

      const before = frames.length
      custom = true
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(frames.length, 'a UI change published no frame').toBeGreaterThan(before)
      expect(frames.at(-1)?.ui).toMatchObject({ custom: true, meta: { name: 'mine' } })
    }
    finally {
      await dispose()
    }
  })
})
