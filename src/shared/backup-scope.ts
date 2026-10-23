import type { BackupScope } from './contracts'

/**
 * What a configured automatic scope asks a `create` for.
 *
 * `only` is `--include` and `except` is `--all --exclude`, because a schedule and a person typing
 * flags have to mean the same thing. An absent scope is the full default the schedule took before
 * it could be configured, which is what keeps an existing config exactly as it was.
 */
export function scopeSelection(scope: BackupScope | undefined): { include?: string[], exclude?: string[] } {
  if (scope === undefined)
    return {}
  return scope.mode === 'only' ? { include: [...scope.ids] } : { exclude: [...scope.ids] }
}

/**
 * What a selection asks for, from `include` and `exclude` together.
 *
 * One implementation for `create`, `restore`, the control channel's plan and both UIs: a second
 * copy of "does this id count as selected" is how an `--exclude` that works on backup silently does
 * nothing on restore, or how a page ticks a row the panel will not capture.
 *
 * `include` omitted means everything; `exclude` is applied after it, and an id under an excluded
 * entry is excluded too.
 */
export function selectionOf(options: { include?: readonly string[], exclude?: readonly string[] }): ((id: string) => boolean) & { isExcluded: (id: string) => boolean } {
  const wanted = options.include === undefined ? null : new Set(options.include)
  const unwanted = new Set(options.exclude ?? [])
  // `global:secrets:password` is under `global:secrets`, and `workspace:x:servers` under
  // `workspace:x`, so an exclusion covers the leaves beneath it as well as the exact id.
  const isExcluded = (id: string): boolean =>
    unwanted.has(id) || [...unwanted].some(entry => id.startsWith(`${entry}:`))
  const selects = ((id: string): boolean => {
    if (isExcluded(id))
      return false
    // Downwards only: naming `a` selects `a:b`, because a coarse id means every leaf under it.
    // It is **not** symmetric — naming `a:b` must not select `a`, or a whole-entry item would
    // replace a file the person asked to touch only one field of.
    return wanted === null || wanted.has(id) || [...wanted].some(entry => id.startsWith(`${entry}:`))
  }) as ((id: string) => boolean) & { isExcluded: (id: string) => boolean }
  selects.isExcluded = isExcluded
  return selects
}

/**
 * Whether a restore selection would write the panel's own credential store.
 *
 * `global:secrets` holds the password hash and the API token hash, so a restore that carries it can
 * replace the credentials of the panel doing the restoring. That is a legitimate move for the owner
 * (a fresh host taking its own archive back) and a panel takeover for anyone holding only a token:
 * measured, a token-only upload restore left the victim's password hash byte-identical to the
 * attacker's, and the owner locked out.
 *
 * The predicate exists so the guard has one definition rather than a string literal at each call
 * site. It answers *whether* the store is touched; who may touch it is the route's decision.
 */
export function selectionWritesCredentials(options: { include?: readonly string[], exclude?: readonly string[] }): boolean {
  const selects = selectionOf(options)
  // The entry itself, any field under it, and the alias older archives may carry — all one file.
  return selects('global:secrets')
    || ['password', 'apiToken', 'telegram', 'ddns'].some(key => selects(`global:secrets:${key}`))
}

/** One entry of the panel's two-level capture tree, with the person's ticks on it. */
export interface ScopeChoice {
  id: string
  selected: boolean
  /** A workspace's leaves, a secrets entry's per-key leaves, or none for a whole-entry item. */
  leaves: ReadonlyArray<{ id: string, selected: boolean }>
}

/** True when the entry contributes anything: one leaf is enough, and a leaf-less entry stands alone. */
function captures(choice: ScopeChoice): boolean {
  return choice.selected && (choice.leaves.length === 0 || choice.leaves.some(leaf => leaf.selected))
}

/** True when the entry contributes everything it has. */
function capturesWhole(choice: ScopeChoice): boolean {
  return choice.selected && (choice.leaves.length === 0 || choice.leaves.every(leaf => leaf.selected))
}

/** The ids the ticks capture: a wholly-ticked entry travels as its own id, a partial one by leaf. */
export function capturedIds(choices: readonly ScopeChoice[]): string[] {
  return choices.flatMap((choice) => {
    if (capturesWhole(choice))
      return [choice.id]
    if (!captures(choice))
      return []
    return choice.leaves.filter(leaf => leaf.selected).map(leaf => leaf.id)
  })
}

/**
 * The ids the ticks leave out — the complement, for writing the scope down as an exclusion.
 *
 * An entry no leaf of which is captured is named whole; a partly ticked one has to be spelled leaf
 * by leaf, because its other leaves are still wanted.
 */
export function excludedIds(choices: readonly ScopeChoice[]): string[] {
  return choices.flatMap((choice) => {
    if (!captures(choice))
      return [choice.id]
    if (capturesWhole(choice))
      return []
    return choice.leaves.filter(leaf => !leaf.selected).map(leaf => leaf.id)
  })
}

/** What a picked tree should be stored as. */
export type ScopeOutcome
  = | { kind: 'everything' }
    | { kind: 'nothing' }
    | { kind: 'scope', scope: BackupScope }

/**
 * The scope a ticked tree describes, in the mode the person chose.
 *
 * A tree with nothing left out is stored as **no scope at all**, whatever the mode: the two capture
 * the same thing today, and only the empty setting also covers a workspace declared tomorrow.
 * Storing the full id list instead would silently narrow every future schedule.
 *
 * `nothing` is refused by the caller rather than sent: an empty `include` reads as "everything" to
 * the API (it is what omitting the key means) and as "nothing" to a person, which is the one
 * reading a backup must never get wrong.
 */
export function scopeOf(choices: readonly ScopeChoice[], mode: BackupScope['mode']): ScopeOutcome {
  // Nothing captured is refused whatever the mode: an `except` list of every id is as empty an
  // archive as an `only` list of none, and the service would refuse the pass for either.
  if (choices.length === 0 || capturedIds(choices).length === 0)
    return { kind: 'nothing' }
  if (excludedIds(choices).length === 0)
    return { kind: 'everything' }
  return { kind: 'scope', scope: { mode, ids: mode === 'only' ? capturedIds(choices) : excludedIds(choices) } }
}

/** One entry of the panel's two-level capture tree, as the id check needs it. */
export interface ScopeEntry {
  id: string
  items?: ReadonlyArray<{ id: string }>
}

/**
 * Which of `ids` name nothing the panel can capture.
 *
 * The rule `backup create --include` already applies: an id names something when it is an entry or
 * leaf id, or a prefix of one (`workspace:default` covers its leaves). A typo matters more on a
 * schedule than anywhere else — nobody is watching — and it cuts both ways: an unknown `only` id
 * silently narrows the archive, an unknown `except` id silently widens it back over what the
 * person meant to leave out.
 */
export function unknownBackupIds(ids: readonly string[], entries: readonly ScopeEntry[]): string[] {
  const available = entries.flatMap(entry => [entry.id, ...(entry.items ?? []).map(item => item.id)])
  const known = (id: string): boolean => available.some(candidate => candidate === id || candidate.startsWith(`${id}:`))
  return ids.filter(id => !known(id))
}

/**
 * Two scopes are the same when they name the same ids the same way.
 *
 * Both UIs diff a freshly built object against the config one, so a reference check reported the
 * scope changed on a save nobody made, and the order the panel wrote the ids in is not part of
 * what it means.
 */
export function sameScope(a: BackupScope | null | undefined, b: BackupScope | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined)
    return (a ?? null) === (b ?? null)
  return a.mode === b.mode && [...a.ids].sort().join('\n') === [...b.ids].sort().join('\n')
}
