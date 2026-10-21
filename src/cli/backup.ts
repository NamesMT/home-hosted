import type { OfflineBackup } from '#src/cli/backup-offline'
import type { requestControl, Runtime } from '#src/helpers/daemon'
import process from 'node:process'
import { defineCommand } from 'citty'
import { createOfflineBackup } from '#src/cli/backup-offline'
import { bold, dim, fail, green, invocation, paint, prompt } from '#src/cli/io'
import { unknownBackupIds } from '#src/shared/backup-scope'
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
  /** Only the panel's view carries it; the service's own list does not. */
  automatic?: boolean
}

interface CreatedBody {
  file?: { name: string, sizeBytes: number }
}

/** One thing a backup would capture, or a restore would write. */
interface PlanHook {
  serverId: string
  workspaceId: string
  action: 'dump' | 'load'
  ok: boolean
  output?: string
}

interface PlanItem {
  id: string
  kind?: string
  label?: string
  note?: string | null
  /** The plan lists everything; this says whether the request selected it. */
  selected?: boolean
  items?: Array<{ id: string, label?: string, note?: string | null }>
}

/** One row of a plan: an id, and what the panel says about it. */
interface PlanRow {
  id: string
  note?: string | null
}

/**
 * Render plan ids as the tree they already are.
 *
 * Every id is a colon-separated path, so the hierarchy is in the data and the renderer's only job is
 * to show it: one row per prefix, each one level deeper than its parent. Depth is whatever the id
 * says, not a fixed number of columns — `workspace:default:secrets:telegram` sits three deep, and a
 * renderer that assumed two printed it beside its own parent.
 *
 * Both directions print through this, and so does the "what could I act on" list, so the three read
 * alike. A row's note is the panel's own wording, passed through untouched.
 */
function printPlanTree(rows: PlanRow[]): void {
  const known = new Set(rows.map(row => row.id))
  // Every prefix of every id, so a parent that is not itself a row still gets a line to hang under.
  const nodes = new Map<string, { note: string | null, children: Set<string> }>()
  const ensure = (id: string): { note: string | null, children: Set<string> } => {
    const existing = nodes.get(id)
    if (existing !== undefined)
      return existing
    const created = { note: null, children: new Set<string>() }
    nodes.set(id, created)
    return created
  }
  for (const row of rows) {
    const segments = row.id.split(':')
    // `workspace:<id>:data:/a/b` carries a path in its last segment; it is a leaf, not a branch.
    for (let depth = 1; depth <= segments.length; depth++) {
      const id = segments.slice(0, depth).join(':')
      const node = ensure(id)
      if (depth > 1)
        ensure(segments.slice(0, depth - 1).join(':')).children.add(id)
      if (depth === segments.length && known.has(row.id))
        node.note = row.note ?? null
    }
  }

  const roots = [...nodes.keys()].filter(id => !id.includes(':'))
  const write = (id: string, depth: number): void => {
    const node = nodes.get(id)
    if (node === undefined)
      return
    const padding = '  '.repeat(depth)
    process.stdout.write(`${padding}${depth === 1 ? '' : '- '}${id}${node.note === null ? '' : `  ${dim(`(${node.note})`)}`}\n`)
    for (const child of node.children)
      write(child, depth + 1)
  }
  for (const root of roots)
    write(root, 1)
}

