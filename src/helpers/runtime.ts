import process from 'node:process'

/**
 * How to run this CLI again in the same runtime. Under tsx that means passing the
 * resolved loader too, because a spawned child's working directory is the project's,
 * not the package's. Shared by `up` (which re-spawns itself detached) and by the
 * panel (which spawns a persistent entry's nanny).
 *
 * Nothing here reads a state directory, which is why the CLI can import it before
 * `--home`/`--project` have been applied.
 */
export function runtimeArgs(): string[] {
  let resolved: string | null = null
  const resolveTsx = (): string => resolved ??= import.meta.resolve('tsx')

  return process.execArgv.map((arg) => {
    if (arg === 'tsx')
      return resolveTsx()
    if (arg.startsWith('--import=') && arg.slice('--import='.length) === 'tsx')
      return `--import=${resolveTsx()}`
    return arg
  })
}

/**
 * The hidden command a persistent entry runs under. It is spawned by the panel and
 * never typed by a person, so it stays out of the curated CLI surface (help, the
 * unknown-command message, flag refusal) — but the argv has to be one definition,
 * because process identity reads it back: see `providers/identity.ts`.
 */
export const NANNY_COMMAND = '__nanny'

export function nannyArgv(entry: string, id: string, specPath: string, statePath: string): string[] {
  return [...runtimeArgs(), entry, NANNY_COMMAND, '--id', id, '--spec', specPath, '--state', statePath]
}
