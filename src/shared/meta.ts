import type { AuthIdentity } from '#src/services/auth'
import type { CredentialKind, CredentialView } from './contracts'

/**
 * Which credential answered, and what each kind is refused — one definition.
 *
 * `GET /api/session` and `GET /api/meta` both have to say which credential is in hand; two
 * derivations of that would drift, and a client that saw one answer agree with the docs and the other
 * disagree would have no way to tell which was authoritative.
 */

/**
 * The actions an **API token** may not take, each because it is a way for a stolen token to end up
 * holding the panel outright rather than merely driving it.
 *
 * Every entry is a refusal that exists in `src/api/` — grep `SESSION_REQUIRED` for each. A token could
 * otherwise `DELETE` then `POST` a fresh password needing no current one (`password.clear`), switch
 * auth off through the cheapest settings patch (`auth.disable`), mint or revoke itself
 * (`token.generate`, `token.revoke`, both `requireSession` in `src/api/auth/$.routes.ts`), set the
 * first password and arm the panel (`password.first`), install a script served on the panel's own
 * origin (`ui.install`), or restore `global:secrets` over the hashes of this very panel
 * (`restore.credentials`).
 *
 * An **API token is full admin** (AGENTS.md): this list is not "less authority", it is the set of
 * moves that would let the token replace the person who owns the panel. Never describe it as less.
 */
const REFUSED_TO_TOKEN: readonly string[] = [
  'password.clear',
  'password.first',
  'auth.disable',
  'token.generate',
  'token.revoke',
  'ui.install',
  'restore.credentials',
]

/**
 * What this credential may not take.
 *
 * A session, and this machine with auth unarmed, are refused none of the above — that is the honest
 * answer, not an oversight: the person at the machine can run `home-hosted account disable-auth` or
 * `home-hosted account create` instead, so listing those as refused would be false for them.
 */
export function credentialRefusals(kind: CredentialKind): string[] {
  return kind === 'token' ? [...REFUSED_TO_TOKEN] : []
}

/**
 * Which credential is in hand.
 *
 * `local` is auth unarmed and a loopback peer: no cookie, no token, admitted only because the caller
 * is this machine. `name` is the readable head of the API token — enough to tell two tokens apart,
 * never enough to use one.
 */
export function credentialOf(identity: AuthIdentity, apiTokenHint: string | null): CredentialView {
  if (identity.method === 'cookie')
    return { kind: 'session' }
  if (identity.method === 'token') {
    // The **name** the token was minted with, which is what tells two tokens apart in a settings
    // page. The readable head is the fallback for a token migrated from the pre-0.14 single one,
    // whose only identity was its own value.
    const name = identity.account?.label ?? apiTokenHint
    return name === null || name === undefined ? { kind: 'token' } : { kind: 'token', name }
  }
  return { kind: 'local' }
}
