import type { DdnsChallengeRecord, DdnsFetch } from '#src/providers/ddns/types'
import { Buffer } from 'node:buffer'
import { type } from 'arktype'
import { secretEqual } from '#src/helpers/secret-compare'
import { ddnsProvider } from '#src/providers/ddns'
import { normalizeHost } from '#src/providers/ddns/types'

/**
 * The ACMEProxy protocol, which is what Caddy's `dns.providers.acmeproxy` module
 * speaks: it POSTs a name and a value to `present` and again to `cleanup`, and
 * checks that the reply echoes both. The DNS write itself is the panel's, through
 * a workspace account's stored credentials — so the engine never holds them.
 *
 * `libdns/acmeproxy` only ever handles TXT records, and sends the absolute name
 * (`_acme-challenge.git.example.com.`).
 */

/** The request and the reply are the same two fields. */
const proxyMessageSchema = type({
  fqdn: 'string >= 1',
  value: 'string >= 1',
}).onUndeclaredKey('reject')

export interface ChallengeAccount {
  /** The workspace that owns the account, so a write is attributable. */
  workspaceId: string
  /** The account id inside that workspace. */
  accountId: string
  /** The provider that knows how to write the record. */
  provider: string
  credentials: Record<string, string>
}

export interface AcmeChallengeOptions {
  /**
   * The Basic credentials the engine is configured with, read per request so a panel
   * that has DNS-01 switched off writes no credentials file at all. `null` means the
   * feature is off, and every request is refused.
   */
  auth: () => { username: string, password: string } | null
  /** Which account answers for a name, or null when no route claims it. */
  accountFor: (fqdn: string) => ChallengeAccount | null
  fetchImpl?: DdnsFetch
  /** Called after every attempt, so a failure is reportable outside the engine's log. */
  onResult?: (result: { fqdn: string, action: string, ok: boolean, message: string, account: ChallengeAccount | null }) => void
}

function reply(message: { fqdn: string, value: string }, status = 200): Response {
  return new Response(JSON.stringify(message), { status, headers: { 'content-type': 'application/json' } })
}

function failure(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Serves `POST /present` and `POST /cleanup` for the engine. The caller mounts it
 * on a loopback-only path: a route pointing at a name is what decides the account,
 * so an unreachable endpoint is the only thing standing between a stranger and
 * somebody's DNS.
 */
export class AcmeChallengeService {
  constructor(private readonly options: AcmeChallengeOptions) {}

  async handle(request: Request, action: string): Promise<Response> {
    if (action !== 'present' && action !== 'cleanup')
      return failure(404, `unknown action "${action}"`)

    // No credentials means DNS-01 is not switched on. Refusing is the whole point:
    // an absent lock must never read as "no lock", because this endpoint writes
    // records into somebody's zone.
    const auth = this.options.auth()
    if (auth === null)
      return failure(403, 'DNS-01 is not switched on for this panel')
    if (!this.authorized(request, auth))
      return failure(401, 'authentication required')

    let parsed: unknown
    try {
      parsed = await request.json()
    }
    catch {
      return failure(400, 'the body must be JSON')
    }
    const message = proxyMessageSchema(parsed)
    if (message instanceof type.errors)
      return failure(400, 'the body must carry fqdn and value')

    // The engine sends the absolute name; every provider speaks the relative one.
    const fqdn = normalizeHost(message.fqdn)
    const account = this.options.accountFor(fqdn)
    if (account === null)
      return failure(404, `no DNS account answers for ${fqdn}`)

    const provider = ddnsProvider(account.provider)
    if (provider?.challenge === undefined)
      return failure(400, `the "${account.provider}" account cannot write TXT records`)

    const record: DdnsChallengeRecord = { fqdn, value: message.value, action }
    const result = await provider.challenge(record, {
      credentials: account.credentials,
      fetch: this.options.fetchImpl ?? fetch,
    })
    this.options.onResult?.({ fqdn, action, ok: result.ok, message: result.message, account })

    // A failed cleanup must not fail the issuance: the certificate is already in
    // hand, and a leftover TXT record is harmless until it is swept.
    if (!result.ok && action === 'cleanup')
      return reply({ fqdn: message.fqdn, value: message.value })

    if (!result.ok)
      return failure(502, result.message)

    return reply({ fqdn: message.fqdn, value: message.value })
  }

  private authorized(request: Request, auth: { username: string, password: string }): boolean {
    const header = request.headers.get('authorization') ?? ''
    if (!header.toLowerCase().startsWith('basic '))
      return false
    try {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
      const separator = decoded.indexOf(':')
      if (separator < 0)
        return false
      const user = decoded.slice(0, separator)
      const password = decoded.slice(separator + 1)
      // Both compared, without short-circuiting: `&&` skips the password check when the username is
      // wrong, so the two halves cost different work — the opposite of what this comment used to say.
      // The difference is ~90 ns, below loopback jitter, and this endpoint is loopback-only with a
      // generated credential, so it is not a demonstrated leak; computing both costs nothing.
      const userOk = secretEqual(user, auth.username)
      const passwordOk = secretEqual(password, auth.password)
      return userOk && passwordOk
    }
    catch {
      return false
    }
  }
}
