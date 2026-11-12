import process from 'node:process'
import { defineCommand } from 'citty'
import { bold, dim, fail, green, invocation, promptHidden } from '#src/cli/io'
import { generateApiToken, SecretsStore } from '#src/config/secrets'
import { globalSecretsPath as secretsPath } from '#src/helpers/paths'

/** `set-token` sets the bearer credential scripts and agents use. */

/**
 * What the API refuses an API token, and only a signed-in session (or this machine) may do.
 *
 * Every line is a real refusal, each with its own guard in `src/api/`:
 *
 * - `clearing the password` — `DELETE /api/auth/password` (`api/auth/$.routes.ts`): the other way
 *   authentication goes away.
 * - `switching authentication off` — `PATCH /api/settings` (`api/settings.ts`): the cheapest route
 *   to an unauthenticated panel.
 * - `minting or revoking an API token` — `POST`/`DELETE /api/auth/token` (`api/auth/$.routes.ts`):
 *   a token minting its own successor, or destroying its owner's access.
 * - `setting the first password` — `POST /api/auth/password` (`api/auth/$.routes.ts`): the first
 *   password arms the panel and locks every other credential out. Changing an existing one *is*
 *   allowed with `currentPassword`, which is why this says "the first".
 * - `installing a custom UI` — `POST /api/settings/ui` (`api/settings.ts`): a UI is script on the
 *   panel's own origin.
 * - `restoring an archive that carries the panel's own credentials` —
 *   `POST /api/backups/restore` (`api/backups.ts`): that restore would rewrite the very hashes the
 *   token is being recovered from.
 *
 * The wording matches `docs/API.md` and `docs/SECURITY.md` word for word, and
 * `test/cli/set-token.test.ts` fails if either drifts — a note that understates what a token cannot
 * do is read at exactly the moment someone copies a token into a script.
 */
const SESSION_ONLY = [
  'clearing the password',
  'switching authentication off',
  'minting or revoking an API token',
  'setting the first password',
  'installing a custom UI',
  'restoring an archive that carries the panel\'s own credentials',
] as const

export const setTokenArgs = {
  generate: { type: 'boolean', description: 'create a strong token and print it once' },
  clear: { type: 'boolean', description: 'remove the token, so it stops working' },
} as const

/**
 * The panel URL to put in the hint, when no `run.json` names a running panel.
 *
 * The home's own `settings.json` is the only record of where this panel listens — a home configured
 * with `up --port 4123` was shown `http://127.0.0.1:3999`, a URL nothing answers on, in the line a
 * person is told to paste into a script. `null` means the file is there but this release cannot read
 * it; guess 3999 then would be the same bug one hand edit away, so the hint says it does not know.
 *
 * Loaded `{ write: false }` (AGENTS.md, *State*): a command that only looks must not create
 * `settings.json` on a home that has none. A missing file still reads as the seed, so a fresh home
 * gets 3999 without the file appearing.
 */
async function configuredPort(): Promise<number | null> {
  const { GlobalSettingsStore } = await import('#src/config/settings')
  const settings = new GlobalSettingsStore()
  settings.load({ write: false })
  // A file that does not parse, or holds a value this release rejects, is not evidence of a port —
  // the store falls back to the seed, and printing that fallback would be a confident wrong answer.
  if (settings.configError !== null)
    return null
  return settings.control.port
}

export async function runSetToken(generate: boolean, clear: boolean): Promise<void> {
  if (generate && clear)
    fail('use either --generate or --clear, not both')

  const store = new SecretsStore(secretsPath, undefined, 'global')

  if (clear) {
    if (!store.apiTokenSet) {
      process.stdout.write('no API token is set — nothing to clear\n')
      return
    }
    store.clearApiToken()
    process.stdout.write(`${green('API token cleared')} in ${secretsPath} — it stops working immediately\n`)
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
    fail(`no token given: run \`${invocation()} set-token --generate\`, set HHOSTED_TOKEN, or paste one interactively`)
  }

  store.setApiToken(token)
  process.stdout.write(`${green(generate ? 'token generated' : 'token stored')} in ${secretsPath} (mode 0600)\n`)
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
  const port = runtime === null ? await configuredPort() : null
  const base = (runtime?.url ?? (port === null ? null : `http://127.0.0.1:${port}`))?.replace(/\/+$/, '') ?? null

  // Verified only when `run.json` says a panel of *this* home should be there: a port taken from
  // `settings.json` may hold an unrelated program, and this request carries the token.
  if (runtime !== null && base !== null) {
    const verified = await verifyToken(base, token)
    if (verified === true)
      process.stdout.write(`${dim(`verified: ${base}/api/auth/session accepted it`)}\n`)
    else if (verified === false)
      process.stdout.write(`${dim(`the panel at ${base} did not accept it — is it running with this state directory?`)}\n`)
  }

  // With an unreadable settings file there is no honest URL to print: `3999` would be a confident
  // wrong answer in the one line a person pastes into a script, so the port is left as a placeholder.
  const url = base ?? 'http://127.0.0.1:<port>'
  process.stdout.write(`Use it from a script or an agent:\n`)
  process.stdout.write(`  ${bold(`curl -H "Authorization: Bearer ${generate ? token : '<token>'}" ${url}/api/state`)}\n`)
  if (base === null) {
    process.stdout.write(`${dim('  <port> is a placeholder: settings.json cannot be read here, and `home-hosted status` shows the panel\'s real URL')}\n`)
  }
  process.stdout.write(`${dim('It needs no restart and outlives sessions, and it holds the same access as a signed-in browser — except these, which need a signed-in session (`403 SESSION_REQUIRED`):')}\n`)
  for (const item of SESSION_ONLY)
    process.stdout.write(`${dim(`  · ${item}`)}\n`)
  process.stdout.write(`${dim('That keeps a script from locking you out by accident. It is not a boundary against someone holding the token.')}\n`)
  process.stdout.write(`${dim('Changing the password does NOT revoke it: `set-password` drops sessions and leaves the token working. Rotate with this command if it may have leaked.')}\n`)
  process.stdout.write(`${dim(`Remove it any time with: ${invocation()} set-token --clear`)}\n`)
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
  meta: { name: 'set-token' },
  args: setTokenArgs,
  run: async ({ args }) => {
    await runSetToken(args.generate === true, args.clear === true)
  },
})
