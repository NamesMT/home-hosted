import type { Workspace } from '#src/shared/contracts'
import fs from 'node:fs'
import { type } from 'arktype'
import { metaSchema } from '#src/config/schema'
import { writeFileAtomic } from '#src/helpers/atomic'
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

export class WorkspaceError extends Error {
  override name = 'WorkspaceError'
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
    return this.list.find(entry => entry.id === DEFAULT_WORKSPACE_ID)?.id ?? this.list[0]?.id ?? DEFAULT_WORKSPACE_ID
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
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
      throw new WorkspaceError(`workspace "${id}" already exists`)

    const next = [...this.list, validated]
    this.commit(next)
    return validated
  }

  rename(id: string, label: string): Workspace {
    const index = this.list.findIndex(entry => entry.id === id)
    if (index < 0)
      throw new WorkspaceError(`unknown workspace "${id}"`)

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
      throw new WorkspaceError(`unknown workspace "${id}"`)
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
