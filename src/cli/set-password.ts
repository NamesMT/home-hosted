import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, promptHidden } from '#src/cli/io'
import { SecretsStore } from '#src/config/secrets'
import { defaultSecretsPath } from '#src/helpers/paths'

/** `set-password` sets the panel password without the API. */

export const setPasswordArgs = {
  clear: { type: 'boolean', description: 'remove the password, which disables authentication' },
} as const

export async function runSetPassword(clear: boolean): Promise<void> {
  const store = new SecretsStore(defaultSecretsPath)

  if (clear) {
    store.clearPassword()
    process.stdout.write(`cleared the control panel password in ${defaultSecretsPath}\n`)
    process.stdout.write(`${dim('authentication stays disabled until you enable it again in the settings page')}\n`)
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
  process.stdout.write(`${green('password stored')} in ${defaultSecretsPath} (mode 0600)\n`)
  if (password.length < 8)
    process.stdout.write(`${dim(`"${password}" is short — easy to guess if the panel is reachable beyond loopback`)}\n`)
  process.stdout.write(`${dim('restart the panel for it to take effect: home-hosted restart')}\n`)
}

export const setPasswordCommand = defineCommand({
  meta: { name: 'set-password', description: 'set the panel password without the API' },
  args: setPasswordArgs,
  run: async ({ args }) => {
    await runSetPassword(args.clear === true)
  },
})
