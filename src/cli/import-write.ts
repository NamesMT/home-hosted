import { invocation } from '#src/cli/io'
import { addServerEntry } from '#src/helpers/server-create'

/**
 * One entry through the same path `home-hosted add` uses.
 *
 * Deliberately not a second writer: `add` already answers "through `/_hh` when the panel runs, else
 * the workspace's own store, through the same validation". A `POST /api/servers` with an existing id
 * answers `409 SERVER_EXISTS`, and the offline store refuses it the same way, so an import over an
 * existing id fails one entry and keeps going — which is what a re-run of an import should do.
 *
 * The entry is validated against the panel's schema by the caller, before anything is written.
 */
export async function addServerEntryOffline(entry: Record<string, unknown>, workspace?: string): Promise<void> {
  const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
  const recorded = readRuntime()
  const live = recorded !== null && await runtimeIsAlive(recorded)
  const where = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`

  if (live) {
    const answer = await requestControl(recorded, `/_hh/servers${where}`, 15_000, 'POST', entry)
    if (answer === null)
      throw new Error(`the control panel is not answering on ${recorded.probeUrl}`)
    if (answer.status === 409)
      throw new Error(`already exists${workspace === undefined ? '' : ` in ${workspace}`}`)
    if (answer.status !== 201) {
      const body = answer.body as { message?: string } | null
      throw new Error(body?.message ?? `the panel answered ${answer.status}`)
    }
    return
  }

  const { readDefaultWorkspaceId, WorkspaceRegistry } = await import('#src/config/workspaces')
  const { WorkspaceStore } = await import('#src/config/store')
  const { workspaceServersPath, workspaceSettingsPath, workspacesPath } = await import('#src/helpers/paths')
  const fs = await import('node:fs')

  const id = workspace === undefined || workspace.length === 0 ? readDefaultWorkspaceId(workspacesPath) : workspace
  if (fs.existsSync(workspacesPath)) {
    const registry = new WorkspaceRegistry(workspacesPath)
    registry.load({ write: false })
    if (registry.configError !== null)
      throw new Error(`cannot read ${workspacesPath}: ${registry.configError}`)
    if (!registry.all().some(known => known.id === id))
      throw new Error(`unknown workspace "${id}"`)
  }
  else if (id !== 'default') {
    throw new Error(`unknown workspace "${id}" — this home has only the default workspace`)
  }

  const store = new WorkspaceStore(id, workspaceSettingsPath(id), workspaceServersPath(id))
  store.load()
  if (store.pendingMigrations.length > 0)
    throw new Error(`the config for workspace "${id}" needs \`${invocation()} migrate\` first`)
  addServerEntry(store, entry)
}
