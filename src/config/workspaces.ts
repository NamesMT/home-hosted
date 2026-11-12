import type { Workspace } from '#src/shared/contracts'
import path from 'node:path'
import { type } from 'arktype'
import { parseTolerant } from '#src/config/parse'
import { metaSchema } from '#src/config/schema'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { DEFAULT_WORKSPACE_ID, workspacesPath } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'
import { newWorkspaceIdSchema, workspaceSchema } from '#src/shared/contracts'
import { lazy } from '#src/shared/lazy'
import { isRecord } from '#src/shared/shape'

/**
 * The workspace registry: which workspaces exist, in the order the selector shows
 * them. Kept apart from any workspace's own files so it can be read before they
 * are, and so creating or removing one is a single small write.
 */
export const workspacesFileSchema = lazy(() => type({
  $schema: 'string?',
  meta: metaSchema.optional(),
  workspaces: workspaceSchema.array(),
}).onUndeclaredKey('reject'))

/**
 * Reads a registry from any release: a key this one does not know — at the top or on an entry — is
 * dropped from the result and listed, never a refusal. A newer panel may add one, and an older panel
 * refused to start on its file. Anything else wrong is still `error`.
 */
export function parseWorkspacesFile(raw: unknown): { workspaces: Workspace[] | null, unknownKeys: string[], error: string | null } {
  const unknownKeys: string[] = []
  const parsed = parseTolerant(raw, workspacesFileSchema as unknown as (input: unknown) => unknown, 'workspaces.json', unknownKeys)
  if (parsed.error !== null)
    return { workspaces: null, unknownKeys, error: parsed.error }
  return { workspaces: (parsed.value as typeof workspacesFileSchema.infer).workspaces, unknownKeys, error: null }
}

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
    const { workspaces } = parseWorkspacesFile(JSON.parse(readStateFile(file)) as unknown)
    if (workspaces === null || workspaces.length === 0)
      return DEFAULT_WORKSPACE_ID
    return defaultWorkspaceId(workspaces)
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
 *
 * An **empty** registry is `null` too, for the same reason its sibling falls back to `default`: a
 * registry listing nothing is what a hand-edit or a partially written file looks like, and the panel
 * treats it as `default` rather than as "no workspace exists". Answering `[]` there made `logs <id>`
 * refuse the default workspace that `start` and the panel both serve.
 */
export function readWorkspaceIds(file: string): string[] | null {
  try {
    const { workspaces } = parseWorkspacesFile(JSON.parse(readStateFile(file)) as unknown)
    if (workspaces === null || workspaces.length === 0)
      return null
    return workspaces.map(workspace => workspace.id)
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

const ID_LENGTH = 40
/** Names Windows reserves for devices: no directory can carry one there. */
const RESERVED_IDS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/

/** `My Project AB!` -> `my-project-ab`, and never an empty id, a reserved name or one over 40 characters. */
export function slugifyWorkspaceId(label: string, taken: Iterable<string> = []): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_LENGTH)
  const used = new Set(taken)
  const candidate = base.length > 0 ? base : 'workspace'
  if (!used.has(candidate) && !RESERVED_IDS.test(candidate))
    return candidate
  for (let index = 2; index < 1000; index++) {
    const suffix = `-${index}`
    const next = `${candidate.slice(0, ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!used.has(next))
      return next
  }
  throw new WorkspaceError('could not derive a unique workspace id')
}

export class WorkspaceRegistry {
  private list: Workspace[] = []
  /** The file as last read, so a write keeps the keys a newer release put there. */
  private raw: Record<string, unknown> = {}
  private error: string | null = null
  private warnings: string[] = []
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string = workspacesPath) {}

  get path(): string {
    return this.file
  }

  /** Blocking problems; the caller refuses to start on one, exactly as for configs. */
  get configError(): string | null {
    return this.error
  }

  /** Keys a newer release wrote that this one ignores, and keeps on disk. */
  get configWarnings(): string[] {
    return [...this.warnings]
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

  /** Reads the registry, seeding a missing one; `{ write: false }` holds the seed in memory only. */
  load(options: { write?: boolean } = {}): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(readStateFile(this.file))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (options.write === false) {
          this.list = seed()
          this.error = null
          this.notify()
          return
        }
        this.commit(seed())
        return
      }
      this.error = `cannot read ${this.file}: ${(error as Error).message}`
      return
    }

    const { workspaces, unknownKeys, error } = parseWorkspacesFile(parsed)
    if (workspaces === null) {
      this.error = `${this.file}: ${error}`
      return
    }
    if (workspaces.length === 0) {
      this.error = `${this.file} declares no workspace — at least one is required`
      return
    }

    this.error = null
    this.warnings = unknownKeys.length === 0
      ? []
      : [`${path.basename(this.file)} carries ${unknownKeys.length} unrecognized key(s) this release ignores: ${unknownKeys.join(', ')}`]
    this.raw = parsed as Record<string, unknown>
    this.list = workspaces.map(entry => ({ ...entry }))
    this.notify()
  }

  /**
   * The workspace `create(input)` would register, validated, without writing anything — so the
   * panel can build its directory and runtime first and register it last. A registry entry whose
   * directory could not be made broke every later `up`.
   */
  prepare(input: { id?: string, label?: string }): Workspace {
    const label = (input.label ?? input.id ?? '').trim()
    const id = input.id ?? slugifyWorkspaceId(label, this.list.map(entry => entry.id))

    const checkedId = newWorkspaceIdSchema(id)
    if (checkedId instanceof type.errors)
      throw new WorkspaceError(`id ${checkedId.summary}`)
    const validated = workspaceSchema({ id, label: label.length > 0 ? label : id })
    if (validated instanceof type.errors)
      throw new WorkspaceError(validated.summary)
    if (this.has(id))
      throw new WorkspaceError(`workspace "${id}" already exists`, 'WORKSPACE_EXISTS')
    return validated
  }

  create(input: { id?: string, label?: string }): Workspace {
    const validated = this.prepare(input)
    this.commit([...this.list, validated])
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
    // What a newer release added — a top-level key, or one on an entry that is still here — is
    // written back as it was read.
    const { $schema: _schema, meta: _meta, workspaces: previous, ...extra } = this.raw
    const before = new Map((Array.isArray(previous) ? previous : [])
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.id === 'string')
      .map(entry => [entry.id as string, entry]))
    const stamped = {
      $schema: './workspaces.schema.json',
      meta: { writtenBy: appVersion(), schema: 1 },
      ...extra,
      workspaces: next.map(entry => ({ ...before.get(entry.id), ...entry })),
    }
    writeFileAtomic(this.file, `${JSON.stringify(stamped, null, 2)}\n`)
    this.raw = stamped
    this.list = next.map(entry => ({ ...entry }))
    this.error = null
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
