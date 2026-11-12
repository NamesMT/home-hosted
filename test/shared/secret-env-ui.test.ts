import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The secret block shows a **name**, a set marker, and a masked box — never a value.
 *
 * This is the one screen whose whole job is to prove the values are not here. The panel's rule is
 * that a value never enters the config, so the block is built from `secretEnvSet` (names) plus a
 * write-only route; a block that could render a value would be the leak the whole feature exists to
 * prevent.
 *
 * A source scan on both, because a component can only be *mounted* from its own UI's test
 * directory (each UI declares `@` → its own `src`). The behavioural half — the names listed, every
 * input masked and empty, no box for an undeclared name — is
 * `uis/stock/test/secret-env-block.test.ts`.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('the secret block in both UIs', () => {
  it.each([
    ['stock', 'uis/stock/src/components/server/SecretEnvBlock.vue'],
    ['noc-console', 'uis/noc-console/src/components/SecretEnvBlock.vue'],
  ])('%s masks every input and never renders a value', (_name, file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    // A masked input: the only kind this block may have.
    expect(source).toContain('type="password"')
    // The value never comes back from the server, so the block cannot be reading one.
    expect(source).not.toContain('secretEnvValues')
    // It writes through the write-only route, not through the config patch.
    expect(source).toContain('setServerSecrets')
  })
})