function human(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The running panel's record, or a message saying what to do instead. */
async function livePanel(): Promise<(Runtime & { request: typeof requestControl }) | null> {
  const daemon = await import('#src/helpers/daemon')
  const runtime = daemon.readRuntime()
  if (runtime === null || !await daemon.runtimeIsAlive(runtime)) {
    if (runtime !== null && await daemon.runtimeIsGone(runtime))
      daemon.clearRuntime()
    return null
  }
  return Object.assign(runtime, { request: daemon.requestControl })
}

/**
 * Whether to talk to a panel or work on the files directly.
 *
 * Both paths run the same service, so the only question is who owns the state: a live panel is the
 * authority on what is running, and a stopped one has no opinion to disagree with.
 */
async function usesPanel(): Promise<boolean> {
  const daemon = await import('#src/helpers/daemon')
  const runtime = daemon.readRuntime()
  if (runtime === null || !await daemon.runtimeIsAlive(runtime))
    return false
  return (await daemon.probeRuntime(runtime)).reachable
}

/**
 * The offline service.
 *
 * It reads the same files the panel does — every workspace's `settings.json` and
 * `servers.config.json` under the state root — so an archive taken with the panel down holds what a
 * running one would have captured.
 */
async function offlineBackup(): Promise<OfflineBackup> {
  return createOfflineBackup()
}

/** Turn a non-200 control answer into the panel's own message, or the status. */
function refusal(answer: { status: number, body: unknown }): never {
  const body = answer.body as { message?: string } | null
  if (body?.message !== undefined)
    fail(body.message)
  fail(`the panel answered ${answer.status}`)
}

/**
 * What a `create`/`restore` should act on: `'all'`, or an explicit list of ids.
 *
 * There is no "neither flag" case. Reading it as "everything" made the destructive path the default —
 * `backup create --confirm` would archive the whole machine, and a restore would write the whole
 * archive, without anyone naming what they meant. A scope is now required, so silence is refused
 * rather than guessed.
 */
type Scope = { kind: 'all' } | { kind: 'include', ids: string[] }

/**
 * The flag combination, as far as it can be judged without asking the panel.
 *
 * `null` means "neither flag", which only the caller can resolve — it lists the available ids, and
 * that needs a panel. Every other case is decided here, before any lookup, so a typo is refused
 * whether or not anything is running.
 */
function parseScope(all: boolean, raw: string | undefined): Scope | null {
  if (all && raw !== undefined)
    fail('--include and --all are exclusive — pass one or the other')
  if (all)
    return { kind: 'all' }
  if (raw === undefined)
    return null
  const ids = raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (ids.length === 0)
    fail('--include is empty — name the ids to act on, or pass --all for everything')
  return { kind: 'include', ids }
}

/**
 * The plan rows a scope selects, and an exclusion drops.
 *
 * `kind` is deliberately not part of this: it is the panel's label for a row, not an id, and every id
 * the plan prints is already prefixed with it (`global:settings`, `workspace:default:servers`).
 */
/** Flatten a nested plan into the rows the tree renders. */
function flattenRows(rows: PlanItem[]): PlanRow[] {
  return rows.flatMap(row => [
    { id: row.id, note: row.note ?? null },
    ...(row.items ?? []).map(leaf => ({ id: leaf.id, note: leaf.note ?? null })),
  ])
}

function filterEntries<T extends { id: string, items?: Array<{ id: string }> }>(entries: T[], scope: Scope, exclude: string[] | undefined): T[] {
  const unwanted = exclude ?? []
  const excluded = (id: string): boolean => unwanted.some(entry => id === entry || id.startsWith(`${entry}:`))
  // Upwards too: naming a leaf (`workspace:default:servers`) has to keep its parent entry in the
  // plan, or the leaf's own file is captured and the plan says "nothing matched".
  const named = (id: string): boolean => scope.kind === 'all'
    || scope.ids.some(entry => id === entry || id.startsWith(`${entry}:`) || entry.startsWith(`${id}:`))
  // The leaves are filtered too: a plan that lists `workspace:default:servers` while the archive
  // leaves it out is a plan that describes a different backup from the one it is planning.
  return entries
    .filter(entry => named(entry.id) && !excluded(entry.id))
    .map(entry => (entry.items === undefined
      ? entry
      : { ...entry, items: entry.items.filter(leaf => named(leaf.id) && !excluded(leaf.id)) }))
}

/**
 * Refuse an id the plan does not have.
 *
 * An id that matches nothing is silently ignored by the service, which is right for an archive that
 * simply does not carry something — and wrong for a typo: `--exclude global:secret` excludes nothing
 * and says nothing, so the archive carries the credentials the person believed they had dropped.
 */
function assertKnown(ids: string[] | undefined, entries: PlanItem[], flag: string): void {
  if (ids === undefined)
    return
  // The same rule the settings page applies to a schedule scope, so a typo is refused wherever it
  // is typed rather than only in the dialog.
  const unknown = unknownBackupIds(ids, entries)
  if (unknown.length > 0)
    fail(`${flag} names ${unknown.map(id => `"${id}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in this plan — \`backup create\` with no flags lists the ids`)
}

/** `--exclude` parsed. An empty value is a mistake, not "exclude nothing". */
function parseExclude(raw: string | undefined): string[] | undefined {
  if (raw === undefined)
    return undefined
  const ids = raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (ids.length === 0)
    fail('--exclude is empty — name the ids to leave out, or drop the flag')
  return ids
}

/**
 * Neither flag given. Refused outright — the ids are a *bonus*, not the reason.
 *
 * The refusal must not depend on a panel being up: a mistyped command deserves the flag error, not
 * "home-hosted is not running". So the list is best-effort, and a failure to produce it is silent.
 */
async function refuseWithoutScope(action: 'create' | 'restore', suffix: string): Promise<never> {
  const rows = await availableRows(action, suffix).catch(() => [] as PlanItem[])
  if (rows.length === 0)
    fail('name what to act on — pass --include <ids> or --all')
  // The same tree the plan uses, so all three outputs read alike: a flat list here was the one place
  // the scopes and the nesting disappeared.
  process.stderr.write(`${paint('31', 'error')} name what to act on — pass --include <ids> or --all\n\n`)
  process.stderr.write('available (or narrow it):\n')
  printPlanTree(flattenRows(rows))
  process.stderr.write('\n--exclude <ids> leaves those out: --all --exclude global:secrets\n')
  process.exit(1)
}

/**
 * The ids an offline run could act on, read from the state files.
 *
 * The refusal has to name real ids whether or not a panel is up — an empty list is the one answer
 * worse than no list, because it reads as "there is nothing to back up".
 */
async function availableRowsFromDisk(action: 'create' | 'restore', suffix: string): Promise<PlanItem[]> {
  try {
    const { service } = await offlineBackup()
    await service.warm()
    if (action === 'create')
      return service.view().entries as unknown as PlanItem[]
    // A restore lists what the **archive** holds, not what this host declares. Reading the create
    // view here named every slot on the machine — including ones the archive never carried — and
    // marked them "(not set)", which is not a thing a restore can be missing.
    const name = new URLSearchParams(suffix.startsWith('?') ? suffix.slice(1) : suffix).get('name')
    if (name === null || name.length === 0)
      return []
    const archive = service.resolve(name)
    if (archive === null)
      return []
    const plan = await service.restore(archive, { confirm: false })
    return (plan.items ?? []).filter(item => item.selected !== false)
  }
  catch {
    return []
  }
}

/**
 * The ids this action could be scoped to.
 *
 * `create` asks what the entries declare; `restore` asks what the archive holds. Both come from the
 * panel, so the list in a refusal is the real one rather than a hardcoded guess. A panel that cannot
 * be reached yields no ids — the refusal still fires, it just cannot enumerate.
 */
async function availableRows(action: 'create' | 'restore', suffix: string): Promise<PlanItem[]> {
  // Read the record directly rather than through `livePanel()`: a hint must not `fail()` the process
  // when the panel is down, and the caller turns an empty list into "nothing to list".
  const daemon = await import('#src/helpers/daemon')
  const runtime = daemon.readRuntime()
  if (runtime === null || !await daemon.runtimeIsAlive(runtime))
    return await availableRowsFromDisk(action, suffix)
  const path = action === 'create' ? '/_hh/backups' : '/_hh/backups/restore'
  const answer = await daemon.requestControl(runtime, `${path}${suffix}`, 120000)
  if (answer === null || answer.status !== 200)
    return []
  const body = answer.body as { entries?: PlanItem[], items?: PlanItem[] } | null
  // The rows themselves, not just their ids: a refusal that lists what could be acted on should say
  // the same things the plan does, `(not set)` included.
  return action === 'create' ? (body?.entries ?? []) : (body?.items ?? [])
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

/**
 * Run against the panel when one is up, and against the files when it is not.
 *
 * Both run the same `BackupService`, so the archive cannot differ; only the authority on what is
 * running changes. A stopped panel is exactly when someone wants to back up or restore — the services
 * are down because they stopped them on purpose.
 */
export async function runBackupList(json: boolean): Promise<void> {
  if (await usesPanel()) {
    const runtime = await livePanel()
    if (runtime !== null) {
      const answer = await runtime.request(runtime, '/_hh/backups', 30000, 'GET')
      if (answer === null)
        fail(`the control panel is not answering on ${runtime.probeUrl}`)
      if (answer.status !== 200)
        refusal(answer)
      printList(answer.body as { files?: BackupFileView[], dir?: string } | null, json)
      return
    }
  }
  const { service } = await offlineBackup()
  await service.warm()
  printList(service.view(), json)
}

function printList(view: { files?: BackupFileView[], dir?: string } | null, json: boolean): void {
  const files = view?.files ?? []
  if (json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
    return
  }
  if (files.length === 0) {
    process.stdout.write(`no backups yet — \`${invocation()} backup create --all\` takes one\n`)
    return
  }
  const noun = files.length === 1 ? 'archive' : 'archives'
  process.stdout.write(`${bold(String(files.length))} ${noun}${view?.dir === undefined ? '' : ` in ${dim(view.dir)}`}\n`)
  for (const file of files) {
    const when = file.createdAt == null ? '' : new Date(file.createdAt).toISOString().replace('T', ' ').slice(0, 16)
    process.stdout.write(`  ${file.name.padEnd(36)} ${human(file.sizeBytes).padStart(8)}  ${dim(when)}${file.automatic ? dim(' auto') : ''}\n`)
  }
}

/**
 * Name the entries still running, without blocking.
 *
 * A **persistent** entry keeps running while the panel is stopped, so "panel off" is not "services
 * off" — and its data being captured mid-write is worth knowing before it is relied on. Warned rather
 * than refused: the user may know, and the panel's own backup has always proceeded here.
 */
function warnRunning(entries: Array<{ workspaceId?: string, serverId?: string, id?: string }>): void {
  if (entries.length === 0)
    return
  const named = entries.map(entry => entry.serverId ?? entry.id ?? '').filter(name => name.length > 0)
  const isOne = named.length === 1
  process.stdout.write(`${dim(`! ${named.length} entr${isOne ? 'y is' : 'ies are'} still running (${named.join(', ')}) — its data may be captured mid-write`)}\n`)
}

export async function runBackupCreate(options: { password?: string, scope: Scope, exclude?: string[], confirm: boolean, json: boolean }): Promise<void> {
  const scope = options.scope
  const online = await usesPanel()

  // The plan: what this archive would capture, from the same source either way.
  const entries = await (async (): Promise<PlanItem[]> => {
    if (online) {
      const runtime = await livePanel()
      if (runtime !== null) {
        const answer = await runtime.request(runtime, '/_hh/backups', 120000)
        if (answer === null)
          fail(`the control panel is not answering on ${runtime.probeUrl}`)
        if (answer.status !== 200)
          refusal(answer)
        return (answer.body as { entries?: PlanItem[] } | null)?.entries ?? []
      }
    }
    const { service } = await offlineBackup()
    await service.warm()
    return service.view().entries as unknown as PlanItem[]
  })()

  // Checked against the plan the user is looking at, so a typo is refused instead of quietly
  // excluding nothing.
  assertKnown(options.exclude, entries, '--exclude')
  assertKnown(scope.kind === 'include' ? scope.ids : undefined, entries, '--include')
  const wanted = filterEntries(entries, scope, options.exclude)

  if (!options.confirm) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ action: 'create', apply: false, entries: wanted }, null, 2)}\n`)
      return
    }
    process.stdout.write(`${bold('Plan')} — what a backup would capture; nothing has been written yet\n`)
    printPlanTree(flattenRows(wanted))
    if (wanted.length === 0) {
      process.stdout.write('  (nothing matched — check --include, or what the entries declare)\n')
      return
    }
    warnRunning(await runningEntries())
    if (!await consent('Take this backup?'))
      return
  }

  const include = scope.kind === 'include' ? scope.ids : undefined
  const exclude = options.exclude
  const created = await (async (): Promise<CreatedBody | null> => {
    if (online) {
      const runtime = await livePanel()
      if (runtime !== null) {
        const query = new URLSearchParams()
        if (options.password !== undefined && options.password.length > 0)
          query.set('password', options.password)
        if (include !== undefined)
          query.set('include', include.join(','))
        if (exclude !== undefined)
          query.set('exclude', exclude.join(','))
        const answer = await runtime.request(runtime, `/_hh/backups${withParam(suffixOf(query), 'confirm', 'true')}`, 600000)
        if (answer === null)
          fail(`the control panel is not answering on ${runtime.probeUrl}`)
        if (answer.status !== 200)
          refusal(answer)
        return answer.body as CreatedBody | null
      }
    }
    const { service } = await offlineBackup()
    await service.warm()
    const result = await service.create({ password: options.password, include, exclude })
    if (!result.ok)
      fail(result.error ?? 'the backup failed')
    return { file: result.file }
  })()

  const file = created?.file
  if (file === undefined)
    fail('the backup reported success but named no archive')
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ action: 'create', apply: true, file }, null, 2)}\n`)
    return
  }
  process.stdout.write(`${green('backup created')} ${file.name} ${dim(`(${human(file.sizeBytes)})`)}\n`)
}

