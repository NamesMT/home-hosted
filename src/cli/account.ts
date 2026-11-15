import type { ControlConfig, ProxyConfig } from '#src/shared/contracts'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation, paint, promptHidden } from '#src/cli/io'
import { accountIdProblem, API_TOKEN_SCOPES, generateAccountSecret } from '#src/config/secrets'
import { EXPOSED_PASSWORD_MIN_LENGTH, passwordLength, WEAK_PASSWORD_LENGTH } from '#src/shared/password-policy'

/**
 * `account` — the panel's credentials, without the API.
 *
 * One account is one credential: it signs in to the panel with `id` + `secret`, and the same pair
 * works as `Authorization: Bearer <id>:<secret>`. That is what replaced `set-password` and
 * `set-token`, which each managed half of a credential that had one authority.
 */

export const accountArgs = {
  command: { type: 'positional', required: false, description: 'create, ls, secret, revoke, disable-auth or reset' },
  id: { type: 'positional', required: false, description: 'the account id' },
  scope: { type: 'string', description: `comma-separated, any of ${API_TOKEN_SCOPES.join(', ')} (default: all)` },
  workspace: { type: 'string', alias: 'w', description: 'limit it to these workspaces (comma-separated)' },
  label: { type: 'string', description: 'a human label, defaults to the id' },
  enable: { type: 'boolean', description: 're-enable a disabled account' },
  disable: { type: 'boolean', description: 'refuse this account\'s credential without deleting it' },
  json: { type: 'boolean', description: 'print one document on stdout' },
} as const

/**
 * What a new secret's length means for this panel: a refusal when the config exposes it beyond
 * loopback (its next start would refuse), a warning below 8 characters, a note below 12.
 */
export async function passwordLengthVerdict(password: string, settings: { control: ControlConfig, proxy: ProxyConfig }): Promise<{ refusal: string | null, warning: string | null }> {
  const length = passwordLength(password)
  if (length >= EXPOSED_PASSWORD_MIN_LENGTH)
    return { refusal: null, warning: null }
  const { checkExposure, checkProxyExposure } = await import('#src/services/exposure')
  // Only `target: "panel"` routes: no ports are passed, so an `external` upstream is not resolved here.
  const exposed = checkExposure(settings.control, true, false, true).blockedReason
    ?? checkProxyExposure(settings.proxy, settings.control.auth.enabled, true, false, [], true)
  if (exposed !== null)
    return { refusal: `${length} characters is too short for this panel — ${exposed}`, warning: null }
  if (length < WEAK_PASSWORD_LENGTH)
    return { refusal: null, warning: `${length} characters is short and easy to guess — and the panel can't listen beyond loopback until the secret has at least ${EXPOSED_PASSWORD_MIN_LENGTH}` }
  return { refusal: null, warning: `fine on this machine, but the panel can't listen beyond loopback until the secret has at least ${EXPOSED_PASSWORD_MIN_LENGTH} characters` }
}

