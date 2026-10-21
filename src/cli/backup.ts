import type { requestControl, Runtime } from '#src/helpers/daemon'
import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, invocation, prompt } from '#src/cli/io'
import { errorMessage } from '#src/shared/error-message'

/**
 * `backup` — take an archive, list them, or restore one, without a browser.
 *
 * The archive is written by the panel, never by this command: it drives the running panel over the
 * same local token `down` and `start` use, so the allowlist, the manifest shape and the retention
 * rules stay in one implementation.
 *
 * `create` and `restore` both **plan first**. Nothing is written unless `--confirm` is given or the
 * person answers yes at a prompt — and a session that cannot be asked is not treated as consent, so
 * it prints the plan and says how to apply it. `--json` prints the same plan as JSON, for a script
 * or an agent that wants to read it rather than apply it.
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

/** One thing a backup would capture, or a restore would write. */
interface PlanItem {
  id: string
  kind?: string
  label?: string
  note?: string | null
  items?: Array<{ id: string, label?: string }>
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

/**
 * `--include` parsed, or `undefined` when the flag was not given at all.
 *
 * An empty value is **refused**, not dropped. `--include ""` used to parse to `[]`, which the
 * request then omitted — so "act on nothing" silently became "act on everything", over live data.
 * `--all` is the only way to mean everything, and it says so out loud.
 */
function parseInclude(raw: string | undefined): string[] | undefined {
  if (raw === undefined)
    return undefined
  const parts = raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length === 0)
    fail('--include is empty — name the ids to act on, or pass --all for everything')
  return parts
}

/** `?a=b`, or `''`. */
function suffixOf(query: URLSearchParams): string {
  return query.size === 0 ? '' : `?${query.toString()}`
}

/** Appends one query parameter, keeping the `?`/`&` right. */
function withParam(suffix: string, key: string, value: string): string {
  return `${suffix}${suffix === '' ? '?' : '&'}${key}=${encodeURIComponent(value)}`
}

/**
 * Ask before writing.
 *
 * A session that cannot be asked gets the plan and a one-line instruction — not a silent write, and
 * not a silent no-op that looks like one.
 */
async function consent(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write('\nnot applied — this session cannot ask. Re-run with `--confirm` to apply.\n')
    return false
  }
  const answer = await prompt(`${question} [y/N] `)
  if (/^yes$|^y$/i.test(answer.trim())) {
    process.stdout.write('\n')
    return true
  }
  process.stdout.write('cancelled — nothing was written\n')
  return false
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

export async function runBackupCreate(options: { password?: string, include?: string[], confirm: boolean, json: boolean }): Promise<void> {
  const runtime = await livePanel()
  const query = new URLSearchParams()
  if (options.password !== undefined && options.password.length > 0)
    query.set('password', options.password)
  if (options.include !== undefined && options.include.length > 0)
    query.set('include', options.include.join(','))
  const suffix = suffixOf(query)

  if (!options.confirm) {
    // The plan: what this archive would capture, from the same view the page renders. The route
    // answers it and writes nothing, so this is always safe to call.
    const planned = await runtime.request(runtime, `/_hh/backups${suffix}`, 120000)
    if (planned === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)
    if (planned.status !== 200)
      refusal(planned)
    const plan = planned.body as { entries?: PlanItem[] } | null
    const entries = plan?.entries ?? []

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ action: 'create', apply: false, entries }, null, 2)}\n`)
      return
    }
    process.stdout.write(`${bold('Plan')} — what a backup would capture; nothing has been written yet\n`)
    for (const entry of entries) {
      process.stdout.write(`  ${String(entry.kind ?? 'entry').padEnd(10)} ${entry.id}${entry.note == null ? '' : `  ${dim(`(${entry.note})`)}`}\n`)
      for (const item of entry.items ?? [])
        process.stdout.write(`    ${dim('-')} ${item.id}\n`)
    }
    if (entries.length === 0) {
      process.stdout.write('  (nothing matched — check --include, or what the entries declare)\n')
      return
    }
    if (!await consent('Take this backup?'))
      return
  }

  // Generous: a large declared data directory is streamed to disk, not buffered in memory.
  const answer = await runtime.request(runtime, `/_hh/backups${withParam(suffix, 'confirm', 'true')}`, 600000)
  if (answer === null)
    fail(`the control panel is not answering on ${runtime.probeUrl}`)
  if (answer.status !== 200)
    refusal(answer)

  const body = answer.body as CreatedBody | null
  const file = body?.file
  if (file === undefined)
    fail('the panel reported success but named no archive')
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ action: 'create', apply: true, file }, null, 2)}\n`)
    return
  }
  process.stdout.write(`${green('backup created')} ${file.name} ${dim(`(${human(file.sizeBytes)})`)}\n`)
}

