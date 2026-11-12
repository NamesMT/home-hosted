import type { ControlConfig, ProxyConfig } from '#src/shared/contracts'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation, paint, promptHidden } from '#src/cli/io'
import { EXPOSED_PASSWORD_MIN_LENGTH, passwordLength, WEAK_PASSWORD_LENGTH } from '#src/shared/password-policy'

/** `set-password` sets the panel password without the API. */

export const setPasswordArgs = {
  clear: { type: 'boolean', description: 'remove the password: nobody can sign in until a new one is set' },
} as const

/**
 * What a new password's length means for this panel: a refusal when the config exposes it beyond
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
    return { refusal: null, warning: `${length} characters is short and easy to guess — and the panel can't listen beyond loopback until the password has at least ${EXPOSED_PASSWORD_MIN_LENGTH}` }
  return { refusal: null, warning: `fine on this machine, but the panel can't listen beyond loopback until the password has at least ${EXPOSED_PASSWORD_MIN_LENGTH} characters` }
}

export async function runSetPassword(clear: boolean): Promise<void> {
  const { SecretsStore } = await import('#src/config/secrets')
  const { globalSecretsPath: secretsPath } = await import('#src/helpers/paths')
  const store = new SecretsStore(secretsPath, undefined, 'global')

  if (clear) {
    store.clearPassword()
    // Authentication stays enabled: with no password nobody can sign in, and only this machine (or
    // an API token) reaches the API until a new one is set. It used to say auth was disabled.
    process.stdout.write(`cleared the control panel password in ${secretsPath}\n`)
    process.stdout.write(`${dim(`nobody can sign in until a new one is set (\`${invocation()} set-password\`); until then only this machine and an API token reach the panel`)}\n`)
    return
  }

  const interactive = process.stdin.isTTY === true
  let password = process.env.HHOSTED_PASSWORD

  if (password === undefined && interactive) {
    password = await promptHidden('New control panel password: ')
    const again = await promptHidden('Repeat it: ')
    if (password !== again)
      fail('the passwords do not match')
  }

  if (password === undefined || password.length === 0) {
    fail('no password given: run interactively, or set HHOSTED_PASSWORD for a non-interactive run')
  }

  // Read-only: a password change must not seed a settings file on a home that has none.
  const { GlobalSettingsStore } = await import('#src/config/settings')
  const settings = new GlobalSettingsStore()
  settings.load({ write: false })
  const verdict = await passwordLengthVerdict(password, settings)
  if (verdict.refusal !== null)
    fail(verdict.refusal)

  store.setPassword(password)
  process.stdout.write(`${green('password stored')} in ${secretsPath} (mode 0600)\n`)
  if (verdict.warning !== null)
    process.stdout.write(`${paint('33', 'note')} ${verdict.warning}\n`)
  process.stdout.write(`${dim('a running panel picks it up immediately, and every existing browser session is signed out')}\n`)
}

export const setPasswordCommand = defineCommand({
  meta: { name: 'set-password' },
  args: setPasswordArgs,
  run: async ({ args }) => {
    await runSetPassword(args.clear === true)
  },
})
