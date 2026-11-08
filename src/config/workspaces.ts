import type { Workspace } from '#src/shared/contracts'
import { type } from 'arktype'
import { metaSchema } from '#src/config/schema'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { DEFAULT_WORKSPACE_ID, workspacesPath } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'
import { workspaceSchema } from '#src/shared/contracts'

/**
 * The workspace registry: which workspaces exist, in the order the selector shows
 * them. Kept apart from any workspace's own files so it can be read before they
 * are, and so creating or removing one is a single small write.
 */
export const workspacesFileSchema = type({
  $schema: 'string?',
  meta: metaSchema.optional(),
  workspaces: workspaceSchema.array(),
}).onUndeclaredKey('reject')

/**
 * The *kind* of registry failure, when a caller has to branch on it rather than just report it.
 * The workspaces route answers 404 for an unknown id, 409 for a conflict and 400 otherwise, and it
 * decided that by matching the message text.
 */
export type WorkspaceErrorCode = 'UNKNOWN_WORKSPACE' | 'WORKSPACE_EXISTS'

/**
 * The workspace a command acts in when none was named: `default` if the host declares it, else the
 * first one it declares.
 *
 * **The panel already answers this question, and the CLI was answering a different one.** Every
 * workspace-scoped `/api` and `/_hh` route resolves an omitted `?workspace` through
 * `PanelService.requireWorkspace` → `WorkspaceRegistry.defaultId`, i.e. this rule. The two CLI
 * commands that take a workspace id read `DEFAULT_WORKSPACE_ID` literally instead — so on a host
 * whose registry lists one workspace that is not called `default` (a colleague's panel, or one
 * where `default` was removed), `start <id>` reached that workspace while `logs <id>` looked in
 * `.hh/default/.logs/`, a directory that does not exist. Measured: `logs` answered "no output yet"
 * and exited 0 for a log that was on disk, on the one command a diagnostic session starts with.
 *
 * One function, called by every surface that asks, so a third caller cannot re-derive it.
 */
export function defaultWorkspaceId(workspaces: ReadonlyArray<Readonly<{ id: string }>>): string {
  return workspaces.find(entry => entry.id === DEFAULT_WORKSPACE_ID)?.id ?? workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID
}

/**
 * `defaultWorkspaceId`, for a command that has a registry file and no panel.
 *
 * Tolerant for the same reason the panel's own startup guard is the one that refuses a broken
 * registry: a diagnostic command reading one log must not be the thing that fails loudly about a
 * file it only needed one id from. Missing, unparseable or empty falls back to `default`, which is
 * what the seed declares.
 */
export function readDefaultWorkspaceId(file: string): string {
  try {
    const parsed = workspacesFileSchema(JSON.parse(readStateFile(file)) as unknown)
    if (parsed instanceof type.errors || parsed.workspaces.length === 0)
      return DEFAULT_WORKSPACE_ID
    return defaultWorkspaceId(parsed.workspaces)
  }
  catch {
    return DEFAULT_WORKSPACE_ID
  }
}

/**
 * The workspace ids a registry declares — or `null` when it cannot answer.
 *
 * `readDefaultWorkspaceId`'s sibling for a command that must tell "that workspace does not exist"
 * from "I cannot tell": a diagnostic that answers an empty log for a typo'd `--workspace` is the
 * same false answer as one that answers it for a typo'd server id. `null` keeps the caller silent
 * on a registry it could not read, because unreadable is not "it names none".
 */
export function readWorkspaceIds(file: string): string[] | null {
  try {
    const parsed = workspacesFileSchema(JSON.parse(readStateFile(file)) as unknown)
    if (parsed instanceof type.errors)
      return null
    return parsed.workspaces.map(workspace => workspace.id)
  }
  catch {
    return null
  }
}

export class WorkspaceError extends Error {
  override name = 'WorkspaceError'
  readonly code: WorkspaceErrorCode | undefined

  constructor(message: string, code?: WorkspaceErrorCode) {
    super(message)
    this.code = code
  }
}

const seed = (): Workspace[] => [{ id: DEFAULT_WORKSPACE_ID, label: 'Default' }]

/** `My Project AB!` -> `my-project-ab`, and never an empty id. */
export function slugifyWorkspaceId(label: string, taken: Iterable<string> = []): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const used = new Set(taken)
  const candidate = base.length > 0 ? base : 'workspace'
  if (!used.has(candidate))
    return candidate
  for (let index = 2; index < 1000; index++) {
    const next = `${candidate}-${index}`
    if (!used.has(next))
      return next
  }
  throw new WorkspaceError('could not derive a unique workspace id')
}

export class WorkspaceRegistry {
  private list: Workspace[] = []
  private error: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string = workspacesPath) {}

  get path(): string {
    return this.file
  }

  /** Blocking problems; the caller refuses to start on one, exactly as for configs. */
  get configError(): string | null {
    return this.error
  }

  all(): Workspace[] {
    return [...this.list]
  }

  get(id: string): Workspace | undefined {
    return this.list.find(entry => entry.id === id)
  }

  has(id: string): boolean {
    return this.get(id) !== undefined
  }

  /** The id a workspace-scoped request resolves to when none is given. */
  get defaultId(): string {
    return defaultWorkspaceId(this.list)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(readStateFile(this.file))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.commit(seed())
        return
      }
      this.error = `cannot read ${this.file}: ${(error as Error).message}`
      return
    }

    const validated = workspacesFileSchema(parsed)
    if (validated instanceof type.errors) {
      this.error = `${this.file}: ${validated.summary}`
      return
    }
    if (validated.workspaces.length === 0) {
      this.error = `${this.file} declares no workspace — at least one is required`
      return
    }

    this.error = null
    this.list = validated.workspaces.map(entry => ({ ...entry }))
    this.notify()
  }

  create(input: { id?: string, label?: string }): Workspace {
    const label = (input.label ?? input.id ?? '').trim()
    const id = input.id ?? slugifyWorkspaceId(label, this.list.map(entry => entry.id))

    const validated = workspaceSchema({ id, label: label.length > 0 ? label : id })
    if (validated instanceof type.errors)
      throw new WorkspaceError(validated.summary)
    if (this.has(id))
      throw new WorkspaceError(`workspace "${id}" already exists`, 'WORKSPACE_EXISTS')

    const next = [...this.list, validated]
    this.commit(next)
    return validated
  }

  rename(id: string, label: string): Workspace {
    const index = this.list.findIndex(entry => entry.id === id)
    if (index < 0)
      throw new WorkspaceError(`unknown workspace "${id}"`, 'UNKNOWN_WORKSPACE')

    const validated = workspaceSchema({ id, label: label.trim() })
    if (validated instanceof type.errors)
      throw new WorkspaceError(validated.summary)

    const next = [...this.list]
    next[index] = validated
    this.commit(next)
    return validated
  }

  remove(id: string): Workspace {
    const entry = this.get(id)
    if (entry === undefined)
      throw new WorkspaceError(`unknown workspace "${id}"`, 'UNKNOWN_WORKSPACE')
    if (this.list.length <= 1)
      throw new WorkspaceError('cannot remove the only workspace')

    this.commit(this.list.filter(candidate => candidate.id !== id))
    return entry
  }

  private commit(next: Workspace[]): void {
    const stamped = {
      $schema: './workspaces.schema.json',
      meta: { writtenBy: appVersion(), schema: 1 },
      workspaces: next,
    }
    writeFileAtomic(this.file, `${JSON.stringify(stamped, null, 2)}\n`)
    this.list = next.map(entry => ({ ...entry }))
    this.error = null
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