/**
 * The entries running right now.
 *
 * Read from the state files in **both** cases: the panel's own backup view has no per-entry running
 * flag to read, and the state files are the same witness the panel's supervisor would give — a
 * persistent entry keeps its nanny alive and rewrites that file whether or not the panel is up.
 */
async function runningEntries(): Promise<Array<{ workspaceId: string, serverId: string }>> {
  return (await offlineBackup()).runningNow()
}

export async function runBackupRestore(options: { name: string, password?: string, scope: Scope, exclude?: string[], confirm: boolean, json: boolean }): Promise<void> {
  const scope = options.scope
  const online = await usesPanel()

  const service = online ? null : (await offlineBackup()).service
  if (service !== null)
    await service.warm()

  // The plan is free and always shown: it is the only way to see what a restore would overwrite.
  const plan = await (async (): Promise<{ items?: PlanItem[], warnings?: string[], hooks?: PlanHook[] } | null> => {
    if (service !== null) {
      const archive = service.resolve(options.name)
      if (archive === null)
        fail(`no backup named "${options.name}" — \`${invocation()} backup list\` shows them`)
      return await service.restore(archive, { confirm: false, password: options.password, include: scope.kind === 'include' ? scope.ids : undefined, exclude: options.exclude })
    }
    const runtime = await livePanel()
    if (runtime === null)
      fail(`the control panel is not answering — try again once it is up`)
    const base = new URLSearchParams({ name: options.name })
    if (options.password !== undefined && options.password.length > 0)
      base.set('password', options.password)
    if (scope.kind === 'include')
      base.set('include', scope.ids.join(','))
    if (options.exclude !== undefined)
      base.set('exclude', options.exclude.join(','))
    const answer = await runtime.request(runtime, `/_hh/backups/restore${suffixOf(base)}`, 120000)
    if (answer === null)
      fail(`the control panel is not answering at ${runtime.probeUrl}`)
    if (answer.status !== 200)
      refusal(answer)
    return answer.body as { items?: PlanItem[], warnings?: string[], hooks?: PlanHook[] } | null
  })()

  // Every item the archive knows, with `selected` on each — `--include` narrows the selection, not
  // the list. Reading the list as the selection reported the whole archive either way.
  const items = (plan?.items ?? []).filter(item => item.selected !== false)

  if (options.json && !options.confirm) {
    process.stdout.write(`${JSON.stringify({ action: 'restore', apply: false, name: options.name, items, warnings: plan?.warnings ?? [] }, null, 2)}\n`)
    return
  }

  if (!options.json) {
    process.stdout.write(`${bold('Plan')} for ${options.name} — nothing has been written yet\n`)
    printPlanTree(items.map(item => ({ id: item.id, note: item.note ?? null })))
    for (const warning of plan?.warnings ?? [])
      process.stdout.write(`  ${dim('!')} ${warning}\n`)
    if (items.length === 0) {
      process.stdout.write('  (nothing to restore — check --include, or what this host declares)\n')
      return
    }
  }

  if (!options.confirm && !await consent(`Restore these ${items.length} item(s) over this host?`))
    return

  // No lock here: `BackupService.restore` takes it on apply, so this path and the panel's both get
  // it from one place. A second guard here would be the third implementation of the same rule.
  {
    const outcome = await (async (): Promise<{ items: PlanItem[], hooks: PlanHook[] }> => {
      if (service !== null) {
        const archive = service.resolve(options.name)!
        const result = await service.restore(archive, { confirm: true, password: options.password, include: scope.kind === 'include' ? scope.ids : undefined, exclude: options.exclude })
        // An offline restore leaves the panel to pick the files up on its next start, so say so when
        // the workspace list changed under it.
        return {
          items: (result.items ?? []).filter(item => item.selected !== false),
          hooks: (result.hooks ?? []).filter(hook => hook.action === 'load'),
        }
      }
      const runtime = await livePanel()
      if (runtime === null)
        fail('the control panel stopped answering — nothing further was written')
      const base = new URLSearchParams({ name: options.name })
      if (options.password !== undefined && options.password.length > 0)
        base.set('password', options.password)
      if (scope.kind === 'include')
        base.set('include', scope.ids.join(','))
      if (options.exclude !== undefined)
        base.set('exclude', options.exclude.join(','))
      const answer = await runtime.request(runtime, `/_hh/backups/restore${withParam(suffixOf(base), 'confirm', 'true')}`, 600000)
      if (answer === null)
        fail(`the control panel is not answering at ${runtime.probeUrl}`)
      if (answer.status !== 200)
        refusal(answer)
      const result = answer.body as { items?: PlanItem[], hooks?: PlanHook[] } | null
      return {
        items: (result?.items ?? plan?.items ?? []).filter(item => item.selected !== false),
        hooks: (result?.hooks ?? plan?.hooks ?? []).filter(hook => hook.action === 'load'),
      }
    })()
    const applied = outcome.items

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ action: 'restore', apply: true, name: options.name, items: applied, hooks: outcome.hooks, warnings: plan?.warnings ?? [] }, null, 2)}\n`)
      return
    }
    process.stdout.write(`${green('restored')} ${applied.length} ${applied.length === 1 ? 'item' : 'items'} from ${options.name}\n`)
    for (const hook of outcome.hooks)
      // "staged", not "ran": the hook runs on the entry's next start, and saying it already ran
      // would leave a person waiting for data that has not been loaded yet.
      process.stdout.write(`  ${dim(`load ${hook.serverId}: ${hook.output ?? 'staged'}`)}\n`)
    for (const warning of plan?.warnings ?? [])
      process.stdout.write(`  ${dim('!')} ${warning}\n`)
    if (service !== null)
      process.stdout.write(dim(`the panel is not running, so nothing was reloaded — the next \`${invocation()} up\` reads what was restored\n`))
  }
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
    exclude: { type: 'string', description: 'comma-separated item ids to leave out, applied after --include' },
    all: { type: 'boolean', description: 'act on everything, rather than naming ids' },
    confirm: { type: 'boolean', description: 'apply without asking (a restore writes over live data)' },
    json: { type: 'boolean', description: 'print the plan or the result as JSON' },
  },
  async run({ args }) {
    try {
      const action = args.action === undefined || args.action.length === 0 ? 'list' : args.action
      // Validated up front, before any panel lookup: a bad flag combination is refused whether or
      // not anything is running, which is also what makes it testable without a panel.
      const parsed = action === 'create' || action === 'restore' ? parseScope(args.all === true, args.include) : null
      const exclude = action === 'create' || action === 'restore' ? parseExclude(args.exclude) : undefined
      if (action === 'list') {
        await runBackupList(args.json === true)
      }
      else if (action === 'create') {
        const scope = parsed ?? await refuseWithoutScope('create', '')
        await runBackupCreate({
          password: args.password,
          scope,
          exclude,
          confirm: args.confirm === true,
          json: args.json === true,
        })
      }
      else if (action === 'restore') {
        if (args.target === undefined || args.target.length === 0)
          fail('restore needs the archive name — `backup list` shows them')
        const scope = parsed ?? await refuseWithoutScope('restore', `?name=${encodeURIComponent(args.target)}`)
        await runBackupRestore({
          name: args.target,
          password: args.password,
          scope,
          exclude,
          confirm: args.confirm === true,
          json: args.json === true,
        })
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