export const accountCommand = defineCommand({
  meta: { name: 'account' },
  args: accountArgs,
  async run({ args }) {
    const command = String(args.command ?? '')
    const id = String(args.id ?? '')
    const { SecretsStore } = await import('#src/config/secrets')
    const { globalSecretsPath: secretsPath } = await import('#src/helpers/paths')
    const store = new SecretsStore(secretsPath, undefined, 'global')
    const scopes = parseScopes(typeof args.scope === 'string' ? args.scope : undefined)
    const workspaces = typeof args.workspace === 'string' && args.workspace.trim().length > 0
      ? args.workspace.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
      : undefined

    if (command === 'ls') {
      const accounts = store.listAccounts()
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({ accounts })}\n`)
        return
      }
      if (accounts.length === 0) {
        process.stdout.write(`no accounts — \`${invocation()} account create admin\`\n`)
        return
      }
      for (const account of accounts) {
        const scope = account.scopes.join(',')
        const limit = account.workspaces === undefined ? 'all workspaces' : account.workspaces.join(',')
        const state = account.enabled ? (account.isDefault ? 'first-run' : 'enabled') : 'disabled'
        process.stdout.write(`${account.id.padEnd(16)} ${account.label.padEnd(20)} ${scope.padEnd(24)} ${dim(`${state} · ${limit}`)}\n`)
      }
      process.stdout.write(`${dim('a secret is shown once, at creation or when it is set — only a hash is kept')}\n`)
      return
    }

    if (command === 'create') {
      if (id.length === 0)
        fail(`which id? \`${invocation()} account create admin --scope read,lifecycle\``)
      const problem = accountIdProblem(id)
      if (problem !== null)
        fail(problem)
      let created: { account: { id: string }, secret: string }
      try {
        created = store.createAccount({
          id,
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
          scopes: (scopes ?? [...API_TOKEN_SCOPES]) as never,
          ...(workspaces === undefined ? {} : { workspaces }),
          ...(process.env.HHOSTED_SECRET === undefined ? {} : { secret: process.env.HHOSTED_SECRET }),
        })
      }
      catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({ id: created.account.id, secret: created.secret })}\n`)
        return
      }
      process.stdout.write(`${green('created')} ${created.account.id} with ${(scopes ?? [...API_TOKEN_SCOPES]).join(', ')}\n`)
      process.stdout.write(`  ${created.secret}\n`)
      process.stdout.write(`${dim('  shown once — only a hash is kept, so copy it now')}\n`)
      process.stdout.write(`${dim(`  sign in as ${created.account.id} with it, or send it as \`Authorization: Bearer ${created.account.id}:<secret>\``)}\n`)
      // The next step names the command *and* this home, so a person running against a project's own
      // state is not pointed at the default one.
      process.stdout.write(`${dim(`  otherwise: \`${invocation()} account secret ${created.account.id}\` to set your own, \`${invocation()} account ls\` to list them`)}\n`)
      return
    }

    if (command === 'secret') {
      if (id.length === 0)
        fail(`which account? \`${invocation()} account secret admin\``)
      if (store.account(id) === null)
        fail(`no account with the id "${id}" — \`${invocation()} account ls\` lists them`)
      const interactive = process.stdin.isTTY === true
      let secret = process.env.HHOSTED_SECRET
      if (secret === undefined && interactive) {
        secret = await promptHidden(`New secret for ${id}: `)
        const again = await promptHidden('Repeat it: ')
        if (secret !== again)
          fail('the secrets do not match')
      }
      if (secret === undefined || secret.length === 0)
        fail('no secret given: run interactively, or set HHOSTED_SECRET for a non-interactive run')

      const { GlobalSettingsStore } = await import('#src/config/settings')
      const settings = new GlobalSettingsStore()
      settings.load({ write: false })
      const verdict = await passwordLengthVerdict(secret, settings)
      if (verdict.refusal !== null)
        fail(verdict.refusal)

      store.setAccountSecret(id, secret)
      process.stdout.write(`${green('secret stored')} for ${id} in ${secretsPath} (mode 0600)\n`)
      if (verdict.warning !== null)
        process.stdout.write(`${paint('33', 'note')} ${verdict.warning}\n`)
      process.stdout.write(`${dim('a running panel picks it up immediately; that account\'s other sessions are signed out')}\n`)
      return
    }

    if (command === 'revoke') {
      if (id.length === 0)
        fail(`which account? \`${invocation()} account revoke admin\``)
      const remaining = store.listAccounts().filter(account => account.id !== id && account.enabled)
      if (remaining.length === 0)
        fail('that is the last account that can sign in — create another first, or the panel would have no way in')
      if (!store.revokeAccount(id))
        fail(`no account with the id "${id}" — \`${invocation()} account ls\` lists them`)
      process.stdout.write(`${green('revoked')} ${id} — its sessions end immediately\n`)
      return
    }

    if (command === 'reset') {
      // The recovery path: a person locked out with no session, on the machine that runs the panel.
      const existing = store.listAccounts()
      const target = id.length > 0 ? id : (existing.find(account => account.enabled)?.id ?? 'default')
      const secret = generateAccountSecret()
      if (store.account(target) === null)
        store.createAccount({ id: target, label: target, scopes: [...API_TOKEN_SCOPES], secret })
      else
        store.setAccountSecret(target, secret)
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({ id: target, secret })}\n`)
        return
      }
      process.stdout.write(`${green('reset')} ${target} — sign in with:\n`)
      process.stdout.write(`  id     ${target}\n`)
      process.stdout.write(`  secret ${secret}\n`)
      process.stdout.write(`${dim('  shown once; change it in Global settings → Accounts after signing in')}\n`)
      return
    }

    if (command === 'disable-auth') {
      const { GlobalSettingsStore } = await import('#src/config/settings')
      const settings = new GlobalSettingsStore()
      settings.load()
      settings.updateControl({ auth: { enabled: false } })
      process.stdout.write(`${green('authentication off')} — the accounts are kept; \`${invocation()} account reset\` restores access\n`)
      return
    }

    fail(`use \`${invocation()} account create|ls|secret|revoke|reset|disable-auth\``)
  },
})

/** The scopes a `--scope` flag names, or `null` for "every scope". */
function parseScopes(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim().length === 0)
    return null
  const wanted = raw.split(',').map(scope => scope.trim()).filter(scope => scope.length > 0)
  const unknown = wanted.filter(scope => !(API_TOKEN_SCOPES as readonly string[]).includes(scope))
  if (unknown.length > 0)
    fail(`unknown scope${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} — expected any of ${API_TOKEN_SCOPES.join(', ')}`)
  return [...new Set(wanted)]
}
