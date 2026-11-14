import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, invocation, paint } from '#src/cli/io'
import { shellQuote } from '#src/helpers/shell'

/**
 * `ls [--workspace W] [--json]` — the entries one workspace declares, live from the panel when it is
 * up (`GET /_hh/servers`), or read-only from `servers.config.json` when it is not.
 */

export const lsArgs = {
  workspace: { type: 'string', alias: 'w', description: 'the workspace to list (default: the default workspace)' },
  json: { type: 'boolean', description: 'print machine-readable JSON' },
} as const

/** One row, from a live view or from the config alone. */
export interface LsRow {
  id: string
  /** `null` with no panel: nothing can say whether it runs. */
  status: string | null
  port: number | null
  command: string
  args: string[]
  autostart: boolean
  persistent: boolean
  enabled: boolean
}

interface ViewLike {
  id: string
  status?: string
  config?: { port?: number | null, command?: string, args?: string[], autostart?: boolean, persistent?: boolean, enabled?: boolean }
}

/** A live view as a row; the view's config is the stored entry. */
export function rowFromView(view: ViewLike): LsRow {
  const config = view.config ?? {}
  return {
    id: view.id,
    status: view.status ?? null,
    port: config.port ?? null,
    command: config.command ?? '',
    args: config.args ?? [],
    autostart: config.autostart === true,
    persistent: config.persistent === true,
    enabled: config.enabled !== false,
  }
}

/**
 * The table: `ID STATUS PORT COMMAND`, flags after the command.
 *
 * It is a **services** table. A `NEXT RUN` column used to appear whenever a job was listed, and half
 * the rows then carried a dash — a job serves no port, so its `PORT` cell was blank and its schedule
 * took the space. Jobs have `home-hosted job ls` and their own page now.
 */
export function lsLines(rows: readonly LsRow[]): string[] {
  const header = ['ID', 'STATUS', 'PORT', 'COMMAND']
  const cells = rows.map((row) => {
    const flags = [
      row.autostart ? 'autostart' : '',
      row.persistent ? 'persistent' : '',
      row.enabled ? '' : 'disabled',
    ].filter(Boolean)
    const columns = [
      row.id,
      row.status ?? '—',
      row.port === null ? '—' : String(row.port),
      `${[row.command, ...row.args].map(word => /[\s'"$`\\;()&|<>*?]/.test(word) ? shellQuote(word) : word).join(' ')}${flags.length === 0 ? '' : `  (${flags.join(', ')})`}`,
    ]
    return columns
  })
  const widths = header.slice(0, -1).map((title, index) => Math.max(title.length, ...cells.map(cell => cell[index]!.length)))
  const line = (columns: string[]): string => [
    ...columns.slice(0, -1).map((column, index) => column.padEnd(widths[index]!)),
    columns[columns.length - 1]!,
  ].join('  ').trimEnd()
  return [line(header), ...cells.map(line)]
}

export async function runLs(input: { workspace?: string, json?: boolean }): Promise<void> {
  const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
  const runtime = readRuntime()
  const live = runtime !== null && await runtimeIsAlive(runtime)
  const workspace = input.workspace === undefined || input.workspace.length === 0 ? undefined : input.workspace

  let rows: LsRow[]
  let workspaceId: string
  if (live) {
    const query = workspace === undefined ? '' : `?workspace=${encodeURIComponent(workspace)}`
    const answer = await requestControl(runtime, `/_hh/servers${query}`, 15_000, 'GET')
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)
    if (answer.status === 404 && (answer.body as { code?: string } | null)?.code !== 'UNKNOWN_WORKSPACE')
      fail(`the panel on ${runtime.url} is home-hosted ${runtime.version}, which cannot list servers from the CLI — restart it on this release`)
    if (answer.status !== 200)
      fail((answer.body as { message?: string } | null)?.message ?? `the panel answered ${answer.status}`)
    rows = ((answer.body as { servers?: ViewLike[] } | null)?.servers ?? []).map(rowFromView)
    workspaceId = workspace ?? 'default'
    if (workspace === undefined) {
      const { readDefaultWorkspaceId } = await import('#src/config/workspaces')
      const { workspacesPath } = await import('#src/helpers/paths')
      workspaceId = readDefaultWorkspaceId(workspacesPath)
    }
  }
  else {
    // Read-only: listing must not seed a workspace (`serversReader` parses the file directly).
    const { readDefaultWorkspaceId } = await import('#src/config/workspaces')
    const { workspacesPath } = await import('#src/helpers/paths')
    const { serversReader } = await import('#src/cli/down')
    workspaceId = workspace ?? readDefaultWorkspaceId(workspacesPath)
    const read = (await serversReader())(workspaceId)
    if (!read.complete)
      fail(`cannot read the servers of workspace "${workspaceId}" — \`${invocation()} up\` names the problem`)
    // Every row here is a **service**: jobs live in their own file and are listed by `home-hosted
    // job ls`, which is the point of the extraction — this table no longer has a column that is blank
    // for half its rows.
    rows = read.servers.map(server => ({
      id: server.id,
      status: null,
      port: server.port ?? null,
      command: server.command,
      args: server.args,
      autostart: server.autostart,
      persistent: server.persistent,
      enabled: server.enabled,
    }))
  }

  if (input.json === true) {
    process.stdout.write(`${JSON.stringify({ workspace: workspaceId, panelRunning: live, servers: rows }, null, 2)}\n`)
    return
  }
  if (rows.length === 0) {
    process.stdout.write(`${dim(`no servers in workspace "${workspaceId}" — \`${invocation()} add <id> -- <command>\` declares one`)}\n`)
    return
  }
  const [header, ...lines] = lsLines(rows)
  process.stdout.write(`${bold(header!)}\n`)
  for (const [index, line] of lines.entries()) {
    const status = rows[index]!.status
    process.stdout.write(`${status === 'running' ? line.replace(/running/, green('running')) : status === 'crashed' || status === 'conflict' ? paint('31', line) : line}\n`)
  }
  if (!live)
    process.stdout.write(`${dim(`the panel is not running, so no status — \`${invocation()} up\``)}\n`)
}

export const lsCommand = defineCommand({
  meta: { name: 'ls' },
  args: lsArgs,
  run: async ({ args }) => {
    await runLs({ workspace: typeof args.workspace === 'string' ? args.workspace.trim() : undefined, json: args.json === true })
  },
})
