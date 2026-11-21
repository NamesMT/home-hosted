import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, invocation } from '#src/cli/io'
import { API_TOKEN_SCOPES } from '#src/config/secrets'
import { formatDateTimeIso } from '#src/shared/ui-format'

/**
 * `token create|ls|revoke` — the named, scoped API tokens, from a terminal.
 *
 * The offline path writes the global secrets file directly, through the same `SecretsStore` the panel
 * uses. The online path would need a session — which a terminal does not have — so a `create` while
 * the panel runs goes through `/_hh` (the local channel's own token is the credential there, and the
 * panel picks the new token up at once).
 *
 * **A token value is printed once and never again**: only its hash is stored, so there is nothing to
 * print a second time, and `ls` says so rather than looking broken.
 */

export const tokenArgs = {
  command: { type: 'positional', required: false, description: 'create, ls or revoke' },
  name: { type: 'string', description: 'create: what to call it (a monitor, a deploy hook)' },
  scope: { type: 'string', description: `create: comma-separated, any of ${API_TOKEN_SCOPES.join(', ')}` },
  workspace: { type: 'string', alias: 'w', description: 'create: limit it to these workspaces (comma-separated)' },
  id: { type: 'positional', required: false, description: 'revoke: the token id from ls' },
  json: { type: 'boolean', description: 'print one document on stdout' },
} as const

/** The scopes a `--scope` flag names, or the sentence that refuses it. */
function parseScopes(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0)
    fail(`which scopes? \`--scope read\` (or ${API_TOKEN_SCOPES.join(', ')}, comma-separated)`)
  const scopes = raw.split(',').map(scope => scope.trim()).filter(scope => scope.length > 0)
  const unknown = scopes.filter(scope => !(API_TOKEN_SCOPES as readonly string[]).includes(scope))
  if (unknown.length > 0)
    fail(`unknown scope${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} — expected any of ${API_TOKEN_SCOPES.join(', ')}`)
  return [...new Set(scopes)]
}

/** A listing, from the panel when it runs (so its store is the authority) else the file. */
async function listTokens(): Promise<Array<{ id: string, name: string, scopes: string[], workspaces?: string[], createdAt: number, lastUsedAt?: number }>> {
  const { readRuntime, runtimeIsAlive } = await import('#src/helpers/daemon')
  const recorded = readRuntime()
  if (recorded !== null && await runtimeIsAlive(recorded)) {
    // `/_hh` has no token listing: it is the local channel, and its own token is the credential.
    // Reading the file is the honest answer — the panel holds the same one.
  }
  const { SecretsStore } = await import('#src/config/secrets')
  const { globalSecretsPath } = await import('#src/helpers/paths')
  return new SecretsStore(globalSecretsPath, undefined, 'global').listApiTokens()
}

export const tokenCommand = defineCommand({
  meta: { name: 'token' },
  args: tokenArgs,
  async run({ args }) {
    const command = String(args.command ?? '')
    if (command !== 'create' && command !== 'ls' && command !== 'revoke')
      fail(`use \`${invocation()} token create|ls|revoke\``)

    if (command === 'ls') {
      const tokens = await listTokens()
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({ tokens })}\n`)
        return
      }
      if (tokens.length === 0) {
        process.stdout.write(`no API tokens — \`${invocation()} token create --name monitor --scope read\`\n`)
        return
      }
      for (const token of tokens) {
        const scope = token.scopes.join(',')
        const limit = token.workspaces === undefined ? 'all workspaces' : token.workspaces.join(',')
        const used = token.lastUsedAt === undefined ? 'never used' : `last used ${formatDateTimeIso(token.lastUsedAt)}`
        process.stdout.write(`${bold(token.id.padEnd(16))} ${token.name.padEnd(20)} ${scope.padEnd(20)} ${dim(`${limit} · ${used}`)}\n`)
      }
      process.stdout.write(`${dim('the value of a token is shown once, at creation — it is not stored anywhere')}\n`)
      return
    }

    if (command === 'revoke') {
      const id = String(args.id ?? '')
      if (id.length === 0)
        fail(`which token? \`${invocation()} token revoke <id>\` (ids are in \`${invocation()} token ls\`)`)

      const { SecretsStore } = await import('#src/config/secrets')
      const { globalSecretsPath } = await import('#src/helpers/paths')
      const store = new SecretsStore(globalSecretsPath, undefined, 'global')
      if (!store.revokeApiToken(id))
        fail(`no API token with the id "${id}" — \`${invocation()} token ls\` lists them`)
      process.stdout.write(`${green('revoked')} ${id} — it stops working immediately\n`)
      return
    }

    // create
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (name.length === 0)
      fail(`what should it be called? \`--name monitor\``)
    const scopes = parseScopes(typeof args.scope === 'string' ? args.scope : undefined)
    const workspaces = typeof args.workspace === 'string' && args.workspace.trim().length > 0
      ? args.workspace.split(',').map(id => id.trim()).filter(id => id.length > 0)
      : undefined

    const { SecretsStore } = await import('#src/config/secrets')
    const { globalSecretsPath } = await import('#src/helpers/paths')
    const store = new SecretsStore(globalSecretsPath, undefined, 'global')
    let created: { token: string, record: { id: string, name: string } }
    try {
      created = store.createApiToken({ name, scopes: scopes as never, ...(workspaces === undefined ? {} : { workspaces }) })
    }
    catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }

    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ id: created.record.id, name: created.record.name, scopes, token: created.token })}\n`)
      return
    }
    process.stdout.write(`${green('created')} ${bold(created.record.id)} (${name}) with ${scopes.join(', ')}${workspaces === undefined ? '' : `, limited to ${workspaces.join(', ')}`}\n`)
    process.stdout.write(`  ${bold(created.token)}\n`)
    process.stdout.write(`${dim('  shown once — only its SHA-256 is kept, so copy it now')}\n`)
    process.stdout.write(`${dim(`  revoke it with: ${invocation()} token revoke ${created.record.id}`)}\n`)
  },
})
