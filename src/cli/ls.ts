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
  /** `job` rows carry a schedule; a service is supervised continuously and has none. */
  kind: 'service' | 'job'
  /** The job's expression, as written. Absent on a service. */
  schedule?: string
  /**
   * When the job next runs, from the panel's scheduler. `null` with no panel — the clock lives in the
   * panel, and a config file cannot say whether it is running — and for a job whose expression is
   * broken, which is the honest answer rather than a guess.
   */
  nextRunAt: number | null
}

interface ViewLike {
  id: string
  status?: string
  job?: { nextRunAt?: number | null, running?: boolean }
  config?: { port?: number | null, command?: string, args?: string[], autostart?: boolean, persistent?: boolean, enabled?: boolean, kind?: 'service' | 'job', schedule?: string }
}

/** A live view as a row; the view's config is the stored entry. */
export function rowFromView(view: ViewLike): LsRow {
  const config = view.config ?? {}
  const kind = config.kind === 'job' ? 'job' : 'service'
  return {
    id: view.id,
    status: view.status ?? null,
    port: config.port ?? null,
    command: config.command ?? '',
    args: config.args ?? [],
    autostart: config.autostart === true,
    persistent: config.persistent === true,
    enabled: config.enabled !== false,
    kind,
    ...(kind === 'job' && config.schedule !== undefined ? { schedule: config.schedule } : {}),
    nextRunAt: kind === 'job' ? view.job?.nextRunAt ?? null : null,
  }
}

/**
 * The table: `ID STATUS PORT COMMAND`, flags after the command, and a `NEXT RUN` column once a job is
 * listed.
 *
 * The column is **only** added when the workspace has a job: a services-only list keeps the four
 * columns it has always had, and a column of dashes beside every row would be noise in the common case.
 * A job's own `PORT` cell is a dash by contract (a job serves nothing), so the two new facts — its
 * expression and its next run — take the space the port never used.
 */
export function lsLines(rows: readonly LsRow[], now = Date.now()): string[] {
  const withJobs = rows.some(row => row.kind === 'job')
  const header = withJobs ? ['ID', 'STATUS', 'PORT', 'COMMAND', 'NEXT RUN'] : ['ID', 'STATUS', 'PORT', 'COMMAND']
  const cells = rows.map((row) => {
    const flags = [
      row.kind === 'job' ? 'job' : '',
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
    if (withJobs)
      columns.push(row.kind === 'job' ? nextRunCell(row, now) : '—')
    return columns
  })
  const widths = header.slice(0, -1).map((title, index) => Math.max(title.length, ...cells.map(cell => cell[index]!.length)))
  const line = (columns: string[]): string => [
    ...columns.slice(0, -1).map((column, index) => column.padEnd(widths[index]!)),
    columns[columns.length - 1]!,
  ].join('  ').trimEnd()
  return [line(header), ...cells.map(line)]
}

/**
 * A job's next run, short enough for a table: `in 4h 12m`, `running`, or `—`.
 *
 * `running` wins over the countdown, because that is the fact a person watching a long job needs. The
 * wording is relative and unstyled: this is a terminal table, not a translated sentence.
 */
function nextRunCell(row: LsRow, now: number): string {
  if (row.status === 'running')
    return 'running'
  if (row.nextRunAt === null)
    return '—'
  const delta = row.nextRunAt - now
  if (delta <= 0)
    return 'due'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60)
    return `in ${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48)
    return `in ${hours}h ${minutes % 60}m`
  return `in ${Math.floor(hours / 24)}d`
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
    rows = read.servers.map((server) => {
      const kind = server.kind === 'job' ? 'job' : 'service'
      return {
        id: server.id,
        status: null,
        port: server.port ?? null,
        command: server.command,
        args: server.args,
        autostart: server.autostart,
        persistent: server.persistent,
        enabled: server.enabled,
        kind,
        ...(kind === 'job' && server.schedule !== undefined ? { schedule: server.schedule } : {}),
        // No panel, no clock: a job's next run is the panel's scheduler's to report, and guessing one
        // from the file would be a number nobody computed.
        nextRunAt: null,
      }
    })
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
