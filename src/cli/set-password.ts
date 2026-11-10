import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation, promptHidden } from '#src/cli/io'
import { SecretsStore } from '#src/config/secrets'
import { globalSecretsPath as secretsPath } from '#src/helpers/paths'

/** `set-password` sets the panel password without the API. */

export const setPasswordArgs = {
  clear: { type: 'boolean', description: 'remove the password: nobody can sign in until a new one is set' },
} as const

export async function runSetPassword(clear: boolean): Promise<void> {
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

  store.setPassword(password)
  process.stdout.write(`${green('password stored')} in ${secretsPath} (mode 0600)\n`)
  if (password.length < 8)
    process.stdout.write(`${dim(`${password.length} characters is short — easy to guess if the panel is reachable beyond loopback`)}\n`)
  process.stdout.write(`${dim('a running panel picks it up immediately, and every existing browser session is signed out')}\n`)
}

export const setPasswordCommand = defineCommand({
  meta: { name: 'set-password' },
  args: setPasswordArgs,
  run: async ({ args }) => {
    await runSetPassword(args.clear === true)
  },
})
