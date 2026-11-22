/**
 * Accounts: one credential that signs in to the panel *and* authenticates the API.
 *
 * A **request** schema has to enumerate the scopes it accepts, so `apiTokenScopeSchema` is declared here
 * as well as in the store; the store's `API_TOKEN_SCOPES` is the one the guard reads, and
 * `test/shared/contracts.test.ts` pins the two against each other.
 */
import { type } from 'arktype'
import { lazy } from '../lazy'

/**
 * The scopes a token may hold. Declared here as well as in the store, because a **request** schema
 * has to enumerate what it accepts — the store's constant is the one the guard reads.
 *
 * Keep this list in step with `API_TOKEN_SCOPES` (`#src/config/secrets`): a scope missing here is
 * refused by every request that names it, and one missing there is enforced as a permission nobody
 * can hold. `test/shared/contracts.test.ts` pins the two against each other.
 */
export const apiTokenScopeSchema = lazy(() => type.enumerated('read', 'lifecycle', 'config', 'proxy', 'admin'))

/**
 * Signing in takes an **id and a secret**, like a username and a password.
 *
 * Two halves rather than one: the id is not secret, so a blind guess has to get both right, and an
 * attempt budget keyed on the address can refuse one without confirming the other. The lengths are
 * sanity caps, not policy.
 */
export const loginSchema = lazy(() => type({
  id: '1 <= string <= 64',
  secret: '1 <= string <= 512',
}).onUndeclaredKey('reject'))
export type LoginRequest = typeof loginSchema.infer

/** Any non-empty secret is allowed; only a sanity cap on the length. */
export const passwordValueSchema = lazy(() => type('1 <= string <= 512'))

/**
 * Changing **your own** account's secret.
 *
 * `currentSecret` is required unless the account has none, which is why it is optional: the boot
 * first-run account has one, and a caller that could rotate without proving it holds the old secret
 * would make a stolen cookie a permanent takeover.
 */
export const accountSecretSchema = lazy(() => type({
  'currentSecret?': passwordValueSchema,
  'newSecret': passwordValueSchema,
}).onUndeclaredKey('reject'))
export type AccountSecretRequest = typeof accountSecretSchema.infer

/** An account as a listing shows it. Never carries the secret, only metadata. */
export const accountViewSchema = lazy(() => type({
  'id': 'string',
  'label': 'string',
  'scopes': apiTokenScopeSchema.array(),
  'workspaces?': 'string[]',
  'enabled': 'boolean',
  'isDefault': 'boolean',
  /** Its secret is shorter than the exposure bar, so a non-loopback bind stays refused. */
  'short': 'boolean',
  'createdAt': 'number',
  'updatedAt': 'number',
  'lastUsedAt?': 'number',
}).onDeepUndeclaredKey('ignore'))
export type AccountView = typeof accountViewSchema.infer

/**
 * One scope, as the panel understands it.
 *
 * `workspaceLimited` is `false` for a scope a workspace limit cannot narrow (`proxy`, `admin`), so
 * granting it grants the whole panel. The list is **data** rather than something each UI hardcodes:
 * two UIs deriving it separately is how they drift, and the asterisk a person sees has to mean the
 * same thing in both.
 */
export const scopeInfoSchema = lazy(() => type({
  scope: apiTokenScopeSchema,
  workspaceLimited: 'boolean',
}))

export const accountListSchema = lazy(() => type({
  'accounts': accountViewSchema.array(),
  /**
   * The scopes an account may be given, and which of them a workspace limit cannot narrow.
   *
   * Optional so an older panel's answer still parses; a UI that does not find it simply omits the
   * asterisk rather than failing to render the page.
   */
  'scopes?': scopeInfoSchema.array(),
}))

/** One account, for the routes that answer with it alone. */
export const accountIdBodySchema = lazy(() => type({ account: accountViewSchema }))

/**
 * Creating an account: an id a person types, its scopes, and an optional secret.
 *
 * Absent `secret` means the panel generates one and shows it once — which is what a script wants and
 * what needs no policy. A `secret` given here is typed by a person and stretched with scrypt.
 */
export const accountCreateSchema = lazy(() => type({
  'id': '1 <= string <= 64',
  'label?': '1 <= string <= 120',
  'scopes': apiTokenScopeSchema.array(),
  'workspaces?': 'string[]',
  'secret?': passwordValueSchema,
}).onUndeclaredKey('reject'))
export type AccountCreateRequest = typeof accountCreateSchema.infer

/** Editing an account: the fields a settings page may change. Ids are immutable. */
export const accountPatchSchema = lazy(() => type({
  'label?': '1 <= string <= 120',
  'scopes?': apiTokenScopeSchema.array(),
  'workspaces?': type('string[]').or(type('null')),
  'enabled?': 'boolean',
}).onUndeclaredKey('reject'))
export type AccountPatchRequest = typeof accountPatchSchema.infer

/** The create answer: the account, and its secret **once**. */
export const accountCreatedBodySchema = lazy(() => type({
  account: accountViewSchema,
  secret: 'string',
}))
