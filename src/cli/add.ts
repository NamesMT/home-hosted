import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation } from '#src/cli/io'
import { errorMessage } from '#src/shared/error-message'

/**
 * `add <id> [--port N] [--cwd DIR] [--workspace W] [--persistent] [--autostart] -- <command> [args…]`
 *
 * Declares an entry without hand-editing JSON. Through the running panel's `/_hh` channel when it is
 * up (so the panel's own store writes it, and the panel sees it at once), otherwise into the
 * workspace's `servers.config.json` through the same `WorkspaceStore` and the same validation, written
 * atomically. Either way the entry is not started: `autostart` means "comes up with the panel".
 */

export const addArgs = {
  id: { type: 'positional', required: false, description: 'the new server id (a-z, 0-9, - and _)' },
  port: { type: 'string', description: 'the port it listens on' },
  cwd: { type: 'string', description: 'its working directory' },
  workspace: { type: 'string', alias: 'w', description: 'the workspace to add it to (default: the default workspace)' },
  persistent: { type: 'boolean', description: 'keep it running when the panel stops' },
  autostart: { type: 'boolean', description: 'start it whenever the panel starts' },
} as const

export interface AddInput {
  id?: string
  port?: string
  cwd?: string
  persistent?: boolean
  autostart?: boolean
  /** Everything after `--`. */
  command: string[]
}

/**
 * The create body for these flags, or the one sentence that refuses them. The schema itself is the
 * panel's (`serverCreateSchema`), checked by the caller; this only turns flags into fields.
 */
export function buildServerEntry(input: AddInput): { entry: Record<string, unknown> } | { error: string } {
  const id = input.id?.trim() ?? ''
  if (id.length === 0)
    return { error: 'add needs a server id — `add <id> -- <command> [args…]`' }
  const [command, ...args] = input.command
  if (command === undefined || command.trim().length === 0)
    return { error: `add needs the command after \`--\` — \`add ${id} -- node server.js\`` }

  let port: number | undefined
  if (input.port !== undefined) {
    const raw = input.port.trim()
    port = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      return { error: `invalid port: ${input.port}` }
  }
  if (input.cwd !== undefined && input.cwd.trim().length === 0)
    return { error: '--cwd needs a directory' }

  return {
    entry: {
      id,
      command,
      args,
      ...(port === undefined ? {} : { port }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.persistent === true ? { persistent: true } : {}),
      ...(input.autostart === true ? { autostart: true } : {}),
    },
  }
}

/** The words after the first `--`, which citty would otherwise read as its own. */
export function commandAfterDashes(rawArgs: readonly string[]): string[] {
  const index = rawArgs.indexOf('--')
  return index === -1 ? [] : rawArgs.slice(index + 1)
}

export async function runAdd(input: AddInput, workspace?: string): Promise<void> {
  const built = buildServerEntry(input)
  if ('error' in built)
    fail(built.error)
  const { entry } = built
  const id = String(entry.id)

  // The panel's own schema, before anything is sent or written, so both paths refuse alike.
  const { serverCreateSchema } = await import('#src/shared/contracts')
  const { type } = await import('arktype')
  const checked = serverCreateSchema(entry)
  if (checked instanceof type.errors)
    fail(`invalid server: ${checked.summary}`)

  const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
  const runtime = readRuntime()
  const live = runtime !== null && await runtimeIsAlive(runtime)
  const where = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`
  let workspaceId = workspace

  if (live) {
    const answer = await requestControl(runtime, `/_hh/servers${where}`, 15_000, 'POST', entry)
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)
    if (answer.status === 404 && (answer.body as { code?: string } | null)?.code !== 'UNKNOWN_WORKSPACE')
      fail(`the panel on ${runtime.url} is home-hosted ${runtime.version}, which cannot add a server from the CLI — restart it on this release, or use the panel`)
    if (answer.status !== 201)
      fail((answer.body as { message?: string } | null)?.message ?? `the panel answered ${answer.status}`)
  }
  else {
    workspaceId = await addOffline(entry, workspace)
  }

  const label = workspaceId === undefined || workspaceId.length === 0 || workspaceId === 'default' ? id : `${workspaceId}/${id}`
  const flag = workspace === undefined || workspace.length === 0 ? '' : ` -w ${workspace}`
  process.stdout.write(`${green('added')} ${label}\n`)
  if (live)
    process.stdout.write(`${dim(`not started${entry.autostart === true ? ' (autostart applies when the panel starts)' : ''} — \`${invocation()} start ${id}${flag}\``)}\n`)
  else
    process.stdout.write(`${dim(`the panel is not running — \`${invocation()} up\`${entry.autostart === true ? ` starts it with ${id}` : `, then \`${invocation()} start ${id}${flag}\``}`)}\n`)
}

/** Writes the entry through the workspace's own store; returns the workspace it landed in. */
async function addOffline(entry: Record<string, unknown>, workspace?: string): Promise<string> {
  const { readDefaultWorkspaceId, WorkspaceRegistry } = await import('#src/config/workspaces')
  const { WorkspaceStore } = await import('#src/config/store')
  const { addServerEntry } = await import('#src/helpers/server-create')
  const { workspaceServersPath, workspaceSettingsPath, workspacesPath } = await import('#src/helpers/paths')
  const fs = await import('node:fs')

  const id = workspace === undefined || workspace.length === 0 ? readDefaultWorkspaceId(workspacesPath) : workspace
  if (fs.existsSync(workspacesPath)) {
    const registry = new WorkspaceRegistry(workspacesPath)
    registry.load({ write: false })
    if (registry.configError !== null)
      fail(`cannot read ${workspacesPath}: ${registry.configError}`)
    if (!registry.all().some(known => known.id === id))
      fail(`unknown workspace "${id}" — add it in the panel first (known: ${registry.all().map(known => known.id).join(', ')})`)
  }
  else if (id !== 'default') {
    fail(`unknown workspace "${id}" — this home has only the default workspace`)
  }

  const store = new WorkspaceStore(id, workspaceSettingsPath(id), workspaceServersPath(id))
  store.load()
  if (store.pendingMigrations.length > 0)
    fail(`${store.path} needs ${store.pendingMigrations.length} migration(s) first — \`${invocation()} migrate\``)
  if (store.configError !== null)
    fail(`refusing to write ${store.path}: ${store.configError}`)
  try {
    addServerEntry(store, entry)
  }
  catch (error) {
    fail(errorMessage(error))
  }
  return id
}

export const addCommand = defineCommand({
  meta: { name: 'add' },
  args: addArgs,
  run: async ({ args, rawArgs }) => {
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
    await runAdd({
      id: typeof args.id === 'string' ? args.id : undefined,
      port: args.port,
      cwd: args.cwd,
      persistent: args.persistent,
      autostart: args.autostart,
      command: commandAfterDashes(rawArgs),
    }, workspace)
  },
})
