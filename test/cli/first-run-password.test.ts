import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { firstRunPasswordState, unrecordedFirstRunHint } from '#src/cli/io'
import { hashPassword } from '#src/config/secrets'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function secretsFile(password: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-first-run-'))
  dirs.push(dir)
  const file = path.join(dir, '.control-secrets.json')
  fs.writeFileSync(file, JSON.stringify({ password, apiToken: null }))
  return file
}

/**
 * A restore can bring back the first-run password's hash and flag without its text, so the panel
 * still runs on it while `up` and `status` had nothing to print — a lockout one forgotten password
 * away. The state is told apart so both can say so.
 */
describe('the first-run password as the CLI reports it', () => {
  it('is recorded while its text is in the secrets file', async () => {
    const file = secretsFile(hashPassword('abcd-efgh-jkmn', { isDefault: true, initial: true }))
    expect(await firstRunPasswordState(file)).toEqual({ kind: 'recorded', password: 'abcd-efgh-jkmn' })
  })

  it('is unrecorded when it is in use but its text is gone', async () => {
    const file = secretsFile(hashPassword('abcd-efgh-jkmn', { isDefault: true }))
    expect(await firstRunPasswordState(file)).toEqual({ kind: 'unrecorded' })
    expect(unrecordedFirstRunHint()).toMatch(/^the first-run password is in use but no longer recorded — run `.+ set-password`$/)
  })

  it('is nothing once the person has set their own', async () => {
    expect(await firstRunPasswordState(secretsFile(hashPassword('my own password')))).toBeNull()
    expect(await firstRunPasswordState(secretsFile(null))).toBeNull()
  })
})
