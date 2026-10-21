import type { BackupService } from '#src/services/backups'
import fs from 'node:fs'
import path from 'node:path'
import { GlobalSettingsStore } from '#src/config/settings'
import { WorkspaceStore } from '#src/config/store'
import { WorkspaceRegistry } from '#src/config/workspaces'
import {
  globalSecretsPath as defaultGlobalSecretsPath,
  globalSettingsPath as defaultGlobalSettingsPath,
  hhDir as defaultHhDir,
  tlsDir as defaultTlsDir,
  workspacesPath as defaultWorkspacesPath,
} from '#src/helpers/paths'
import { readNannyState } from '#src/providers/nanny'
import { buildBackupSources, BackupService as Service } from '#src/services/backups'

/**
 * A backup service for a host whose panel is **not running**.
 *
 * `backup` used to need the daemon because the service is built inside it, so backing up or
 * restoring meant leaving the panel up — the opposite of what someone migrating a machine wants.
 * Nothing in the service needs the daemon: every source is a file, and the one live fact it wants
 * (which entries are running) is on disk as the nanny state each entry writes.
 *
 * This builds the same sources the panel does, through the same `buildBackupSources`, so an offline
 * archive cannot differ from an online one. `runningServers` is answered from `.state/*.json` rather
 * than from supervisor views: a *persistent* entry keeps running when the panel stops, so "no panel"
 * does not mean "nothing is running", and the restore warning has to keep telling the truth.
 */

/** The workspace ids this host knows, from the registry on disk. */
function workspaceIds(registry: WorkspaceRegistry): Array<{ id: string, label: string }> {
  return registry.all().map(workspace => ({ id: workspace.id, label: workspace.label }))
}

/**
 * Entries whose nanny is alive right now, read from the state files they rewrite.
 *
 * Every path comes from `hhDir`, never from the module-level helpers: those resolve from this
 * process's own `HHOSTED_HOME`, so a caller passing `--home` elsewhere would read a different host's
 * state — which is exactly how a test came to depend on the developer's real `~/.home-hosted`.
 */
function runningFromDisk(hhDir: string, ids: string[]): Array<{ workspaceId: string, serverId: string }> {
  const running: Array<{ workspaceId: string, serverId: string }> = []
  for (const workspaceId of ids) {
    const stateDir = path.join(hhDir, workspaceId, '.state')
    let names: string[]
    try {
      names = fs.readdirSync(stateDir)
    }
    catch {
      continue
    }
    for (const name of names) {
      // `<id>.json` is a persistent entry's nanny state; `<id>.run.json` is a detached child.
      if (!name.endsWith('.json') || name.endsWith('.spec.json') || name.endsWith('.tmp'))
        continue
      const serverId = name.replace(/\.run\.json$|\.json$/, '')
      if (serverId.length === 0)
        continue
      const state = readNannyState(path.join(stateDir, name))
      if (state === null)
        continue
      // The heartbeat is the panel's own liveness rule, so this agrees with what the UI would say.
      if (Date.now() - state.heartbeatAt <= 30_000)
        running.push({ workspaceId, serverId })
    }
  }
  return running
}

export interface OfflineBackup {
  service: BackupService
  /** The workspaces this host declares, for a refusal that lists real ids. */
  workspaceIds: string[]
  /** Entries whose process is alive right now, read from the state files they rewrite. */
  runningNow: () => Array<{ workspaceId: string, serverId: string }>
}

/**
 * Build the service against this host's files.
 *
 * `ensureWorkspace` and `onRestored` are the two panel hooks, and both are deliberately absent: with
 * no daemon there is nothing to reload, and a restore that brings a workspace this host lacks leaves
 * it on disk for the next `up` to pick up. The registry is written by the service itself, which is
 * what makes that work.
 */
export function createOfflineBackup(options: { hhDir?: string, settingsPath?: string } = {}): OfflineBackup {
  const hhDir = options.hhDir ?? defaultHhDir
  const settingsPath = options.settingsPath ?? defaultGlobalSettingsPath
  const registryPath = path.join(hhDir, path.basename(defaultWorkspacesPath))

  const settings = new GlobalSettingsStore(settingsPath)
  settings.load()
  const registry = new WorkspaceRegistry(registryPath)
  registry.load()

  const workspaces = workspaceIds(registry)
  const ids = workspaces.map(workspace => workspace.id)

  // Each workspace's servers are read from its config, which is the only thing the source builder
  // needs beyond the id — no supervisor, no runtime.
  // The default workspace's servers file. A `--config` override is an `up`-only flag with no record
  // on disk, so it cannot be honoured here; the doc says so rather than the two paths diverging
  // silently.
  const loaded = workspaces.map((workspace) => {
    const dir = path.join(hhDir, workspace.id)
    const settingsPath = path.join(dir, 'settings.json')
    const serversPath = path.join(dir, 'servers.config.json')
    const secretsPath = path.join(dir, '.secrets.json')
    const store = new WorkspaceStore(workspace.id, settingsPath, serversPath)
    store.load()
    return { id: workspace.id, label: workspace.label, settingsPath, serversPath, secretsPath, servers: store.servers }
  })

  const service = new Service({
    dataRoot: hhDir,
    getConfig: () => settings.backups,
    /**
     * Register a workspace the archive brought.
     *
     * A panel-only hook in the running case, because the panel creates the runtime itself. With no
     * panel there is nobody to do it, so the registry is written here — otherwise a restored
     * workspace's files land on disk unreachable, and the next `up` never looks at them.
     */
    ensureWorkspace: (input) => {
      if (registry.has(input.id))
        return
      // `create` writes the registry file itself; there is no separate save.
      registry.create(input)
    },
    getSources: () => buildBackupSources({
      globalSettingsPath: settings.path,
      globalSecretsPath: path.join(hhDir, path.basename(defaultGlobalSecretsPath)),
      tlsDir: path.join(hhDir, path.basename(defaultTlsDir)),
      registryPath,
      includePaths: settings.backups.includePaths,
      runningServers: () => runningFromDisk(hhDir, ids),
      workspaces: loaded,
    }),
  })

  return { service, workspaceIds: ids, runningNow: () => runningFromDisk(hhDir, ids) }
}