export async function runBackupRestore(options: { name: string, password?: string, include?: string[], confirm: boolean, json: boolean }): Promise<void> {
  const runtime = await livePanel()
  const base = new URLSearchParams({ name: options.name })
  if (options.password !== undefined && options.password.length > 0)
    base.set('password', options.password)
  if (options.include !== undefined && options.include.length > 0)
    base.set('include', options.include.join(','))
  const suffix = suffixOf(base)

  // The plan is free and always shown: it is the only way to see what a restore would overwrite.
  const planned = await runtime.request(runtime, `/_hh/backups/restore${suffix}`, 120000)
  if (planned === null)
    fail(`the control panel is not answering at ${runtime.probeUrl}`)
  if (planned.status !== 200)
    refusal(planned)
  const plan = planned.body as { items?: PlanItem[], warnings?: string[] } | null
  const items = plan?.items ?? []

  if (options.json && !options.confirm) {
    process.stdout.write(`${JSON.stringify({ action: 'restore', apply: false, name: options.name, items, warnings: plan?.warnings ?? [] }, null, 2)}\n`)
    return
  }

  if (!options.json) {
    process.stdout.write(`${bold('Plan')} for ${options.name} — nothing has been written yet\n`)
    for (const item of items)
      process.stdout.write(`  ${String(item.kind ?? 'item').padEnd(10)} ${item.id ?? item.label ?? ''}\n`)
    for (const warning of plan?.warnings ?? [])
      process.stdout.write(`  ${dim('!')} ${warning}\n`)
    if (items.length === 0) {
      process.stdout.write('  (nothing to restore — check --include, or what this host declares)\n')
      return
    }
  }

  if (!options.confirm && !await consent(`Restore these ${items.length} item(s) over this host?`))
    return

  const answer = await runtime.request(runtime, `/_hh/backups/restore${withParam(suffix, 'confirm', 'true')}`, 600000)
  if (answer === null)
    fail(`the control panel is not answering at ${runtime.probeUrl}`)
  if (answer.status !== 200)
    refusal(answer)

  const result = answer.body as { items?: PlanItem[], warnings?: string[] } | null
  const applied = result?.items ?? items
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ action: 'restore', apply: true, name: options.name, items: applied, warnings: result?.warnings ?? [] }, null, 2)}\n`)
    return
  }
  process.stdout.write(`${green('restored')} ${applied.length} ${applied.length === 1 ? 'item' : 'items'} from ${options.name}\n`)
  for (const warning of result?.warnings ?? [])
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
    include: { type: 'string', description: 'comma-separated item ids to act on' },
    all: { type: 'boolean', description: 'act on everything, rather than naming ids' },
    confirm: { type: 'boolean', description: 'apply without asking (a restore writes over live data)' },
    json: { type: 'boolean', description: 'print the plan or the result as JSON' },
  },
  async run({ args }) {
    try {
      const include = parseInclude(args.include)
      if (include !== undefined && args.all === true)
        fail('--include and --all are exclusive — pass one or the other')
      const action = args.action === undefined || args.action.length === 0 ? 'list' : args.action
      if (action === 'list') {
        await runBackupList(args.json === true)
      }
      else if (action === 'create') {
        await runBackupCreate({ password: args.password, include, confirm: args.confirm === true, json: args.json === true })
      }
      else if (action === 'restore') {
        if (args.target === undefined || args.target.length === 0)
          fail('restore needs the archive name — `backup list` shows them')
        await runBackupRestore({ name: args.target, password: args.password, include, confirm: args.confirm === true, json: args.json === true })
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
