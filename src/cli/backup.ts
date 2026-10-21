import type { requestControl, Runtime } from '#src/helpers/daemon'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, invocation } from '#src/cli/io'
import { errorMessage } from '#src/shared/error-message'

/**
 * `backup` — take an archive, list them, or restore one, without a browser.
 *
 * The archive is written by the panel, never by this command: it drives the running panel over the
 * same local token `down` and `start` use, so the allowlist, the manifest shape and the retention
 * rules stay in one implementation. A restore is planned first and applied only with `--confirm`,
 * because it writes over live data.
 */

interface BackupFileView {
  name: string
  sizeBytes: number
  createdAt: number | null
  automatic: boolean
}

interface CreatedBody {
  file?: { name: string, sizeBytes: number }
}

function human(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The running panel's record, or a message saying what to do instead. */
async function livePanel(): Promise<Runtime & { request: typeof requestControl }> {
  const daemon = await import('#src/helpers/daemon')
  const runtime = daemon.readRuntime()
  if (runtime === null || !await daemon.runtimeIsAlive(runtime)) {
    if (runtime !== null && await daemon.runtimeIsGone(runtime))
      daemon.clearRuntime()
    fail(`home-hosted is not running — start it with \`${invocation()} up\`, then run this again`)
  }
  return Object.assign(runtime, { request: daemon.requestControl })
}

/** Turn a non-200 control answer into the panel's own message, or the status. */
function refusal(answer: { status: number, body: unknown }): never {
  const body = answer.body as { message?: string } | null
  if (body?.message !== undefined)
    fail(body.message)
  fail(`the panel answered ${answer.status}`)
}

export async function runBackupList(json: boolean): Promise<void> {
  const runtime = await livePanel()
  const answer = await runtime.request(runtime, '/_hh/backups', 30000, 'GET')
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)
  if (answer.status !== 200)
    refusal(answer)

  const view = answer.body as { files?: BackupFileView[], dir?: string } | null
  const files = view?.files ?? []
  if (json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
    return
  }
  if (files.length === 0) {
    process.stdout.write(`no backups yet — \`${invocation()} backup create\` takes one\n`)
    return
  }
  const noun = files.length === 1 ? 'archive' : 'archives'
  process.stdout.write(`${bold(String(files.length))} ${noun}${view?.dir === undefined ? '' : ` in ${dim(view.dir)}`}\n`)
  for (const file of files) {
    const when = file.createdAt === null ? '' : new Date(file.createdAt).toISOString().replace('T', ' ').slice(0, 16)
    process.stdout.write(`  ${file.name.padEnd(36)} ${human(file.sizeBytes).padStart(8)}  ${dim(when)}${file.automatic ? dim(' auto') : ''}\n`)
  }
}

export async function runBackupCreate(options: { password?: string, include?: string[] }): Promise<void> {
  const runtime = await livePanel()
  const query = new URLSearchParams()
  if (options.password !== undefined && options.password.length > 0)
    query.set('password', options.password)
  if (options.include !== undefined && options.include.length > 0)
    query.set('include', options.include.join(','))
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  // Generous: a large declared data directory is streamed to disk, not buffered in memory.
  const answer = await runtime.request(runtime, `/_hh/backups${suffix}`, 600000)
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)
  if (answer.status !== 200)
    refusal(answer)

  const body = answer.body as CreatedBody | null
  const file = body?.file
  if (file === undefined)
    fail('the panel reported success but named no archive')
  process.stdout.write(`${green('backup created')} ${file.name} ${dim(`(${human(file.sizeBytes)})`)}\n`)
}

export async function runBackupRestore(options: { name: string, password?: string, include?: string[], confirm: boolean }): Promise<void> {
  const runtime = await livePanel()
  const query = new URLSearchParams({ name: options.name })
  if (options.password !== undefined && options.password.length > 0)
    query.set('password', options.password)
  if (options.include !== undefined && options.include.length > 0)
    query.set('include', options.include.join(','))
  if (options.confirm)
    query.set('confirm', 'true')

  const answer = await runtime.request(runtime, `/_hh/backups/restore?${query.toString()}`, 600000)
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)
  if (answer.status !== 200)
    refusal(answer)

  const plan = answer.body as { apply?: boolean, items?: Array<{ id: string, kind: string }>, warnings?: string[] } | null
  const items = plan?.items ?? []
  if (!options.confirm) {
    process.stdout.write(`${bold('Plan')} for ${options.name} — nothing has been written yet\n`)
    for (const item of items)
      process.stdout.write(`  ${item.kind.padEnd(10)} ${item.id}\n`)
    for (const warning of plan?.warnings ?? [])
      process.stdout.write(`  ${dim('!')} ${warning}\n`)
    process.stdout.write(`\napply it with \`${invocation()} backup restore ${options.name} --confirm\`\n`)
    return
  }
  process.stdout.write(`${green('restored')} ${items.length} ${items.length === 1 ? 'item' : 'items'} from ${options.name}\n`)
  for (const warning of plan?.warnings ?? [])
    process.stdout.write(`  ${dim('!')} ${warning}\n`)
}

export const backupCommand = defineCommand({
  meta: { name: 'backup' },
  args: {
    // Two positionals: `backup restore <name>`. citty reads them by name, so the first is the
    // action and the second the archive — the order on the command line is the order here.
    action: { type: 'positional', description: 'list (default) | create | restore', required: false },
    target: { type: 'positional', description: 'the archive name, for restore', required: false },
    password: { type: 'string', description: 'encrypt the archive, or unlock it on restore' },
    include: { type: 'string', description: 'comma-separated item ids to capture, or to restore' },
    confirm: { type: 'boolean', description: 'apply a restore instead of only planning it' },
    json: { type: 'boolean', description: 'print machine-readable JSON (list)' },
  },
  async run({ args }) {
    try {
      const include = args.include === undefined ? undefined : args.include.split(',').filter(part => part.length > 0)
      const action = args.action === undefined || args.action.length === 0 ? 'list' : args.action
      if (action === 'list') {
        await runBackupList(args.json === true)
      }
      else if (action === 'create') {
        await runBackupCreate({ password: args.password, include })
      }
      else if (action === 'restore') {
        if (args.target === undefined || args.target.length === 0)
          fail('restore needs the archive name — `backup list` shows them')
        await runBackupRestore({ name: args.target, password: args.password, include, confirm: args.confirm === true })
      }
      else {
        fail(`unknown action "${action}" — use list, create or restore`)
      }
    }
    catch (error) {
      fail(errorMessage(error))
    }
  },
})
