import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, promptHidden } from '#src/cli/io'
import { generateApiToken, SecretsStore } from '#src/config/secrets'
import { defaultSecretsPath } from '#src/helpers/paths'

/** `set-token` sets the bearer credential scripts and agents use. */

const DEFAULT_PORT = 3999

export const setTokenArgs = {
  generate: { type: 'boolean', description: 'create a strong token and print it once' },
  clear: { type: 'boolean', description: 'remove the token, so it stops working' },
} as const

export async function runSetToken(generate: boolean, clear: boolean): Promise<void> {
  if (generate && clear)
    fail('use either --generate or --clear, not both')

  const store = new SecretsStore(defaultSecretsPath)

  if (clear) {
    if (!store.apiTokenSet) {
      process.stdout.write('no API token is set — nothing to clear\n')
      return
    }
    store.clearApiToken()
    process.stdout.write(`${green('API token cleared')} in ${defaultSecretsPath} — it stops working immediately\n`)
    return
  }

  let token: string | null = process.env.HHOSTED_TOKEN ?? null
  if (generate)
    token = generateApiToken()
  else if (token === null && process.stdin.isTTY === true)
    token = await promptHidden('API token: ')
  if (token !== null)
    token = token.trim()
  if (token === null || token.length === 0) {
    fail('no token given: run `home-hosted set-token --generate`, set HHOSTED_TOKEN, or paste one interactively')
  }

  store.setApiToken(token)
  process.stdout.write(`${green(generate ? 'token generated' : 'token stored')} in ${defaultSecretsPath} (mode 0600)\n`)
  if (generate) {
    process.stdout.write(`  ${bold(token)}\n`)
    process.stdout.write(`${dim('  shown once — only its SHA-256 is kept on disk, so copy it now')}\n`)
  }
  else {
    process.stdout.write(`${dim(`  stored as ${token.slice(0, 8)}… — the file keeps only its hash`)}\n`)
  }

  const { readRuntime } = await import('#src/helpers/daemon')
  // Only the panel that owns *this* state directory is worth asking: guessing a
  // port would probe someone else's panel and call the mismatch a failure.
  const runtime = readRuntime()
  const base = (runtime?.url ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/+$/, '')

  if (runtime !== null) {
    const verified = await verifyToken(base, token)
    if (verified === true)
      process.stdout.write(`${dim(`verified: ${base}/api/auth/session accepted it`)}\n`)
    else if (verified === false)
      process.stdout.write(`${dim(`the panel at ${base} did not accept it — is it running with this state directory?`)}\n`)
  }

  process.stdout.write(`Use it from a script or an agent:\n`)
  process.stdout.write(`  ${bold(`curl -H "Authorization: Bearer ${generate ? token : '<token>'}" ${base}/api/state`)}\n`)
  process.stdout.write(`${dim('It needs no restart, outlives sessions, and holds the same access as a signed-in browser.')}\n`)
  process.stdout.write(`${dim('Remove it any time with: home-hosted set-token --clear')}\n`)
  if (store.usingDefaultPassword)
    process.stdout.write(`${dim('The panel password is still the default — change it before the panel is reachable beyond loopback.')}\n`)
}

/** Asks the live panel whether it accepts the token, without failing when it cannot. */
async function verifyToken(base: string, token: string): Promise<boolean | null> {
  // An https endpoint is usually TLS this project generated itself, which a plain
  // fetch refuses; the liveness probe in `helpers/daemon` is the one that knows how.
  if (!base.startsWith('http://'))
    return null
  try {
    const response = await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok)
      return false
    const body = await response.json() as { authenticated?: boolean }
    return body.authenticated === true
  }
  catch {
    return null
  }
}

export const setTokenCommand = defineCommand({
  meta: { name: 'set-token', description: 'set the API token that scripts and agents use' },
  args: setTokenArgs,
  run: async ({ args }) => {
    await runSetToken(args.generate === true, args.clear === true)
  },
})
