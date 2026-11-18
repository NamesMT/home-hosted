/**
 * The API scopes a credential may hold — the **names only**, with no state around them.
 *
 * This list lives apart from `#src/config/secrets.ts`, which holds the same constant beside the code
 * that hashes, stores and verifies a credential. `src/cli.ts` needs the names to build its help text,
 * and it must not import a **state** module: `#src/helpers/paths.ts` resolves `dataRoot` once at
 * import, so a state import there runs before `applyDirFlags()` and `--home` is silently ignored
 * (`test/cli/isolation.test.ts` is the guard, and it caught exactly this).
 *
 * `secrets.ts` re-exports these, so the guard, the spec and the CLI cannot disagree about the set: a
 * scope added here is one the store accepts, and one the reference lists.
 */

/**
 * What a credential may do.
 *
 * - `read` — every `GET`;
 * - `lifecycle` — start, stop, restart, free-port, clear-logs;
 * - `config` — server, workspace and settings writes, and backups;
 * - `proxy` — the reverse proxy: the engine, its routes and its certificates;
 * - `admin` — everything, including tokens, the password, UI install and restoring secrets.
 */
export const API_TOKEN_SCOPES = ['read', 'lifecycle', 'config', 'proxy', 'admin'] as const
export type ApiTokenScope = typeof API_TOKEN_SCOPES[number]

/**
 * The scopes that cannot be narrowed to particular workspaces.
 *
 * `workspaces` limits a credential to some workspaces, but only for routes that act on one. `admin`
 * (accounts, the password, a UI install) and `proxy` (a panel-wide route table) have no per-workspace
 * meaning, so a person granting either is granting the whole panel. The API reports this so both UIs
 * mark them the same way instead of each deciding for itself — see `scopeCatalogue` in
 * `#src/config/secrets`.
 */
export const PANEL_WIDE_SCOPES = ['proxy', 'admin'] as const satisfies readonly ApiTokenScope[]
